//! Native local control transport for Linux and Windows.
//! Credentials are supplied by a trusted host, never read from RPC or disk.
//! No HTTP port, automatic tool dispatch, service installation or key store.
use serde::{de::DeserializeOwned, Serialize};
use std::{
    fmt,
    path::Path,
    sync::{Arc, Mutex, TryLockError},
    time::Duration,
};
use tada_store::{
    control::auth::{
        Challenge, ClientProof, ClientSession, Credential, ServerProof, ServerSession, MAX_BODY,
    },
    Store,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    sync::{watch, Semaphore},
    task::JoinSet,
    time::{sleep, timeout},
};

#[cfg(target_os = "linux")]
#[path = "unix.rs"]
mod platform;
#[cfg(windows)]
#[path = "windows.rs"]
mod platform;
#[cfg(not(any(target_os = "linux", windows)))]
compile_error!("tada-local-ipc currently qualifies Linux and Windows only");
pub use platform::Listener;

pub type Result<T> = std::result::Result<T, Error>;
pub enum Error {
    Io(std::io::Error),
    Protocol(tada_store::Error),
    Deadline,
    PeerRejected,
    InvalidEndpoint,
    InvalidLimits,
    WorkerFailed,
    Closed,
    InvalidHandshake,
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Io(_) => "IPC_IO_FAILED",
            Self::Protocol(_) => "IPC_PROTOCOL_FAILED",
            Self::Deadline => "IPC_DEADLINE",
            Self::PeerRejected => "IPC_PEER_REJECTED",
            Self::InvalidEndpoint => "IPC_ENDPOINT_REJECTED",
            Self::InvalidLimits => "IPC_LIMITS_REJECTED",
            Self::WorkerFailed => "IPC_STORE_WORKER_FAILED",
            Self::Closed => "IPC_CLOSED",
            Self::InvalidHandshake => "IPC_HANDSHAKE_REJECTED",
        })
    }
}
impl fmt::Debug for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, f)
    }
}
impl std::error::Error for Error {}
impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}
impl From<tada_store::Error> for Error {
    fn from(e: tada_store::Error) -> Self {
        Self::Protocol(e)
    }
}

pub(crate) trait Duplex: AsyncRead + AsyncWrite + Send + Unpin {}
impl<T: AsyncRead + AsyncWrite + Send + Unpin> Duplex for T {}
pub(crate) type Stream = Box<dyn Duplex>;

#[derive(Clone, Copy)]
pub struct Limits {
    pub connections: usize,
    pub handshake: Duration,
    pub frame: Duration,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            connections: 8,
            handshake: Duration::from_secs(5),
            frame: Duration::from_secs(5),
        }
    }
}
impl Limits {
    fn validate(self) -> Result<Self> {
        if !(1..=32).contains(&self.connections)
            || self.handshake.is_zero()
            || self.handshake > Duration::from_secs(10)
            || self.frame.is_zero()
            || self.frame > Duration::from_secs(30)
        {
            return Err(Error::InvalidLimits);
        }
        Ok(self)
    }
}

/// Metadata must arrive from the trusted launcher or protected discovery, not
/// by copying fields from an unauthenticated server challenge. Contains no key.
#[derive(Clone, Debug)]
pub struct ConnectInfo {
    pub address: String,
    pub store_id: String,
    pub server_pid: u32,
}

#[derive(Default, Debug)]
pub struct ServeReport {
    pub accepted: u64,
    pub capacity_rejected: u64,
    pub closed: u64,
    pub failed: u64,
}

