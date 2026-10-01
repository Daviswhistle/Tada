//! Transport-neutral mutual authentication and bounded authenticated frames.
//! This is not OS peer authentication, a secret store, TLS, or an IPC listener.
use crate::{Error, Result};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::{
    io::{Read, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

pub const MAX_BODY: usize = 65_536;
const OVERHEAD: usize = 8 + 32;
const HANDSHAKE_TTL: Duration = Duration::from_secs(10);
const SESSION_TTL: Duration = Duration::from_secs(300);
const MAX_MESSAGES: u64 = 4096;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Access {
    Controller,
    Observer,
}

/// Created by the trusted host, never from an RPC request. Use a different key
/// for each principal/access pair. No Debug, Serialize or plaintext-file API.
pub struct Credential {
    principal: String,
    access: Access,
    key: [u8; 32],
    revoked: Arc<AtomicBool>,
}
impl Credential {
    pub fn generate(principal: &str, access: Access) -> Result<Self> {
        Self::from_secret(principal, access, random()?)
    }
    /// The caller must provision the same random secret through a protected
    /// bootstrap channel. This function does not fetch another app's tokens.
    pub fn from_secret(principal: &str, access: Access, key: [u8; 32]) -> Result<Self> {
        if !identifier(principal) {
            return Err(Error::Invalid("INVALID_PRINCIPAL"));
        }
        Ok(Self {
            principal: principal.into(),
            access,
            key,
            revoked: Arc::new(AtomicBool::new(false)),
        })
    }
    pub fn revoke(&self) {
        self.revoked.store(true, Ordering::SeqCst);
    }

    pub(crate) fn challenge(&self, store_id: String, generation: i64) -> Result<Pending<'_>> {
        if self.revoked.load(Ordering::SeqCst) {
            return Err(auth_error());
        }
        let message = Challenge {
            version: 1,
            store_id,
            generation,
            principal: self.principal.clone(),
            access: self.access,
            nonce: random()?,
        };
        Ok(Pending {
            credential: self,
            message,
            created: Instant::now(),
        })
    }

    /// expected_store_id must come from the trusted bootstrap, not from copying
    /// an untrusted challenge's field at the client trust boundary.
    pub fn answer(
        &self,
        challenge: &Challenge,
        expected_store_id: &str,
    ) -> Result<(ClientPending, ClientProof)> {
        if self.revoked.load(Ordering::SeqCst)
            || challenge.version != 1
            || challenge.principal != self.principal
            || challenge.access != self.access
            || challenge.store_id != expected_store_id
            || challenge.store_id.len() != 32
            || !challenge.store_id.bytes().all(|b| b.is_ascii_hexdigit())
            || challenge.generation <= 0
        {
            return Err(auth_error());
        }
        let nonce = random()?;
        let transcript = transcript(challenge, &nonce)?;
        let proof = ClientProof {
            nonce,
            mac: sign(&self.key, b"client-proof", &[&transcript]),
        };
        let pending = ClientPending {
            expected: make_mac(&self.key, b"server-proof", &[&transcript]),
            key: sign(&self.key, b"session-key", &[&transcript]),
            created: Instant::now(),
        };
        Ok((pending, proof))
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Challenge {
    pub version: u8,
    pub store_id: String,
    pub generation: i64,
    pub principal: String,
    pub access: Access,
    pub nonce: [u8; 32],
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClientProof {
    pub nonce: [u8; 32],
    pub mac: [u8; 32],
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServerProof {
    pub mac: [u8; 32],
}

/// Consumed even by a failed authentication: a challenge cannot be retried.
pub struct Pending<'a> {
    credential: &'a Credential,
    message: Challenge,
    created: Instant,
}
impl Pending<'_> {
    pub fn message(&self) -> Challenge {
        self.message.clone()
    }
    pub fn accept(self, proof: ClientProof) -> Result<(ServerSession, ServerProof)> {
        if self.created.elapsed() >= HANDSHAKE_TTL || self.credential.revoked.load(Ordering::SeqCst)
        {
            return Err(auth_error());
        }
        let transcript = transcript(&self.message, &proof.nonce)?;
        make_mac(&self.credential.key, b"client-proof", &[&transcript])
            .verify_slice(&proof.mac)
            .map_err(|_| auth_error())?;
        let reply = ServerProof {
            mac: sign(&self.credential.key, b"server-proof", &[&transcript]),
        };
        let key = sign(&self.credential.key, b"session-key", &[&transcript]);
        Ok((
            ServerSession {
                principal: self.message.principal,
                access: self.message.access,
                store_id: self.message.store_id,
                generation: self.message.generation,
                revoked: Arc::clone(&self.credential.revoked),
                channel: Channel::new(key),
            },
            reply,
        ))
    }
}
pub struct ClientPending {
    expected: Hmac<Sha256>,
    key: [u8; 32],
    created: Instant,
}
impl ClientPending {
    pub fn confirm(self, proof: ServerProof) -> Result<ClientSession> {
        if self.created.elapsed() >= HANDSHAKE_TTL {
            return Err(auth_error());
        }
        self.expected
            .verify_slice(&proof.mac)
            .map_err(|_| auth_error())?;
        Ok(ClientSession {
            channel: Channel::new(self.key),
        })
    }
}

pub struct ServerSession {
    pub(super) principal: String,
    pub(super) access: Access,
    store_id: String,
    generation: i64,
    revoked: Arc<AtomicBool>,
    channel: Channel,
}
impl ServerSession {
    pub fn revoke(&mut self) {
        self.channel.dead = true;
    }
    pub(super) fn check(&self, store_id: &str, generation: i64) -> Result<()> {
        self.channel.active()?;
        if self.revoked.load(Ordering::SeqCst)
            || self.store_id != store_id
            || self.generation != generation
        {
            return Err(auth_error());
        }
        Ok(())
    }
    pub(super) fn open(&mut self, frame: &[u8]) -> Result<Vec<u8>> {
        self.channel.open(b"request", frame)
    }
    pub(super) fn seal(&mut self, body: &[u8]) -> Result<Vec<u8>> {
        self.channel.seal(b"response", body)
    }
}
pub struct ClientSession {
    channel: Channel,
}
impl ClientSession {
    pub fn request(&mut self, body: &[u8]) -> Result<Vec<u8>> {
        self.channel.seal(b"request", body)
    }
    pub fn response(&mut self, frame: &[u8]) -> Result<Vec<u8>> {
        self.channel.open(b"response", frame)
    }
}
struct Channel {
    key: [u8; 32],
    sent: u64,
    received: u64,
    created: Instant,
    dead: bool,
}
impl Channel {
    fn new(key: [u8; 32]) -> Self {
        Self {
            key,
            sent: 0,
            received: 0,
            created: Instant::now(),
            dead: false,
        }
    }
    fn active(&self) -> Result<()> {
        if self.dead || self.created.elapsed() >= SESSION_TTL {
            return Err(auth_error());
        }
        Ok(())
    }
    fn seal(&mut self, direction: &[u8], body: &[u8]) -> Result<Vec<u8>> {
        self.active()?;
        if body.is_empty() || body.len() > MAX_BODY || self.sent >= MAX_MESSAGES {
            self.dead = true;
            return Err(auth_error());
        }
        self.sent += 1;
        let sequence = self.sent.to_be_bytes();
        let size = u32::try_from(body.len() + OVERHEAD)
            .map_err(|_| auth_error())?
            .to_be_bytes();
        let mac = sign(&self.key, direction, &[&size, &sequence, body]);
        let mut frame = Vec::with_capacity(4 + body.len() + OVERHEAD);
        frame.extend_from_slice(&size);
        frame.extend_from_slice(&sequence);
        frame.extend_from_slice(body);
        frame.extend_from_slice(&mac);
        Ok(frame)
    }
    fn open(&mut self, direction: &[u8], frame: &[u8]) -> Result<Vec<u8>> {
        let result = (|| {
            self.active()?;
            if frame.len() < 4 + OVERHEAD + 1
                || frame.len() > 4 + OVERHEAD + MAX_BODY
                || self.received >= MAX_MESSAGES
            {
                return Err(auth_error());
            }
            let size =
                u32::from_be_bytes(frame[..4].try_into().map_err(|_| auth_error())?) as usize;
            if size + 4 != frame.len() {
                return Err(auth_error());
            }
            let sequence = u64::from_be_bytes(frame[4..12].try_into().map_err(|_| auth_error())?);
            if sequence != self.received + 1 {
                return Err(auth_error());
            }
            let end = frame.len() - 32;
            let body = &frame[12..end];
            make_mac(&self.key, direction, &[&frame[..4], &frame[4..12], body])
                .verify_slice(&frame[end..])
                .map_err(|_| auth_error())?;
            self.received = sequence;
            Ok(body.to_vec())
        })();
        if result.is_err() {
            self.dead = true;
        }
        result
    }
}

/// Read a complete frame without allocating an attacker-provided unbounded body.
/// The transport owner must enforce I/O deadlines and a connection concurrency
/// bound. Generic Read/Write cannot impose OS timeouts or peer credentials.
pub fn read_frame(reader: &mut impl Read) -> Result<Vec<u8>> {
    let mut header = [0u8; 4];
    reader.read_exact(&mut header)?;
    let size = u32::from_be_bytes(header) as usize;
    if !(OVERHEAD + 1..=OVERHEAD + MAX_BODY).contains(&size) {
        return Err(auth_error());
    }
    let mut frame = vec![0u8; size + 4];
    frame[..4].copy_from_slice(&header);
    reader.read_exact(&mut frame[4..])?;
    Ok(frame)
}
pub fn write_frame(writer: &mut impl Write, frame: &[u8]) -> Result<()> {
    if frame.len() < 4 + OVERHEAD + 1 || frame.len() > 4 + OVERHEAD + MAX_BODY {
        return Err(auth_error());
    }
    let size = u32::from_be_bytes(frame[..4].try_into().map_err(|_| auth_error())?) as usize;
    if size + 4 != frame.len() {
        return Err(auth_error());
    }
    writer.write_all(frame)?;
    writer.flush()?;
    Ok(())
}
fn random() -> Result<[u8; 32]> {
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes).map_err(|_| Error::Denied("ENTROPY_UNAVAILABLE"))?;
    Ok(bytes)
}
fn transcript(challenge: &Challenge, nonce: &[u8; 32]) -> Result<Vec<u8>> {
    Ok(serde_json::to_vec(&(challenge, nonce))?)
}
fn make_mac(key: &[u8; 32], label: &[u8], parts: &[&[u8]]) -> Hmac<Sha256> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("fixed-size HMAC key");
    mac.update(b"tada.local.control.v1\0");
    mac.update(&(label.len() as u64).to_be_bytes());
    mac.update(label);
    for part in parts {
        mac.update(&(part.len() as u64).to_be_bytes());
        mac.update(part);
    }
    mac
}
fn sign(key: &[u8; 32], label: &[u8], parts: &[&[u8]]) -> [u8; 32] {
    make_mac(key, label, parts).finalize().into_bytes().into()
}
fn auth_error() -> Error {
    Error::Denied("CONTROL_AUTH_FAILED")
}
pub(super) fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.as_bytes()[0].is_ascii_alphabetic()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn handshake(credential: &Credential) -> (ServerSession, ClientSession) {
        let pending = credential.challenge("a".repeat(32), 1).unwrap();
        let (client, proof) = credential
            .answer(&pending.message(), &"a".repeat(32))
            .unwrap();
        let (server, proof) = pending.accept(proof).unwrap();
        (server, client.confirm(proof).unwrap())
    }
    #[test]
    fn mutual_authentication_wrong_key_and_server_proof() {
        let good = Credential::generate("ui", Access::Controller).unwrap();
        let wrong = Credential::generate("ui", Access::Controller).unwrap();
        let pending = good.challenge("a".repeat(32), 1).unwrap();
        let (_, proof) = wrong.answer(&pending.message(), &"a".repeat(32)).unwrap();
        assert!(pending.accept(proof).is_err());
        let pending = good.challenge("a".repeat(32), 1).unwrap();
        let (client, proof) = good.answer(&pending.message(), &"a".repeat(32)).unwrap();
        let (_, mut proof) = pending.accept(proof).unwrap();
        proof.mac[0] ^= 1;
        assert!(client.confirm(proof).is_err());
    }
    #[test]
    fn role_store_identity_and_fresh_challenge_are_bound() {
        let good = Credential::generate("ui", Access::Controller).unwrap();
        let pending = good.challenge("a".repeat(32), 1).unwrap();
        let mut message = pending.message();
        message.access = Access::Observer;
        assert!(good.answer(&message, &"a".repeat(32)).is_err());
        assert!(good.answer(&pending.message(), &"b".repeat(32)).is_err());
        let (_, proof) = good.answer(&pending.message(), &"a".repeat(32)).unwrap();
        drop(pending);
        let other = good.challenge("a".repeat(32), 1).unwrap();
        assert!(other.accept(proof).is_err());
    }
    #[test]
    fn expired_handshake_and_session_fail_closed() {
        let credential = Credential::generate("ui", Access::Controller).unwrap();
        let mut pending = credential.challenge("a".repeat(32), 1).unwrap();
        let (_, proof) = credential
            .answer(&pending.message(), &"a".repeat(32))
            .unwrap();
        pending.created = Instant::now().checked_sub(HANDSHAKE_TTL).unwrap();
        assert!(pending.accept(proof).is_err());
        let (mut server, mut client) = handshake(&credential);
        server.channel.created = Instant::now().checked_sub(SESSION_TTL).unwrap();
        assert!(server.open(&client.request(b"{}").unwrap()).is_err());
    }
    #[test]
    fn replay_reordering_direction_and_tampering_close_session() {
        let credential = Credential::generate("ui", Access::Controller).unwrap();
        for mode in 0..4 {
            let (mut server, mut client) = handshake(&credential);
            let frame = client.request(b"{}").unwrap();
            let bad = match mode {
                0 => {
                    server.open(&frame).unwrap();
                    frame.clone()
                }
                1 => client.request(b"{}").unwrap(),
                2 => server.seal(b"{}").unwrap(),
                _ => {
                    let mut bad = frame.clone();
                    bad[12] ^= 1;
                    bad
                }
            };
            assert!(server.open(&bad).is_err());
            assert!(server.open(&frame).is_err());
        }
    }
    #[test]
    fn shared_credential_revocation_and_store_generation() {
        let credential = Credential::generate("ui", Access::Controller).unwrap();
        let (server, _) = handshake(&credential);
        assert!(server.check(&"a".repeat(32), 2).is_err());
        assert!(server.check(&"b".repeat(32), 1).is_err());
        assert!(server.check(&"a".repeat(32), 1).is_ok());
        credential.revoke();
        assert!(server.check(&"a".repeat(32), 1).is_err());
        assert!(credential.challenge("a".repeat(32), 1).is_err());
    }
    #[test]
    fn framing_rejects_huge_partial_empty_and_trailing_bytes() {
        let credential = Credential::generate("ui", Access::Controller).unwrap();
        assert!(read_frame(&mut &u32::MAX.to_be_bytes()[..]).is_err());
        let (mut server, mut client) = handshake(&credential);
        let mut frame = client.request(b"{}").unwrap();
        assert!(read_frame(&mut &frame[..frame.len() - 1]).is_err());
        assert_eq!(read_frame(&mut &frame[..]).unwrap(), frame);
        frame.push(0);
        assert!(server.open(&frame).is_err());
        let (_, mut client) = handshake(&credential);
        assert!(client.request(b"").is_err());
        let (_, mut client) = handshake(&credential);
        assert!(client.request(&vec![0; MAX_BODY + 1]).is_err());
    }
    #[test]
    fn stream_roundtrip_and_message_limit() {
        let credential = Credential::generate("ui", Access::Controller).unwrap();
        let (mut server, mut client) = handshake(&credential);
        let mut wire = Vec::new();
        write_frame(&mut wire, &client.request(b"request").unwrap()).unwrap();
        assert_eq!(
            server.open(&read_frame(&mut &wire[..]).unwrap()).unwrap(),
            b"request"
        );
        assert_eq!(
            client.response(&server.seal(b"reply").unwrap()).unwrap(),
            b"reply"
        );
        client.channel.sent = MAX_MESSAGES;
        assert!(client.request(b"{}").is_err());
    }
}
