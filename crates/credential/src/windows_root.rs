//! Windows private metadata roots. Reject reparse points and foreign ACLs;
//! opening directories/lock files without DELETE sharing pins their names.
use crate::{Error, Result};
use std::{
    ffi::c_void,
    fs::{File, OpenOptions},
    mem::{size_of, zeroed},
    os::windows::{
        ffi::OsStrExt,
        fs::OpenOptionsExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::Path,
    ptr::null_mut,
};
use windows_sys::Win32::{
    Foundation::{GetLastError, LocalFree, ERROR_INSUFFICIENT_BUFFER},
    Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        GetSecurityInfo, SE_FILE_OBJECT,
    },
    Security::{
        GetAce, GetTokenInformation, TokenOwner, TokenUser, ACCESS_ALLOWED_ACE,
        DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, SECURITY_ATTRIBUTES, TOKEN_OWNER,
        TOKEN_QUERY, TOKEN_USER,
    },
    Storage::FileSystem::{
        CreateDirectoryW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE,
    },
    System::Threading::{GetCurrentProcess, OpenProcessToken},
};
struct Local(*mut c_void);
impl Drop for Local {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}
fn wide(path: &Path) -> Result<Vec<u16>> {
    let mut text: Vec<u16> = path.as_os_str().encode_wide().collect();
    if text.contains(&0) {
        return Err(Error::UnsafePath);
    }
    text.push(0);
    Ok(text)
}
fn sid_text(sid: *mut c_void) -> Result<String> {
    let mut raw = null_mut();
    // SAFETY: input SID comes from a live token or GetSecurityInfo descriptor.
    unsafe {
        if ConvertSidToStringSidW(sid, &mut raw) == 0 {
            return Err(Error::UnsafePath);
        }
        let _memory = Local(raw.cast());
        let mut n = 0;
        while n < 184 && *raw.add(n) != 0 {
            n += 1;
        }
        if n == 184 {
            return Err(Error::UnsafePath);
        }
        String::from_utf16(std::slice::from_raw_parts(raw, n)).map_err(|_| Error::UnsafePath)
    }
}
fn own_sid() -> Result<String> {
    token_sid(false)
}
fn token_sid(default_owner: bool) -> Result<String> {
    let class = if default_owner { TokenOwner } else { TokenUser };
    let mut raw = null_mut();
    // SAFETY: current-process pseudo handle is borrowed; token owns its handle.
    unsafe {
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) == 0 {
            return Err(Error::UnsafePath);
        }
        let token = OwnedHandle::from_raw_handle(raw);
        let mut needed = 0;
        if GetTokenInformation(token.as_raw_handle(), class, null_mut(), 0, &mut needed) != 0
            || GetLastError() != ERROR_INSUFFICIENT_BUFFER
            || needed == 0
            || needed > 65_536
        {
            return Err(Error::UnsafePath);
        }
        let mut storage = vec![0usize; (needed as usize).div_ceil(size_of::<usize>())];
        if GetTokenInformation(
            token.as_raw_handle(),
            class,
            storage.as_mut_ptr().cast(),
            (storage.len() * size_of::<usize>()) as u32,
            &mut needed,
        ) == 0
        {
            return Err(Error::UnsafePath);
        }
        if default_owner {
            sid_text((*storage.as_ptr().cast::<TOKEN_OWNER>()).Owner)
        } else {
            sid_text((*storage.as_ptr().cast::<TOKEN_USER>()).User.Sid)
        }
    }
}
fn private_acl(file: &File, require_user_owner: bool) -> Result<()> {
    let mut owner = null_mut();
    let mut dacl = null_mut();
    let mut raw = null_mut();
    let sid = own_sid()?;
    // SAFETY: live file handle and valid output pointers. Returned security
    // descriptor owns SID/ACL pointers until LocalFree at function exit.
    unsafe {
        if GetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            &mut dacl,
            null_mut(),
            &mut raw,
        ) != 0
        {
            return Err(Error::UnsafePath);
        }
        let _memory = Local(raw);
        if owner.is_null() || dacl.is_null() || (*dacl).AceCount != 1 {
            return Err(Error::UnsafePath);
        }
        // Windows applies TOKEN_OWNER, not necessarily TOKEN_USER, to new
        // lock/SQLite files. The root is explicitly user-owned. Child files
        // may have exactly our current token's default owner; the DACL below
        // must still contain exactly one full-access ACE for our user SID.
        let actual_owner = sid_text(owner)?;
        if actual_owner != sid && (require_user_owner || actual_owner != token_sid(true)?) {
            return Err(Error::UnsafePath);
        }
        let mut ace = null_mut();
        if GetAce(dacl, 0, &mut ace) == 0 {
            return Err(Error::UnsafePath);
        }
        let allow = &*ace.cast::<ACCESS_ALLOWED_ACE>();
        if allow.Header.AceType != 0
            || sid_text((&allow.SidStart as *const u32).cast_mut().cast())? != sid
            || allow.Mask != 0x001f01ff
        {
            return Err(Error::UnsafePath);
        }
    }
    Ok(())
}
pub fn create(path: &Path) -> Result<()> {
    let sid = own_sid()?;
    let sddl: Vec<u16> = format!("O:{sid}D:P(A;OICI;FA;;;{sid})")
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut raw = null_mut();
    let path = wide(path)?;
    // SAFETY: descriptor and SECURITY_ATTRIBUTES stay alive through creation;
    // Windows copies the protected inheritable user-only DACL to the new directory.
    unsafe {
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut raw,
            null_mut(),
        ) == 0
        {
            return Err(Error::UnsafePath);
        }
        let _memory = Local(raw);
        let attr = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: raw,
            bInheritHandle: 0,
        };
        if CreateDirectoryW(path.as_ptr(), &attr) == 0 {
            return Err(Error::Io);
        }
    }
    Ok(())
}
pub fn open_dir(path: &Path) -> Result<File> {
    Ok(OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?)
}
fn info(file: &File) -> Result<BY_HANDLE_FILE_INFORMATION> {
    // SAFETY: zero-initialized plain Win32 output structure and a live file handle.
    let mut info = unsafe { zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(Error::UnsafePath);
    }
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(Error::UnsafePath);
    }
    Ok(info)
}
pub fn check_dir(path: &Path, file: &File) -> Result<()> {
    let held = info(file)?;
    let named = open_dir(path)?;
    let current = info(&named)?;
    if held.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
        || (
            held.dwVolumeSerialNumber,
            held.nFileIndexHigh,
            held.nFileIndexLow,
        ) != (
            current.dwVolumeSerialNumber,
            current.nFileIndexHigh,
            current.nFileIndexLow,
        )
    {
        return Err(Error::UnsafePath);
    }
    private_acl(file, true)
}
pub fn open_file(path: &Path, create: bool) -> Result<File> {
    Ok(OpenOptions::new()
        .read(true)
        .write(true)
        .create(create)
        .truncate(false)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?)
}
pub fn check_file(file: &File) -> Result<()> {
    let i = info(file)?;
    if i.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0 || i.nNumberOfLinks != 1 {
        return Err(Error::UnsafePath);
    }
    private_acl(file, false)
}
// SQLite FULL supplies its documented transaction durability. Windows does not
// expose a portable Rust directory-fsync equivalent; do not claim power-cut proof.
pub fn sync(_: &File) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_child_inherits_user_only_access_with_native_default_owner() {
        let temp = crate::tests::Temp::new();
        let root = temp.id();
        create(&root).unwrap();
        let directory = open_dir(&root).unwrap();
        check_dir(&root, &directory).unwrap();
        let file = open_file(&root.join("identity.lock"), true).unwrap();
        check_file(&file).unwrap();
        let mut owner = null_mut();
        let mut descriptor = null_mut();
        // SAFETY: live handle and output pointers; owner borrows descriptor.
        let actual = unsafe {
            assert_eq!(
                GetSecurityInfo(
                    file.as_raw_handle(),
                    SE_FILE_OBJECT,
                    OWNER_SECURITY_INFORMATION,
                    &mut owner,
                    null_mut(),
                    null_mut(),
                    null_mut(),
                    &mut descriptor
                ),
                0
            );
            let _owned = Local(descriptor);
            sid_text(owner).unwrap()
        };
        let user = own_sid().unwrap();
        let default_owner = token_sid(true).unwrap();
        assert_eq!(actual, default_owner);
        if user != default_owner {
            assert!(
                private_acl(&file, true).is_err(),
                "old user-only owner check must reproduce the failure"
            );
        }
        println!("Windows file owner matches TOKEN_OWNER: true; TOKEN_OWNER differs from TOKEN_USER: {}; exact user-only DACL: passed", user != default_owner);
    }

    #[test]
    fn unprotected_existing_root_is_rejected_without_repairing_its_acl() {
        let temp = crate::tests::Temp::new();
        let directory = open_dir(&temp.0).unwrap();
        assert!(check_dir(&temp.0, &directory).is_err());
        assert!(check_dir(&temp.0, &directory).is_err());
        // Creation of a separate protected root still works under this token.
        create(&temp.id()).unwrap();
        check_dir(&temp.id(), &open_dir(&temp.id()).unwrap()).unwrap();
    }
}