/// One listener credential represents one trusted principal/access pair.
/// Disk transactions run on blocking workers; slow network clients never hold
/// the store mutex. Shutdown stops new reads and drains already entered commands.
/// It cannot bound a physically hung disk or retroactively cancel a DB commit.
pub async fn serve(
    mut listener: Listener,
    store: Arc<Mutex<Store>>,
    credential: Arc<Credential>,
    limits: Limits,
    mut shutdown: watch::Receiver<bool>,
) -> Result<ServeReport> {
    let limits = limits.validate()?;
    let permits = Arc::new(Semaphore::new(limits.connections));
    let (stop, stopped) = watch::channel(false);
    let mut jobs = JoinSet::new();
    let mut report = ServeReport::default();
    let mut fatal = None;
    loop {
        if *shutdown.borrow() {
            break;
        }
        tokio::select! {
            biased;
            _ = shutdown.changed() => break,
            result = jobs.join_next(), if !jobs.is_empty() => {
                match result {
                    Some(Ok(Ok(()))) => report.closed += 1,
                    Some(Ok(Err(_))) => report.failed += 1,
                    Some(Err(_)) => { fatal = Some(Error::WorkerFailed); break; },
                    None => (),
                }
            },
            result = listener.accept() => {
                let stream = match result { Ok(stream) => stream, Err(Error::PeerRejected) => { report.failed += 1; continue; }, Err(error) => { fatal = Some(error); break; } };
                report.accepted += 1;
                let Ok(permit) = Arc::clone(&permits).try_acquire_owned() else { report.capacity_rejected += 1; drop(stream); continue; };
                let store = Arc::clone(&store);
                let credential = Arc::clone(&credential);
                let stopped = stopped.clone();
                jobs.spawn(async move { let _permit = permit; connection(stream, store, credential, limits, stopped).await });
            }
        }
    }
    let _ = stop.send(true);
    // Keep the listener/Windows pending instance owned until workers drain.
    while let Some(result) = jobs.join_next().await {
        match result {
            Ok(Ok(())) => report.closed += 1,
            Ok(Err(_)) => report.failed += 1,
            Err(_) => fatal = Some(Error::WorkerFailed),
        }
    }
    drop(listener);
    match fatal {
        Some(error) => Err(error),
        None => Ok(report),
    }
}

async fn connection(
    mut stream: Stream,
    store: Arc<Mutex<Store>>,
    credential: Arc<Credential>,
    limits: Limits,
    mut stopped: watch::Receiver<bool>,
) -> Result<()> {
    let handshake = async {
        // The pending challenge borrows only the credential, not the store.
        // Never wait for network I/O or a busy mutex while holding a DB guard.
        let pending = loop {
            let pending = match store.try_lock() {
                Ok(store) => Some(store.control_challenge(&credential)?),
                Err(TryLockError::WouldBlock) => None,
                Err(TryLockError::Poisoned(_)) => return Err(Error::WorkerFailed),
            };
            if let Some(pending) = pending {
                break pending;
            }
            sleep(Duration::from_millis(2)).await;
        };
        write_handshake(&mut stream, &pending.message()).await?;
        let proof: ClientProof = read_handshake(&mut stream).await?;
        let (session, proof) = pending.accept(proof)?;
        write_handshake(&mut stream, &proof).await?;
        Ok::<ServerSession, Error>(session)
    };
    let mut session = tokio::select! {
        biased;
        _ = stopped.changed() => return Ok(()),
        result = timeout(limits.handshake, handshake) => result.map_err(|_| Error::Deadline)??,
    };
    loop {
        if *stopped.borrow() {
            return Ok(());
        }
        let frame = tokio::select! {
            biased;
            _ = stopped.changed() => return Ok(()),
            result = timeout(limits.frame, read_packet(&mut stream, 41, 40 + MAX_BODY)) => result.map_err(|_| Error::Deadline)??,
        };
        if *stopped.borrow() {
            return Ok(());
        }
        let owner = Arc::clone(&store);
        let stop_at_admission = stopped.clone();
        // Do not time out/abort this blocking worker and then claim the command
        // did not commit. The immutable CORE-03 receipt settles lost replies.
        let (returned_session, response) = tokio::task::spawn_blocking(move || {
            let mut store = owner.lock().map_err(|_| Error::WorkerFailed)?;
            if *stop_at_admission.borrow() {
                return Err(Error::Closed);
            }
            let response = store.control_handle(&mut session, &frame)?;
            Ok::<_, Error>((session, response))
        })
        .await
        .map_err(|_| Error::WorkerFailed)??;
        session = returned_session;
        if *stopped.borrow() {
            return Ok(());
        }
        tokio::select! {
            biased;
            _ = stopped.changed() => return Ok(()),
            result = timeout(limits.frame, stream.write_all(&response)) => result.map_err(|_| Error::Deadline)??,
        }
    }
}

