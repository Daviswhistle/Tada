//! Windows local-only pipes: explicit user SID DACL, first-instance ownership,
//! peer process token checks, and identification-only client impersonation.
use crate::{Error, Result, Stream};
use std::{ffi::c_void, mem::size_of, os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle}, path::Path, ptr::{null, null_mut}, time::Duration};
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeServer, PipeMode, ServerOptions};
use windows_sys::Win32::{
    Foundation::{ERROR_INSUFFICIENT_BUFFER, ERROR_PIPE_BUSY, GetLastError, HANDLE, LocalFree},
    Security::{GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER, SECURITY_ATTRIBUTES},
    Security::Authorization::{ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW},
    Storage::FileSystem::SECURITY_IDENTIFICATION,
    System::Pipes::{GetNamedPipeClientProcessId, GetNamedPipeServerProcessId},
    System::Threading::{GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION},
};

const PREFIX: &str = "\\\\.\\pipe\\Tada-core04-";
struct LocalMemory(*mut c_void);
impl Drop for LocalMemory {
    fn drop(&mut self) {
        // SAFETY: pointers originate from the LocalAlloc-family Win32 APIs below.
        unsafe { LocalFree(self.0); }
    }
}
fn last_error() -> Error { Error::Io(std::io::Error::last_os_error()) }
fn sid_string(sid: *mut c_void) -> Result<String> {
    let mut string = null_mut();
    // SAFETY: sid points to a TOKEN_USER/ACE held alive by the caller. Win32
    // allocates a null-terminated SID string, released with LocalFree.
    unsafe {
        if ConvertSidToStringSidW(sid, &mut string) == 0 { return Err(last_error()); }
        let _owned = LocalMemory(string.cast());
        let mut length = 0;
        while length < 184 && *string.add(length) != 0 { length += 1; }
        if length == 184 { return Err(Error::PeerRejected); }
        String::from_utf16(std::slice::from_raw_parts(string, length)).map_err(|_| Error::PeerRejected)
    }
}
fn process_sid(process: HANDLE) -> Result<String> {
    let mut raw = null_mut();
    // SAFETY: process is a live borrowed process handle or current-process
    // pseudo handle. The token is uniquely owned after OpenProcessToken.
    unsafe {
        if OpenProcessToken(process, TOKEN_QUERY, &mut raw) == 0 { return Err(last_error()); }
        let token = OwnedHandle::from_raw_handle(raw);
        let mut needed = 0;
        if GetTokenInformation(token.as_raw_handle(), TokenUser, null_mut(), 0, &mut needed) != 0 || GetLastError() != ERROR_INSUFFICIENT_BUFFER || needed == 0 || needed > 65_536 { return Err(Error::PeerRejected); }
        // usize storage gives TOKEN_USER its required pointer alignment.
        let mut buffer = vec![0usize; (needed as usize).div_ceil(size_of::<usize>())];
        let capacity = (buffer.len() * size_of::<usize>()) as u32;
        if GetTokenInformation(token.as_raw_handle(), TokenUser, buffer.as_mut_ptr().cast(), capacity, &mut needed) == 0 { return Err(last_error()); }
        let user = &*buffer.as_ptr().cast::<TOKEN_USER>();
        sid_string(user.User.Sid)
    }
}
fn current_sid() -> Result<String> {
    // SAFETY: GetCurrentProcess returns a borrowed pseudo handle; never close it.
    process_sid(unsafe { GetCurrentProcess() })
}
fn verify_process(pid: u32, own_sid: &str, expected_pid: Option<u32>) -> Result<()> {
    if pid == 0 || expected_pid.is_some_and(|expected| expected != pid) { return Err(Error::PeerRejected); }
    // SAFETY: query-only, noninheritable handle to the kernel-reported pipe peer.
    // Failure to inspect the peer is rejection, never an authentication fallback.
    unsafe {
        let raw = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if raw.is_null() { return Err(Error::PeerRejected); }
        let process = OwnedHandle::from_raw_handle(raw);
        if process_sid(process.as_raw_handle()).map_err(|_| Error::PeerRejected)? != own_sid { return Err(Error::PeerRejected); }
    }
    Ok(())
}
fn security(sid: &str) -> Result<LocalMemory> {
    // sid is returned by Windows, never interpolated from an RPC field.
    let sddl: Vec<u16> = format!("O:{sid}D:P(A;;GA;;;{sid})").encode_utf16().chain(Some(0)).collect();
    let mut descriptor = null_mut();
    // SAFETY: null-terminated SDDL and valid output pointer. Descriptor remains
    // alive for CreateNamedPipe and is freed exactly once after the call.
    unsafe {
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), 1, &mut descriptor, null_mut()) == 0 { return Err(last_error()); }
    }
    Ok(LocalMemory(descriptor))
}
fn new_pipe(address: &str, sid: &str, first: bool) -> Result<NamedPipeServer> {
    let descriptor = security(sid)?;
    let mut attributes = SECURITY_ATTRIBUTES { nLength: size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: descriptor.0, bInheritHandle: 0 };
    // Always set remote rejection after pipe_mode. Keep one pending instance
    // alive before handing an accepted instance to a connection task.
    let mut options = ServerOptions::new();
    options.pipe_mode(PipeMode::Byte).reject_remote_clients(true).first_pipe_instance(first).max_instances(34).in_buffer_size(4096).out_buffer_size(4096);
    // SAFETY: attributes and its security descriptor are valid for this call;
    // Windows copies the descriptor when creating the noninheritable pipe.
    Ok(unsafe { options.create_with_security_attributes_raw(address, (&mut attributes as *mut SECURITY_ATTRIBUTES).cast()) }?)
}
fn valid_address(address: &str) -> bool {
    address.strip_prefix(PREFIX).is_some_and(|id| id.len()==32 && id.bytes().all(|b| b.is_ascii_hexdigit()))
}

