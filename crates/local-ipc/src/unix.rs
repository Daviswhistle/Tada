//! Linux AF_UNIX: private runtime directory, 0600 socket and kernel peer UID.
use crate::{Error, Result, Stream};
use std::{
    fs::{self, File, OpenOptions},
    os::unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};
use tokio::net::{UnixListener, UnixStream};

fn uid() -> u32 {
    // SAFETY: geteuid has no pointer arguments or preconditions.
    unsafe { libc::geteuid() }
}
fn identity(metadata: &fs::Metadata) -> (u64, u64) {
    (metadata.dev(), metadata.ino())
}
fn directory(path: &Path) -> Result<File> {
    if !path.is_absolute() {
        return Err(Error::InvalidEndpoint);
    }
    let handle = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    let metadata = handle.metadata()?;
    let named = fs::symlink_metadata(path)?;
    if !metadata.is_dir()
        || named.file_type().is_symlink()
        || identity(&metadata) != identity(&named)
        || metadata.uid() != uid()
        || metadata.mode() & 0o7777 != 0o700
    {
        return Err(Error::InvalidEndpoint);
    }
    Ok(handle)
}
fn socket_metadata(path: &Path) -> Result<fs::Metadata> {
    let m = fs::symlink_metadata(path)?;
    if !m.file_type().is_socket() || m.uid() != uid() || m.mode() & 0o7777 != 0o600 {
        return Err(Error::InvalidEndpoint);
    }
    Ok(m)
}
fn verify_peer(stream: &UnixStream, expected_pid: Option<u32>) -> Result<()> {
    let peer = stream.peer_cred()?;
    if peer.uid() != uid()
        || expected_pid
            .is_some_and(|pid| peer.pid().and_then(|p| u32::try_from(p).ok()) != Some(pid))
    {
        return Err(Error::PeerRejected);
    }
    Ok(())
}

pub struct Listener {
    listener: UnixListener,
    path: PathBuf,
    address: String,
    root: File,
    inode: (u64, u64),
}
impl Listener {
    /// Existing socket/file/link paths are never unlinked to make binding work.
    /// Use a new private runtime directory after an unclean shutdown.
    pub fn bind(runtime_dir: &Path, instance: &str) -> Result<Self> {
        if instance.len() != 32 || !instance.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(Error::InvalidEndpoint);
        }
        let root = directory(runtime_dir)?;
        let path = runtime_dir.join("control.sock");
        let address = path.to_str().ok_or(Error::InvalidEndpoint)?.to_owned();
        let listener = UnixListener::bind(&path)?;
        // The 0700 parent blocks other users even during this chmod interval.
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
        let inode = identity(&socket_metadata(&path)?);
        if identity(&root.metadata()?) != identity(&fs::symlink_metadata(runtime_dir)?) {
            return Err(Error::InvalidEndpoint);
        }
        Ok(Self {
            listener,
            path,
            address,
            root,
            inode,
        })
    }
    pub fn address(&self) -> &str {
        &self.address
    }
    pub(crate) async fn accept(&mut self) -> Result<Stream> {
        let (stream, _) = self.listener.accept().await?;
        verify_peer(&stream, None)?;
        Ok(Box::new(stream))
    }
}
impl Drop for Listener {
    fn drop(&mut self) {
        // Do not delete a replacement file/socket, or a path in a replaced root.
        let same_root = self
            .path
            .parent()
            .and_then(|p| fs::symlink_metadata(p).ok())
            .zip(self.root.metadata().ok())
            .is_some_and(|(a, b)| identity(&a) == identity(&b) && !a.file_type().is_symlink());
        let same_socket = fs::symlink_metadata(&self.path)
            .is_ok_and(|m| m.file_type().is_socket() && identity(&m) == self.inode);
        if same_root && same_socket {
            let _ = fs::remove_file(&self.path);
        }
    }
}
pub(crate) async fn connect(address: &str, expected_pid: u32) -> Result<Stream> {
    let path = Path::new(address);
    if path.file_name().and_then(|s| s.to_str()) != Some("control.sock") {
        return Err(Error::InvalidEndpoint);
    }
    let parent = path.parent().ok_or(Error::InvalidEndpoint)?;
    let root = directory(parent)?;
    let before = socket_metadata(path)?;
    let stream = UnixStream::connect(path).await?;
    verify_peer(&stream, Some(expected_pid))?;
    if identity(&before) != identity(&socket_metadata(path)?)
        || identity(&root.metadata()?) != identity(&fs::symlink_metadata(parent)?)
    {
        return Err(Error::InvalidEndpoint);
    }
    Ok(Box::new(stream))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::Temp;
    #[tokio::test]
    async fn private_socket_modes_and_collision_preserve_existing_endpoint() {
        let tmp = Temp::new();
        let listener = Listener::bind(&tmp.0, &"a".repeat(32)).unwrap();
        let path = Path::new(listener.address());
        let original = identity(&fs::symlink_metadata(path).unwrap());
        assert_eq!(fs::metadata(path).unwrap().mode() & 0o777, 0o600);
        assert!(Listener::bind(&tmp.0, &"b".repeat(32)).is_err());
        assert_eq!(identity(&fs::symlink_metadata(path).unwrap()), original);
        drop(listener);
        assert!(!tmp.0.join("control.sock").exists());
    }
    #[tokio::test]
    async fn public_runtime_dir_and_symlink_are_rejected_without_chmod() {
        let tmp = Temp::new();
        fs::set_permissions(&tmp.0, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(Listener::bind(&tmp.0, &"a".repeat(32)).is_err());
        assert_eq!(fs::metadata(&tmp.0).unwrap().mode() & 0o777, 0o755);
        fs::set_permissions(&tmp.0, fs::Permissions::from_mode(0o700)).unwrap();
        let link = tmp.0.join("alias");
        std::os::unix::fs::symlink(&tmp.0, &link).unwrap();
        assert!(Listener::bind(&link, &"a".repeat(32)).is_err());
    }
    #[tokio::test]
    async fn existing_file_link_and_replacement_survive_listener_cleanup() {
        let tmp = Temp::new();
        let path = tmp.0.join("control.sock");
        fs::write(&path, b"preserve").unwrap();
        assert!(Listener::bind(&tmp.0, &"a".repeat(32)).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"preserve");
        fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink("missing-target", &path).unwrap();
        assert!(Listener::bind(&tmp.0, &"a".repeat(32)).is_err());
        assert!(fs::symlink_metadata(&path)
            .unwrap()
            .file_type()
            .is_symlink());
        fs::remove_file(&path).unwrap();
        let listener = Listener::bind(&tmp.0, &"a".repeat(32)).unwrap();
        fs::remove_file(&path).unwrap();
        fs::write(&path, b"replacement").unwrap();
        drop(listener);
        assert_eq!(fs::read(&path).unwrap(), b"replacement");
    }
    #[tokio::test]
    async fn inherited_kernel_peer_pid_is_checked_before_handshake() {
        let (a, b) = UnixStream::pair().unwrap();
        verify_peer(&a, Some(std::process::id())).unwrap();
        assert!(matches!(
            verify_peer(&b, Some(std::process::id() + 1)),
            Err(Error::PeerRejected)
        ));
    }
}
