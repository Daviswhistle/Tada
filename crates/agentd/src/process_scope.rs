//! Platform lifecycle boundaries for the fixed probe, not a filesystem sandbox.
use std::io;
use tokio::process::{Child, Command};

#[cfg(target_os="linux")]
mod imp {
    use super::*;
    use std::os::unix::process::CommandExt;
    pub struct Scope;
    impl Scope {
        pub fn prepare(command: &mut Command) -> io::Result<Self> {
            let parent = std::process::id() as libc::pid_t;
            command.as_std_mut().process_group(0);
            // SAFETY: executed between fork/exec; only raw OS calls and errno
            // conversion, no allocation, environment access, formatting or locks.
            unsafe {
                command.as_std_mut().pre_exec(move || {
                    if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                        return Err(io::Error::last_os_error());
                    }
                    if libc::getppid() != parent {
                        return Err(io::Error::from_raw_os_error(libc::ESRCH));
                    }
                    let limit = libc::rlimit { rlim_cur:0, rlim_max:0 };
                    if libc::setrlimit(libc::RLIMIT_CORE,&limit) != 0 {
                        return Err(io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
            Ok(Self)
        }
        pub fn attach(&self, _: &Child) -> io::Result<()> { Ok(()) }
        pub fn terminate(&self, child: &mut Child) -> io::Result<()> {
            if child.try_wait()?.is_none() { child.start_kill()?; }
            Ok(())
        }
        pub fn empty(&self) -> io::Result<bool> { Ok(true) }
    }
}
#[cfg(windows)]
mod imp {
    use super::*;
    use std::{mem::{size_of,zeroed}, os::windows::io::{AsRawHandle,FromRawHandle,OwnedHandle},ptr};
    use windows_sys::Win32::{Foundation::HANDLE,System::JobObjects::{
        CreateJobObjectW, SetInformationJobObject, AssignProcessToJobObject,
        TerminateJobObject, QueryInformationJobObject, JobObjectExtendedLimitInformation,
        JobObjectBasicAccountingInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
    }};
    pub struct Scope(OwnedHandle);
    impl Scope {
        pub fn prepare(_: &mut Command) -> io::Result<Self> {
            // SAFETY: unnamed, non-inheritable job; ownership is transferred to
            // OwnedHandle exactly once. Limits are applied before any assignment.
            let raw = unsafe { CreateJobObjectW(ptr::null(),ptr::null()) };
            if raw.is_null() { return Err(io::Error::last_os_error()); }
            let job = Self(unsafe { OwnedHandle::from_raw_handle(raw) });
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
            limits.BasicLimitInformation.ActiveProcessLimit = 1;
            if unsafe { SetInformationJobObject(job.handle(),JobObjectExtendedLimitInformation,&limits as *const _ as *const _,size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(job)
        }
        fn handle(&self) -> HANDLE { self.0.as_raw_handle() }
        pub fn attach(&self, child: &Child) -> io::Result<()> {
            let process = child.raw_handle().ok_or_else(|| io::Error::from_raw_os_error(6))?;
            // The trusted worker waits for stdin EOF. No input is delivered
            // before attachment; nested-job failure kills/reaps it and aborts.
            if unsafe { AssignProcessToJobObject(self.handle(),process) } == 0 { return Err(io::Error::last_os_error()); }
            Ok(())
        }
        pub fn terminate(&self, child: &mut Child) -> io::Result<()> {
            let result = unsafe { TerminateJobObject(self.handle(),1) };
            if child.try_wait()?.is_none() { child.start_kill()?; }
            if result == 0 { return Err(io::Error::last_os_error()); }
            Ok(())
        }
        pub fn empty(&self) -> io::Result<bool> {
            let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { zeroed() };
            if unsafe { QueryInformationJobObject(self.handle(),JobObjectBasicAccountingInformation,&mut info as *mut _ as *mut _,size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,ptr::null_mut()) } == 0 { return Err(io::Error::last_os_error()); }
            Ok(info.ActiveProcesses == 0)
        }
    }
}
#[cfg(not(any(windows,target_os="linux")))]
mod imp {
    use super::*;
    pub struct Scope;
    impl Scope {
        pub fn prepare(_: &mut Command) -> io::Result<Self> { Err(io::Error::from(io::ErrorKind::Unsupported)) }
        pub fn attach(&self, _: &Child) -> io::Result<()> { Err(io::Error::from(io::ErrorKind::Unsupported)) }
        pub fn terminate(&self, _: &mut Child) -> io::Result<()> { Err(io::Error::from(io::ErrorKind::Unsupported)) }
        pub fn empty(&self) -> io::Result<bool> { Err(io::Error::from(io::ErrorKind::Unsupported)) }
    }
}
pub(crate) use imp::Scope;