pub struct Listener { pending: NamedPipeServer, address: String, sid: String }
impl Listener {
    pub fn bind(_runtime_dir: &Path, instance: &str) -> Result<Self> {
        let address = format!("{PREFIX}{instance}");
        if !valid_address(&address) { return Err(Error::InvalidEndpoint); }
        let sid = current_sid()?;
        let pending = new_pipe(&address, &sid, true)?;
        Ok(Self { pending, address, sid })
    }
    pub fn address(&self) -> &str { &self.address }
    pub(crate) async fn accept(&mut self) -> Result<Stream> {
        self.pending.connect().await?;
        let next = new_pipe(&self.address, &self.sid, false)?;
        let accepted = std::mem::replace(&mut self.pending, next);
        let mut pid = 0;
        // SAFETY: accepted owns a connected pipe and pid is a valid output.
        if unsafe { GetNamedPipeClientProcessId(accepted.as_raw_handle(), &mut pid) } == 0 { return Err(Error::PeerRejected); }
        verify_process(pid, &self.sid, None)?;
        Ok(Box::new(accepted))
    }
}
pub(crate) async fn connect(address: &str, expected_pid: u32) -> Result<Stream> {
    if !valid_address(address) { return Err(Error::InvalidEndpoint); }
    let client = loop {
        // Do not let even a fake pipe server impersonate this client to perform
        // operations. ClientOptions adds SECURITY_SQOS_PRESENT automatically.
        match ClientOptions::new().security_qos_flags(SECURITY_IDENTIFICATION).open(address) {
            Ok(client) => break client,
            Err(error) if error.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) => tokio::time::sleep(Duration::from_millis(5)).await,
            Err(error) => return Err(error.into()),
        }
    };
    let mut pid = 0;
    // SAFETY: client owns an open pipe and pid is a valid output location.
    if unsafe { GetNamedPipeServerProcessId(client.as_raw_handle(), &mut pid) } == 0 { return Err(Error::PeerRejected); }
    verify_process(pid, &current_sid()?, Some(expected_pid))?;
    Ok(Box::new(client))
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::Security::{ACL, ACCESS_ALLOWED_ACE, GetAce, GetSecurityDescriptorDacl};
    #[test]
    fn explicit_descriptor_has_one_user_allow_ace_and_no_default_world_acl() {
        let sid = current_sid().unwrap(); let sd = security(&sid).unwrap();
        let mut present=0; let mut defaulted=0; let mut acl: *mut ACL = null_mut();
        // SAFETY: inspect the live descriptor allocated by Windows above.
        unsafe {
            assert_ne!(GetSecurityDescriptorDacl(sd.0,&mut present,&mut acl,&mut defaulted),0);
            assert_ne!(present,0); assert!(!acl.is_null()); assert_eq!((*acl).AceCount,1);
            let mut ace=null_mut(); assert_ne!(GetAce(acl,0,&mut ace),0);
            let ace=&*(ace.cast::<ACCESS_ALLOWED_ACE>());
            assert_eq!(ace.Header.AceType,0);
            assert_eq!(sid_string((&ace.SidStart as *const u32).cast_mut().cast()).unwrap(),sid);
        }
    }
    #[tokio::test]
    async fn first_instance_rejects_squatting_and_namespace_is_local_only() {
        let id=crate::tests::nonce(); let first=Listener::bind(Path::new("unused"),&id).unwrap();
        assert!(Listener::bind(Path::new("unused"),&id).is_err());
        assert!(!valid_address("\\\\remote-host\\pipe\\Tada-core04-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
        assert!(!valid_address("\\\\.\\pipe\\Tada-core04-../escape"));
        drop(first); assert!(Listener::bind(Path::new("unused"),&id).is_ok());
    }
    #[test]
    fn peer_token_sid_and_trusted_pid_are_required() {
        verify_process(std::process::id(),&current_sid().unwrap(),Some(std::process::id())).unwrap();
        assert!(verify_process(std::process::id(),"S-1-0-0",None).is_err());
        assert!(verify_process(std::process::id(),&current_sid().unwrap(),Some(0)).is_err());
    }
}
