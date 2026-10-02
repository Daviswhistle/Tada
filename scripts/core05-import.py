"""Exact staged integration edits, removed after successful preparation."""
from pathlib import Path
p = Path('crates/local-ipc/src/lib.rs')
s = p.read_text()
old = '''    ) -> Result<Self> {
        let limits = limits.validate()?;
        if info.server_pid == 0 {'''
new = '''    ) -> Result<Self> {
        Self::connect_inner(info, credential, limits, None).await
    }
    /// Pin a supervisor generation obtained from authenticated installation
    /// discovery. Existing session-only launch callers can still use connect.
    pub async fn connect_pinned(
        info: &ConnectInfo,
        credential: &Credential,
        limits: Limits,
        generation: i64,
    ) -> Result<Self> {
        if generation <= 0 { return Err(Error::PeerRejected); }
        Self::connect_inner(info, credential, limits, Some(generation)).await
    }
    async fn connect_inner(
        info: &ConnectInfo,
        credential: &Credential,
        limits: Limits,
        expected_generation: Option<i64>,
    ) -> Result<Self> {
        let limits = limits.validate()?;
        if info.server_pid == 0 {'''
assert s.count(old) == 1
s = s.replace(old,new)
old = '            let challenge: Challenge = read_handshake(&mut stream).await?;'
new = old + '\n            if expected_generation.is_some_and(|expected| expected != challenge.generation) { return Err(Error::PeerRejected); }'
assert s.count(old) == 1
p.write_text(s.replace(old,new))
p = Path('crates/credential/src/lib.rs')
s = p.read_text()
old = '        Root::create(&runtime)?;\n        let listener='
new = '        Root::create(&runtime)?;\n        let runtime_guard=RuntimeDir(runtime.clone());\n        let listener='
assert s.count(old) == 1
s = s.replace(old,new)
assert s.count('_runtime:RuntimeDir(runtime)') == 1
s = s.replace('_runtime:RuntimeDir(runtime)', '_runtime:runtime_guard')
p.write_text(s)
p = Path('crates/credential/src/vault.rs')
s=p.read_text()
old = 'SecretService::connect(EncryptionType::Dh)'
assert s.count(old) == 1
p.write_text(s.replace(old,'SecretService::connect_with_max_prompt_timeout(EncryptionType::Dh,0)'))
Path(__file__).unlink()