/// A client is single-flight. Any I/O, deadline or authentication error closes
/// its logical session. Reconnect with the same request_id; never resend a raw
/// frame or infer that a timed-out mutation did not commit.
pub struct Client {
    stream: Stream,
    session: Option<ClientSession>,
    limits: Limits,
}
impl Client {
    pub async fn connect(
        info: &ConnectInfo,
        credential: &Credential,
        limits: Limits,
    ) -> Result<Self> {
        let limits = limits.validate()?;
        if info.server_pid == 0 {
            return Err(Error::PeerRejected);
        }
        let handshake = async {
            let mut stream = platform::connect(&info.address, info.server_pid).await?;
            let challenge: Challenge = read_handshake(&mut stream).await?;
            let (pending, proof) = credential.answer(&challenge, &info.store_id)?;
            write_handshake(&mut stream, &proof).await?;
            let proof: ServerProof = read_handshake(&mut stream).await?;
            let session = pending.confirm(proof)?;
            Ok::<_, Error>(Self {
                stream,
                session: Some(session),
                limits,
            })
        };
        timeout(limits.handshake, handshake)
            .await
            .map_err(|_| Error::Deadline)?
    }
    pub async fn request(&mut self, json: &[u8]) -> Result<Vec<u8>> {
        let mut session = self.session.take().ok_or(Error::Closed)?;
        let frame = session.request(json)?;
        let response = timeout(self.limits.frame, async {
            self.stream.write_all(&frame).await?;
            let response = read_packet(&mut self.stream, 41, 40 + MAX_BODY).await?;
            Ok::<_, Error>(session.response(&response)?)
        })
        .await
        .map_err(|_| Error::Deadline)??;
        self.session = Some(session);
        Ok(response)
    }
}

// One deadline wraps the entire header/body operation, not each individual
// read. Sending one byte at a time cannot extend the deadline indefinitely.
pub(crate) async fn read_packet(
    stream: &mut (impl AsyncRead + Unpin),
    min: usize,
    max: usize,
) -> Result<Vec<u8>> {
    let mut header = [0; 4];
    stream.read_exact(&mut header).await?;
    let length = u32::from_be_bytes(header) as usize;
    if !(min..=max).contains(&length) {
        return Err(Error::InvalidHandshake);
    }
    let mut frame = vec![0; length + 4];
    frame[..4].copy_from_slice(&header);
    stream.read_exact(&mut frame[4..]).await?;
    Ok(frame)
}
async fn read_handshake<T: DeserializeOwned>(stream: &mut Stream) -> Result<T> {
    let frame = read_packet(stream, 1, 2048).await?;
    // Deserialize directly into deny_unknown_fields structs, including duplicate
    // field rejection. Do not parse into Value and lose duplicate-key evidence.
    serde_json::from_slice(&frame[4..]).map_err(|_| Error::InvalidHandshake)
}
async fn write_handshake<T: Serialize>(stream: &mut Stream, value: &T) -> Result<()> {
    let bytes = serde_json::to_vec(value).map_err(|_| Error::InvalidHandshake)?;
    if bytes.is_empty() || bytes.len() > 2048 {
        return Err(Error::InvalidHandshake);
    }
    stream
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .await?;
    stream.write_all(&bytes).await?;
    Ok(())
}

/// Creates only a new runtime directory. Existing directories are not chmodded
/// or overwritten. Windows pipe security is enforced on the pipe, not by this
/// directory helper; real-user store-directory ACLs remain a separate concern.
pub fn create_runtime_dir(path: &Path) -> Result<()> {
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new().mode(0o700).create(path)?;
    }
    #[cfg(windows)]
    std::fs::create_dir(path)?;
    Ok(())
}

#[cfg(test)]
mod tests;
