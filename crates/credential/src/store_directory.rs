//! Reuse installation directory protections for the foreground task store.
//! The guard must outlive the Store and all child processes using this root.
use crate::{platform::Root,Error,Result};
use std::path::Path;
use tada_store::Store;

pub struct StoreDirectory { root:Root }
impl StoreDirectory {
    pub fn create(path:&Path)->Result<Self> {
        Root::create(path)?;
        Self::open(path)
    }
    pub fn open(path:&Path)->Result<Self> { Ok(Self {root:Root::open(path)?}) }
    pub fn path(&self)->&Path { self.root.path() }
    fn checked_store(&self,create:bool)->Result<Store> {
        const FILES:&[&str]=&["state.sqlite","state.sqlite-wal","state.sqlite-shm","state.sqlite-journal","witness.sqlite","witness.sqlite-wal","witness.sqlite-shm","witness.sqlite-journal","owner.lock"];
        self.root.check_files(FILES)?;
        if create {
            if FILES.iter().any(|name|self.path().join(name).exists()) {return Err(Error::InvalidIdentity);}
        } else if !self.path().join("state.sqlite").is_file() || !self.path().join("witness.sqlite").is_file() {
            return Err(Error::RecoveryRequired);
        }
        let store=Store::open(self.path())?;
        self.root.check_files(FILES)?;
        Ok(store)
    }
    /// Explicit initialization; never adopts or overwrites an existing store.
    pub fn initialize_store(&self)->Result<Store> {self.checked_store(true)}
    /// Requires existing ledgers; a misspelled path cannot create a fresh store.
    pub fn open_store(&self)->Result<Store> {self.checked_store(false)}
}
#[cfg(all(test,any(target_os="linux",windows)))]
mod tests {
    use super::*;
    #[test]
    fn guarded_store_is_explicit_and_preserves_identity_across_open() {
        let mut random=[0;16];getrandom::fill(&mut random).unwrap();
        let path=std::env::temp_dir().join(format!("td7-{:x}",u128::from_le_bytes(random)));
        let root=StoreDirectory::create(&path).unwrap();
        assert!(root.open_store().is_err());
        let store=root.initialize_store().unwrap();let id=store.control_store_id().unwrap();
        assert!(root.initialize_store().is_err());
        drop(store);let store=root.open_store().unwrap();
        assert_eq!(store.control_store_id().unwrap(),id);
        drop(store);drop(root);std::fs::remove_dir_all(path).unwrap();
    }
}
