use crate::{Error, Result};
use std::{
    fs::{File, OpenOptions},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::Path,
};
pub fn create(path: &Path) -> Result<()> {
    std::fs::DirBuilder::new().mode(0o700).create(path)?;
    // Persist the new name on a local filesystem where directory fsync exists.
    if let Some(parent) = path.parent() {
        File::open(parent)?.sync_all()?;
    }
    Ok(())
}
pub fn open_dir(path: &Path) -> Result<File> {
    Ok(OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?)
}
pub fn check_dir(path: &Path, file: &File) -> Result<()> {
    let held = file.metadata()?;
    let named = std::fs::symlink_metadata(path)?;
    // SAFETY: geteuid has no pointer parameters or side effects.
    let uid = unsafe { libc::geteuid() };
    if !held.is_dir()
        || named.file_type().is_symlink()
        || held.uid() != uid
        || held.mode() & 0o777 != 0o700
        || held.dev() != named.dev()
        || held.ino() != named.ino()
    {
        return Err(Error::UnsafePath);
    }
    Ok(())
}
pub fn open_file(path: &Path, create: bool) -> Result<File> {
    Ok(OpenOptions::new()
        .read(true)
        .write(true)
        .create(create)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?)
}
pub fn check_file(file: &File) -> Result<()> {
    let meta = file.metadata()?;
    // SAFETY: geteuid has no pointer parameters or side effects.
    if !meta.is_file()
        || meta.nlink() != 1
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o022 != 0
    {
        return Err(Error::UnsafePath);
    }
    Ok(())
}
pub fn sync(file: &File) -> Result<()> {
    file.sync_all()?;
    Ok(())
}
