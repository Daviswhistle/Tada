//! Fail-closed capability boundary, not an emulated native transport.
//! Keep portable workspace code buildable without claiming native IPC support.
use crate::{Error, Result, Stream};
use std::path::Path;

/// Cannot be constructed through the public API on unsupported platforms.
pub struct Listener {
    _private: (),
}
impl Listener {
    pub fn bind(_: &Path, _: &str) -> Result<Self> {
        Err(Error::UnsupportedPlatform)
    }
    pub fn address(&self) -> &str {
        ""
    }
    pub(crate) async fn accept(&mut self) -> Result<Stream> {
        Err(Error::UnsupportedPlatform)
    }
}
impl Drop for Listener {
    fn drop(&mut self) {}
}
pub(crate) async fn connect(_: &str, _: u32) -> Result<Stream> {
    Err(Error::UnsupportedPlatform)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{create_runtime_dir, Client, ConnectInfo, Limits};
    use tada_store::control::auth::{Access, Credential};

    #[tokio::test]
    async fn unsupported_transport_fails_before_creating_files_or_authenticating() {
        let path = std::env::temp_dir().join(format!("tada-unsupported-{}", std::process::id()));
        assert!(!path.exists());
        assert!(matches!(
            create_runtime_dir(&path),
            Err(Error::UnsupportedPlatform)
        ));
        assert!(matches!(
            Listener::bind(&path, &"a".repeat(32)),
            Err(Error::UnsupportedPlatform)
        ));
        let credential = Credential::generate("ui", Access::Controller).unwrap();
        let info = ConnectInfo {
            address: "unused".into(),
            store_id: "a".repeat(32),
            server_pid: std::process::id(),
        };
        assert!(matches!(
            Client::connect(&info, &credential, Limits::default()).await,
            Err(Error::UnsupportedPlatform)
        ));
        assert!(!path.exists());
    }
}
