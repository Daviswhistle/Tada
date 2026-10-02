//! Fixed namespace, binary installation records, no generic credential export.
use crate::{valid_id,Error,Result};
use zeroize::Zeroizing;
pub(super) trait Vault {
    fn read(&self,id:&str)->Result<Option<Zeroizing<Vec<u8>>>>;
    // Called only while the installation's cross-process enrollment lock is held.
    fn create(&self,id:&str,record:&[u8])->Result<()>;
}
pub(super) struct NativeVault;
fn check(id:&str)->Result<()> {if valid_id(id){Ok(())}else{Err(Error::InvalidIdentity)}}
#[cfg(target_os="linux")]
mod linux {
    use super::*;
    use dbus_secret_service::{EncryptionType,SecretService};
    use std::collections::HashMap;
    fn attrs(id:&str)->HashMap<&str,&str>{HashMap::from([("application","com.daviswhistle.tada.local-control.v1"),("installation",id)])}
    fn error(e:dbus_secret_service::Error)->Error {match e {
        dbus_secret_service::Error::Locked | dbus_secret_service::Error::Prompt => Error::SecretLocked,
        _=>Error::SecretUnavailable,
    }}
    fn service()->Result<SecretService>{SecretService::connect(EncryptionType::Dh).map_err(error)}
    impl Vault for NativeVault {
        fn read(&self,id:&str)->Result<Option<Zeroizing<Vec<u8>>>> {
            check(id)?;let ss=service()?;let found=ss.search_items(attrs(id)).map_err(error)?;
            if found.unlocked.len()+found.locked.len()>1{return Err(Error::SecretAmbiguous);}
            if !found.locked.is_empty(){return Err(Error::SecretLocked);}
            match found.unlocked.first(){
                None=>Ok(None),
                Some(item)=>{
                    if item.is_locked().map_err(error)? {return Err(Error::SecretLocked);}
                    let bytes=Zeroizing::new(item.get_secret().map_err(error)?);
                    if bytes.len()!=100{return Err(Error::SecretConflict);}Ok(Some(bytes))
                }
            }
        }
        fn create(&self,id:&str,record:&[u8])->Result<()> {
            check(id)?;if record.len()!=100{return Err(Error::SecretConflict);}
            if self.read(id)?.is_some(){return Err(Error::SecretConflict);}
            let ss=service()?;let collection=ss.get_default_collection().map_err(error)?;
            if collection.is_locked().map_err(error)? {return Err(Error::SecretLocked);}
            collection.create_item("Tada local control installation",attrs(id),record,false,"application/octet-stream").map_err(error)?;
            Ok(())
        }
    }
    #[cfg(all(test,feature="os-vault-tests"))]
    pub(super) fn delete_test(id:&str)->Result<()> {
        check(id)?;let ss=service()?;let found=ss.search_items(attrs(id)).map_err(error)?;
        if found.unlocked.len()+found.locked.len()>1{return Err(Error::SecretAmbiguous);}
        if !found.locked.is_empty(){return Err(Error::SecretLocked);}
        if let Some(item)=found.unlocked.first(){item.delete().map_err(error)?;}
        Ok(())
    }
}
#[cfg(windows)]
mod windows {
    use super::*;
    use std::{mem::zeroed,ptr::null_mut};
    use windows_sys::Win32::{Foundation::{GetLastError,ERROR_NOT_FOUND},Security::Credentials::{CredFree,CredReadW,CredWriteW,CREDENTIALW,CRED_TYPE_GENERIC,CRED_PERSIST_LOCAL_MACHINE}};
    use zeroize::Zeroize;
    fn target(id:&str)->Result<Vec<u16>>{check(id)?;Ok(format!("Tada/local-control/v1/{id}").encode_utf16().chain(Some(0)).collect())}
    struct Record(*mut CREDENTIALW);
    impl Drop for Record {
        fn drop(&mut self){
            // SAFETY: CredReadW owns one allocated block. The blob is mutable
            // returned memory, cleared before the matching CredFree call.
            unsafe{
                let r=&mut *self.0;
                if !r.CredentialBlob.is_null() && r.CredentialBlobSize<=5120 {
                    std::slice::from_raw_parts_mut(r.CredentialBlob,r.CredentialBlobSize as usize).zeroize();
                }
                CredFree(self.0.cast());
            }
        }
    }
    impl Vault for NativeVault {
        fn read(&self,id:&str)->Result<Option<Zeroizing<Vec<u8>>>> {
            let target=target(id)?;let mut ptr=null_mut();
            // SAFETY: target is terminated, output pointer valid; no enumeration
            // or credential of any other application is requested.
            unsafe{
                if CredReadW(target.as_ptr(),CRED_TYPE_GENERIC,0,&mut ptr)==0 {
                    return if GetLastError()==ERROR_NOT_FOUND {Ok(None)}else{Err(Error::SecretUnavailable)};
                }
                let _record=Record(ptr);let r=&*ptr;
                if r.Type!=CRED_TYPE_GENERIC || r.Persist!=CRED_PERSIST_LOCAL_MACHINE || r.CredentialBlobSize!=100 || r.CredentialBlob.is_null(){return Err(Error::SecretConflict);}
                Ok(Some(Zeroizing::new(std::slice::from_raw_parts(r.CredentialBlob,100).to_vec())))
            }
        }
        fn create(&self,id:&str,record:&[u8])->Result<()> {
            let target=target(id)?;if record.len()!=100{return Err(Error::SecretConflict);}
            if self.read(id)?.is_some(){return Err(Error::SecretConflict);}
            let username:Vec<u16>=id.encode_utf16().chain(Some(0)).collect();
            // SAFETY: CREDENTIALW is a plain Win32 structure; buffers remain
            // alive for the synchronous call. CredWriteW copies the blob.
            unsafe{
                let mut c:CREDENTIALW=zeroed();c.Type=CRED_TYPE_GENERIC;c.Persist=CRED_PERSIST_LOCAL_MACHINE;
                c.TargetName=target.as_ptr().cast_mut();c.UserName=username.as_ptr().cast_mut();
                c.CredentialBlobSize=record.len() as u32;c.CredentialBlob=record.as_ptr().cast_mut();
                if CredWriteW(&c,0)==0{return Err(Error::SecretUnavailable);}
            }
            Ok(())
        }
    }
    #[cfg(all(test,feature="os-vault-tests"))]
    pub(super) fn delete_test(id:&str)->Result<()> {
        use windows_sys::Win32::Security::Credentials::CredDeleteW;
        let target=target(id)?;
        // SAFETY: only the unique test installation target; never enumerate/delete broadly.
        if unsafe{CredDeleteW(target.as_ptr(),CRED_TYPE_GENERIC,0)}==0 && unsafe{GetLastError()}!=ERROR_NOT_FOUND{return Err(Error::SecretUnavailable);}
        Ok(())
    }
}
#[cfg(not(any(target_os="linux",windows)))]
impl Vault for NativeVault {
    fn read(&self,id:&str)->Result<Option<Zeroizing<Vec<u8>>>>{check(id)?;Err(Error::Unsupported)}
    fn create(&self,id:&str,_:&[u8])->Result<()>{check(id)?;Err(Error::Unsupported)}
}
#[cfg(all(test,feature="os-vault-tests",any(target_os="linux",windows)))]
pub(super) fn delete_test(id:&str)->Result<()> {
    #[cfg(target_os="linux")] {linux::delete_test(id)}
    #[cfg(windows)] {windows::delete_test(id)}
}
