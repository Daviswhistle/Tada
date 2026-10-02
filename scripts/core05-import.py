"""Correct Windows default-owner handling without widening the user-only DACL."""
from pathlib import Path
p = Path('crates/credential/src/windows_root.rs')
s = p.read_text()
def replace(old, new):
    global s
    assert s.count(old) == 1, old
    s = s.replace(old, new)
replace('GetAce, GetTokenInformation, TokenUser, ACCESS_ALLOWED_ACE, DACL_SECURITY_INFORMATION,', 'GetAce, GetTokenInformation, TokenOwner, TokenUser, ACCESS_ALLOWED_ACE, DACL_SECURITY_INFORMATION,')
replace('OWNER_SECURITY_INFORMATION, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,', 'OWNER_SECURITY_INFORMATION, SECURITY_ATTRIBUTES, TOKEN_OWNER, TOKEN_QUERY, TOKEN_USER,')
replace('fn own_sid() -> Result<String> {\n    let mut raw', '''fn own_sid() -> Result<String> {
    token_sid(false)
}
fn token_sid(default_owner: bool) -> Result<String> {
    let class = if default_owner { TokenOwner } else { TokenUser };
    let mut raw''')
replace('GetTokenInformation(token.as_raw_handle(), TokenUser, null_mut(), 0, &mut needed)', 'GetTokenInformation(token.as_raw_handle(), class, null_mut(), 0, &mut needed)')
replace('            TokenUser,\n            storage.as_mut_ptr()', '            class,\n            storage.as_mut_ptr()')
replace('        sid_text((*storage.as_ptr().cast::<TOKEN_USER>()).User.Sid)', '''        if default_owner {
            sid_text((*storage.as_ptr().cast::<TOKEN_OWNER>()).Owner)
        } else {
            sid_text((*storage.as_ptr().cast::<TOKEN_USER>()).User.Sid)
        }''')
replace('fn private_acl(file: &File) -> Result<()> {', 'fn private_acl(file: &File, require_user_owner: bool) -> Result<()> {')
replace('        if owner.is_null() || sid_text(owner)? != sid || dacl.is_null() || (*dacl).AceCount != 1 {', '        if owner.is_null() || dacl.is_null() || (*dacl).AceCount != 1 {')
replace('        let mut ace = null_mut();', '''        // Windows applies TOKEN_OWNER, not necessarily TOKEN_USER, to new
        // lock/SQLite files. The root is explicitly user-owned. Child files
        // may have exactly our current token's default owner; the DACL below
        // must still contain exactly one full-access ACE for our user SID.
        let actual_owner = sid_text(owner)?;
        if actual_owner != sid && (require_user_owner || actual_owner != token_sid(true)?) {
            return Err(Error::UnsafePath);
        }
        let mut ace = null_mut();''')
replace('    private_acl(file)\n}\npub fn open_file', '    private_acl(file, true)\n}\npub fn open_file')
replace('    private_acl(file)\n}\n// SQLite', '    private_acl(file, false)\n}\n// SQLite')
s += '''
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
            assert_eq!(GetSecurityInfo(file.as_raw_handle(), SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION, &mut owner, null_mut(), null_mut(),
                null_mut(), &mut descriptor), 0);
            let _owned = Local(descriptor);
            sid_text(owner).unwrap()
        };
        let user = own_sid().unwrap();
        let default_owner = token_sid(true).unwrap();
        assert_eq!(actual, default_owner);
        if user != default_owner {
            assert!(private_acl(&file, true).is_err(), "old user-only owner check must reproduce the failure");
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
'''
p.write_text(s)
p = Path('docs/installation-identity.md')
s = p.read_text()
old = 'Windows creates an explicit user-only inheritable full-access DACL, verifies owner/ACL/file identity and rejects reparse points/hardlinks.'
new = 'Windows creates an explicitly user-owned root with a user-only inheritable full-access DACL and rejects reparse points/hardlinks. Child lock/SQLite files may be owned by that user or the creating process token\'s exact default-owner SID (TOKEN_OWNER); this accounts for Windows native file creation without accepting an arbitrary foreign owner. Every child must still have exactly one full-access allow ACE for the current user. The root itself must remain user-owned.'
assert s.count(old) == 1
s = s.replace(old, new)
s += '\nWindows ownership reference: [Owner of a New Object](https://learn.microsoft.com/en-us/windows/win32/secauthz/owner-of-a-new-object) and [TOKEN_OWNER](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-token_owner). A native regression checks the actual child-file owner against TOKEN_OWNER and retains the exact user-only DACL checks. This does not request elevation or change the process token.\n'
p.write_text(s)
Path(__file__).unlink()
