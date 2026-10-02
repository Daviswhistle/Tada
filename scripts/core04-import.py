"""Finalize capability boundaries and public documentation; remove after use."""
from pathlib import Path

def replace_file(path, pairs):
    p = Path(path)
    s = p.read_text()
    for old, new in pairs:
        assert s.count(old) == 1, (path, old)
        s = s.replace(old, new)
    p.write_text(s)

replace_file('crates/local-ipc/src/lib.rs', [
    ('compile_error!("tada-local-ipc currently qualifies Linux and Windows only");', '#[path = "unsupported.rs"]\nmod platform;'),
    ('    InvalidHandshake,\n}', '    InvalidHandshake,\n    UnsupportedPlatform,\n}'),
    ('            Self::InvalidHandshake => "IPC_HANDSHAKE_REJECTED",', '            Self::InvalidHandshake => "IPC_HANDSHAKE_REJECTED",\n            Self::UnsupportedPlatform => "IPC_UNSUPPORTED_PLATFORM",'),
    ('    std::fs::create_dir(path)?;\n    Ok(())\n}', '    std::fs::create_dir(path)?;\n    #[cfg(any(target_os = "linux", windows))]\n    { Ok(()) }\n    #[cfg(not(any(target_os = "linux", windows)))]\n    { let _ = path; Err(Error::UnsupportedPlatform) }\n}'),
    ('#[cfg(test)]\nmod tests;', '#[cfg(all(test, any(target_os = "linux", windows)))]\nmod tests;'),
])
p = Path('crates/local-ipc/tests/process.rs')
p.write_text('#![cfg(any(target_os = "linux", windows))]\n\n' + p.read_text())
replace_file('README.md', [
    ('## Current status: contracts, durable mock core and control protocol, not a working agent', '## Current status: durable mock core with native local control'),
    ('A transport-neutral control protocol adds authenticated sessions and durable request replay. **There is no desktop application, installed daemon, native IPC listener, model login or browser control yet.** Protocol and mock recovery tests do not establish native IPC protection, real-provider safety or the design\'s release gates.', 'The control protocol now connects real frontend processes through Linux Unix-domain sockets and Windows named pipes, with OS peer checks, authenticated sessions and durable request replay. **There is no desktop UI, installed daemon, persistent credential store, model login or browser control yet.** Native transport and mock recovery have their own regression tests; real-provider safety and the design\'s release gates remain separate.'),
    ('and [control protocol decisions](docs/control-protocol.md) distinguish', '[control protocol decisions](docs/control-protocol.md), and [native IPC boundaries](docs/native-ipc.md) distinguish'),
    ('Both destinations must not already exist; only mock data is written.', 'Both destinations must not already exist; only mock data is written.\n\nOn Linux or Windows, run the separate-process native IPC demonstration:\n\n```sh\ncargo run --locked -p tada-local-ipc --bin tada-ipc-demo -- ./new-native-demo\n```\n\nThe parent opens the fixture store and native listener, then transfers an ephemeral credential to its own client child through an anonymous pipe. The child authenticates, disconnects, reconnects and replays submit/cancel. No key is saved to disk, passed in argv/environment, or sent through RPC. The new directory must not exist. Both processes exit when verification finishes; nothing is installed.\n\nThe native listener is available only on Linux/Windows in this slice. Other OS builds return `IPC_UNSUPPORTED_PLATFORM` before creating an endpoint, instead of breaking the portable workspace or pretending to offer peer-verified IPC. macOS native transport and credential integration remain unimplemented.'),
    ('| `fixtures/contracts/v1/`', '| `crates/local-ipc/` | Native socket/pipe peers, bounded I/O and sessions, graceful drain, and opt-in cross-process fixture demo |\n| `fixtures/contracts/v1/`'),
    ('native local IPC with OS peer checks and protected credential bootstrap, scheduled work', 'persistent installation identity/discovery and OS-secret-store bootstrap, scheduled work'),
])
replace_file('docs/roadmap.md', [
    ('Remaining CORE-02 integration: authenticated local IPC and request deduplication, installed supervisor and scheduled queue', 'Remaining CORE-02 integration: persistent installation identity and OS-secret-store bootstrap, installed supervisor and scheduled queue'),
    ('## Provider proof — separate gate', '## CORE 03 / CORE 04 — control integration substeps\n\n[CORE-03](control-protocol.md) supplies authenticated bounded commands and atomic logical request replay. [CORE-04](native-ipc.md) binds them to Linux Unix sockets and Windows named pipes, with peer identity checks, absolute I/O deadlines, bounded sessions and a separate-process fixture. Existing task/action contracts and the database schema remain unchanged. Session-only key transfer is implemented through an inherited anonymous pipe; durable OS-secret-store provisioning, safe discovery and rotation remain separate. Unsupported OSes reject native endpoint creation explicitly while allowing the portable workspace to compile.\n\nThese substep names do not replace the original work breakdown or complete stage 1. Native transport tests do not qualify a full SEC-01 worker broker, a scheduler, live provider access or an independent security review.\n\n## Provider proof — separate gate'),
])
replace_file('docs/native-ipc.md', [
    ('## Linux boundary', 'The native endpoint capability is enabled only on Linux and Windows. On other OSes, the crate remains buildable but binding, connecting and runtime-directory provisioning return `IPC_UNSUPPORTED_PLATFORM`. macOS portability CI compiles the workspace and tests this explicit rejection; it does not qualify a macOS socket or desktop bridge.\n\n## Linux boundary'),
])
replace_file('.github/workflows/ci.yml', [
    ('      - name: Reject uncommitted generated changes', '      - name: Run two-process native IPC example\n        run: cargo run --locked -p tada-local-ipc --bin tada-ipc-demo -- "${{ runner.temp }}/tada-core04-demo"\n      - name: Reject uncommitted generated changes'),
])
p = Path('.github/workflows/ci.yml')
p.write_text(p.read_text() + '''  portability:
    name: Core portability (macOS; native IPC disabled)
    runs-on: macos-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
        with:
          persist-credentials: false
      - name: Install pinned Rust
        run: rustup toolchain install 1.98.1 --profile minimal --component rustfmt --component clippy
      - name: Check workspace formatting and portability
        run: |
          cargo fmt --all -- --check
          cargo clippy --workspace --all-targets --locked -- -D warnings
      - name: Unsupported native transport rejects before side effects
        run: cargo test --locked -p tada-local-ipc --lib -- --nocapture
      - name: Reject uncommitted changes
        run: git diff --exit-code
''')
Path(__file__).unlink()
