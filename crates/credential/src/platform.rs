//! Private metadata directory; OS vault access is separate from filesystem IO.
use crate::{Error, Result};
use std::{
    fs::File,
    path::{Component, Path, PathBuf},
};
#[cfg(target_os = "linux")]
#[path = "unix_root.rs"]
mod imp;
#[cfg(windows)]
#[path = "windows_root.rs"]
mod imp;
#[cfg(not(any(target_os = "linux", windows)))]
mod imp {
    use super::*;
    pub fn create(_: &Path) -> Result<()> {
        Err(Error::Unsupported)
    }
    pub fn open_dir(_: &Path) -> Result<File> {
        Err(Error::Unsupported)
    }
    pub fn check_dir(_: &Path, _: &File) -> Result<()> {
        Err(Error::Unsupported)
    }
    pub fn open_file(_: &Path, _: bool) -> Result<File> {
        Err(Error::Unsupported)
    }
    pub fn check_file(_: &File) -> Result<()> {
        Err(Error::Unsupported)
    }
    pub fn sync(_: &File) -> Result<()> {
        Err(Error::Unsupported)
    }
}
pub(super) struct Root {
    path: PathBuf,
    directory: File,
}
impl Root {
    pub fn create(path: &Path) -> Result<()> {
        valid_path(path)?;
        imp::create(path)
    }
    pub fn open(path: &Path) -> Result<Self> {
        valid_path(path)?;
        let directory = imp::open_dir(path)?;
        imp::check_dir(path, &directory)?;
        Ok(Self {
            path: path.to_owned(),
            directory,
        })
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn file(&self, name: &str, create: bool) -> Result<File> {
        if !matches!(name, "identity.lock" | "daemon.lock") {
            return Err(Error::UnsafePath);
        }
        imp::check_dir(&self.path, &self.directory)?;
        let file = imp::open_file(&self.path.join(name), create)?;
        imp::check_file(&file)?;
        Ok(file)
    }
    pub fn check_files(&self, names: &[&str]) -> Result<()> {
        imp::check_dir(&self.path, &self.directory)?;
        for name in names {
            let path = self.path.join(name);
            match std::fs::symlink_metadata(&path) {
                Ok(meta) => {
                    if !meta.is_file() || meta.file_type().is_symlink() {
                        return Err(Error::UnsafePath);
                    }
                    let file = imp::open_file(&path, false)?;
                    imp::check_file(&file)?;
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                Err(_) => return Err(Error::Io),
            }
        }
        Ok(())
    }
    pub fn sync(&self) -> Result<()> {
        imp::sync(&self.directory)
    }
}
fn valid_path(path: &Path) -> Result<()> {
    if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(Error::UnsafePath);
    }
    #[cfg(windows)]
    if !matches!(path.components().next(),Some(Component::Prefix(p)) if matches!(p.kind(),std::path::Prefix::Disk(_)))
    {
        return Err(Error::UnsafePath);
    }
    Ok(())
}
pub(super) fn address(root: &Path, instance: &str) -> Result<String> {
    #[cfg(target_os = "linux")]
    {
        root.join(format!("run-{instance}"))
            .join("control.sock")
            .into_os_string()
            .into_string()
            .map_err(|_| Error::UnsafePath)
    }
    #[cfg(windows)]
    {
        let _ = root;
        Ok(format!("\\\\.\\pipe\\Tada-core04-{instance}"))
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        let _ = (root, instance);
        Err(Error::Unsupported)
    }
}
#[cfg(all(test, not(any(target_os = "linux", windows))))]
mod tests {
    #[test]
    fn unsupported_identity_has_no_filesystem_fallback() {
        let root = std::env::temp_dir().join("tada-unsupported-identity-must-not-exist");
        assert_eq!(super::Root::create(&root), Err(crate::Error::Unsupported));
        assert!(!root.exists());
    }
}
