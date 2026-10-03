//! Private single-request protocol for the built-in, side-effect-free Rust probe.
//! This is not the TypeScript engine protocol and never carries credentials,
//! executable paths, tool grants, store paths or arbitrary command names.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use tada_store::Error;

pub(crate) const MAX_REQUEST: usize = 262_144;
pub(crate) const MAX_REPLY: usize = 4096;
pub(crate) type Result<T> = std::result::Result<T, Error>;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Request {
    pub format: u8,
    pub nonce: String,
    pub task_id: String,
    pub fence: i64,
    pub contract_json: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Reply {
    pub format: u8,
    pub nonce: String,
    pub task_id: String,
    pub fence: i64,
    pub contract_hash: String,
}
pub(crate) fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub(crate) fn packet(bytes: &[u8], max: usize) -> Result<Vec<u8>> {
    if bytes.is_empty() || bytes.len() > max {
        return Err(Error::Invalid("PROBE_FRAME_LIMIT"));
    }
    let n = u32::try_from(bytes.len()).map_err(|_| Error::Invalid("PROBE_FRAME_LIMIT"))?;
    let mut output = Vec::with_capacity(4 + bytes.len());
    output.extend_from_slice(&n.to_be_bytes());
    output.extend_from_slice(bytes);
    Ok(output)
}
pub(crate) fn read_packet(reader: &mut impl Read, max: usize) -> Result<Vec<u8>> {
    let mut header = [0; 4];
    reader.read_exact(&mut header)?;
    let n = u32::from_be_bytes(header) as usize;
    if n == 0 || n > max {
        return Err(Error::Invalid("PROBE_FRAME_LIMIT"));
    }
    let mut body = vec![0; n];
    reader.read_exact(&mut body)?;
    let mut extra = [0; 1];
    if reader.read(&mut extra)? != 0 {
        return Err(Error::Invalid("PROBE_TRAILING_DATA"));
    }
    Ok(body)
}
impl Request {
    pub(crate) fn reply(&self) -> Result<Reply> {
        if self.format != 1
            || self.fence <= 0
            || self.nonce.len() != 32
            || !self
                .nonce
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(Error::Invalid("PROBE_REQUEST_BINDING"));
        }
        let value: serde_json::Value = serde_json::from_str(&self.contract_json)?;
        let contract: tada_contracts::TaskContract =
            tada_contracts::decode(&value).map_err(|_| Error::Invalid("PROBE_CONTRACT"))?;
        if contract.task_id != self.task_id {
            return Err(Error::Invalid("PROBE_TASK_BINDING"));
        }
        Ok(Reply {
            format: 1,
            nonce: self.nonce.clone(),
            task_id: self.task_id.clone(),
            fence: self.fence,
            contract_hash: hash(self.contract_json.as_bytes()),
        })
    }
    pub(crate) fn check_reply(&self, bytes: &[u8], expected_hash: &str) -> Result<()> {
        let reply: Reply =
            serde_json::from_slice(bytes).map_err(|_| Error::Invalid("PROBE_REPLY_JSON"))?;
        if reply.format != 1
            || reply.nonce != self.nonce
            || reply.task_id != self.task_id
            || reply.fence != self.fence
            || reply.contract_hash != expected_hash
        {
            return Err(Error::Invalid("PROBE_REPLY_BINDING"));
        }
        Ok(())
    }
}
/// Entry point used only by the fixed worker branch of the executable. It runs
/// before constructing a Tokio runtime and does not spawn threads or children.
pub fn worker_stdio(mode: &str) -> Result<()> {
    if mode != "normal" && !cfg!(feature = "process-fixtures") {
        return Err(Error::Invalid("PROBE_FIXTURE_DISABLED"));
    }
    let input = read_packet(&mut std::io::stdin().lock(), MAX_REQUEST)?;
    let request: Request =
        serde_json::from_slice(&input).map_err(|_| Error::Invalid("PROBE_REQUEST_JSON"))?;
    let reply = request.reply()?;
    #[cfg(feature = "process-fixtures")]
    if mode != "normal" {
        return fixture(mode, reply);
    }
    let output = packet(&serde_json::to_vec(&reply)?, MAX_REPLY)?;
    let mut stdout = std::io::stdout().lock();
    stdout.write_all(&output)?;
    stdout.flush()?;
    Ok(())
}
#[cfg(feature = "process-fixtures")]
fn fixture(mode: &str, mut reply: Reply) -> Result<()> {
    match mode {
        "hang" => loop {
            std::thread::park();
        },
        "empty" => return Ok(()),
        "exit-error" => return Err(Error::Invalid("PROBE_FIXTURE_EXIT")),
        "wrong-hash" => reply.contract_hash = "0".repeat(64),
        "wrong-nonce" => reply.nonce = "0".repeat(32),
        "wrong-task" => reply.task_id.push_str("-other"),
        "wrong-fence" => reply.fence += 1,
        "stdout-flood" => {
            std::io::stdout().write_all(&[255; 4])?;
            // Make the malformed frame observable before the worker parks.
            std::io::stdout().flush()?;
            loop {
                std::thread::park();
            }
        }
        "stderr-flood" => {
            std::io::stderr().write_all(&[b'x'; MAX_REPLY + 1])?;
            std::io::stderr().flush()?;
            loop {
                std::thread::park();
            }
        }
        "partial" => {
            std::io::stdout().write_all(&[0, 0, 0, 100, b'{'])?;
            return Ok(());
        }
        "duplicate" => {
            std::io::stdout().write_all(&packet(b"{\"format\":1,\"format\":1}", MAX_REPLY)?)?;
            return Ok(());
        }
        "trailing" => {
            let mut bytes = packet(&serde_json::to_vec(&reply)?, MAX_REPLY)?;
            bytes.push(0);
            std::io::stdout().write_all(&bytes)?;
            return Ok(());
        }
        "reply-hang" => {
            std::io::stdout().write_all(&packet(&serde_json::to_vec(&reply)?, MAX_REPLY)?)?;
            std::io::stdout().flush()?;
            loop {
                std::thread::park();
            }
        }
        "env-canary" => {
            for name in [
                "TADA_SECRET_CANARY",
                "OPENAI_API_KEY",
                "NODE_OPTIONS",
                "PYTHONPATH",
            ] {
                if std::env::var_os(name).is_some() {
                    return Err(Error::Invalid("PROBE_ENV_LEAK"));
                }
            }
        }
        #[cfg(windows)]
        "spawn-child" => {
            let attempt = std::process::Command::new(std::env::current_exe()?)
                .arg("--probe-worker")
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn();
            if let Ok(mut child) = attempt {
                let _ = child.kill();
                let _ = child.wait();
                return Err(Error::Invalid("PROBE_JOB_CHILD_ALLOWED"));
            }
        }
        _ => return Err(Error::Invalid("PROBE_FIXTURE_UNKNOWN")),
    }
    std::io::stdout().write_all(&packet(&serde_json::to_vec(&reply)?, MAX_REPLY)?)?;
    std::io::stdout().flush()?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frames_require_one_complete_bounded_message() {
        assert!(packet(b"", MAX_REPLY).is_err());
        for bytes in [
            vec![255; 4],
            vec![0; 4],
            vec![0, 0, 0, 2, b'x'],
            vec![0, 0, 0, 1, b'x', b'y'],
        ] {
            assert!(read_packet(&mut bytes.as_slice(), MAX_REPLY).is_err());
        }
        assert_eq!(
            read_packet(&mut packet(b"ok", MAX_REPLY).unwrap().as_slice(), MAX_REPLY).unwrap(),
            b"ok"
        );
    }
    #[test]
    fn reply_rejects_duplicate_unknown_and_cross_assignment_fields() {
        let request = Request {
            format: 1,
            nonce: "a".repeat(32),
            task_id: "task".into(),
            fence: 1,
            contract_json: "{}".into(),
        };
        let reply = Reply {
            format: 1,
            nonce: request.nonce.clone(),
            task_id: "task".into(),
            fence: 1,
            contract_hash: "b".repeat(64),
        };
        let value = serde_json::to_value(reply).unwrap();
        assert!(request
            .check_reply(&serde_json::to_vec(&value).unwrap(), &"b".repeat(64))
            .is_ok());
        for (key, wrong) in [
            ("format", serde_json::json!(2)),
            ("nonce", serde_json::json!("wrong")),
            ("task_id", serde_json::json!("other")),
            ("fence", serde_json::json!(2)),
            ("contract_hash", serde_json::json!("wrong")),
            ("success", serde_json::json!(true)),
        ] {
            let mut bad = value.clone();
            bad[key] = wrong;
            assert!(request
                .check_reply(&serde_json::to_vec(&bad).unwrap(), &"b".repeat(64))
                .is_err());
        }
        assert!(request
            .check_reply(b"{\"format\":1,\"format\":1}", &"b".repeat(64))
            .is_err());
    }
}
