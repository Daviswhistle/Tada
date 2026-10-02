# CORE-04: native local control transport

Status: developer transport integration on top of CORE-03. The original design §18.3 calls for local sockets/pipes, peer checks, nonce authentication and durable request identity. This implementation binds that existing protocol to Linux and Windows OS transports. It does not change the preserved design, existing wire definitions, authority model or SQLite schema. CORE-04 is a substep label, not a replacement for the original work breakdown.

## What can now run

`tada-local-ipc` supplies a listener, single-flight client and bounded server loop. The same four CORE-03 commands travel over native IPC: task.submit, task.cancel, task.get and task.events. A credential is provided by the trusted host; no received message can provision one. The server does not expose a tool dispatcher, policy editor, grant issuer, SQL, credential export or shell.

The developer binary creates a disposable mock-data store, listens in its parent process, and launches a separate client process:

```sh
cargo run --locked -p tada-local-ipc --bin tada-ipc-demo -- ./new-native-demo
```

The directory must not already exist. The parent and child authenticate, submit, disconnect, reconnect, replay and cancel. The parent independently checks the final cancellation epoch and scans both closed SQLite fixture files for the raw transferred secret. Both processes exit; no service, scheduled task, login hook, TCP listener or deployment is installed. The directory retains only disposable fixture data, not a production user vault.

The native endpoint capability is enabled only on Linux and Windows. On other OSes, the crate remains buildable but binding, connecting and runtime-directory provisioning return `IPC_UNSUPPORTED_PLATFORM`. macOS portability CI compiles the workspace and tests this explicit rejection; it does not qualify a macOS socket or desktop bridge.

## Linux boundary

The runtime directory must already be an absolute, current-user-owned directory with mode 0700. It is opened with O_DIRECTORY/O_NOFOLLOW/O_CLOEXEC and checked against its named identity. `create_runtime_dir` creates a new private directory; it does not repair or chmod an existing one. The socket is `control.sock` inside that directory. Binding an occupied file, socket or symlink fails rather than unlinking it to claim the address.

The parent directory protects the socket during creation; its final mode is 0600. The server checks the connecting peer's kernel UID. The client checks peer UID and the launcher-supplied server PID before beginning HMAC authentication, as well as socket and runtime-directory identities. Teardown removes only the socket inode the listener owns, and only while the named runtime directory still matches its held directory. It preserves a replacement file/socket instead of deleting somebody else's object. An unclean process exit can leave a socket: launch in a new private runtime directory rather than guessing that an existing socket is stale.

The selected runtime directory and its ancestors must be trusted, on a local filesystem, and must not be relocated while running. These checks are not protection against malicious same-UID namespace replacement, a compromised host, hostile mounts or an administrator. There is no general arbitrary-path file broker in this crate.

## Windows boundary

The pipe namespace is exactly `\\.\pipe\Tada-core04-<32 hex digits>`; remote hosts, alternate prefixes and arbitrary suffixes are rejected by the client. The server builds a protected, explicit DACL with one allow ACE for the current user's SID. It does not use the Windows default pipe DACL. The first instance requires FILE_FLAG_FIRST_PIPE_INSTANCE, every instance rejects remote clients, and pipe handles are noninheritable.

The accept loop creates its next pending pipe before transferring the connected instance to a session. At least one owned instance therefore spans handoffs; it does not intentionally create a namespace gap between clients. The OS instance ceiling is 34, covering the configurable maximum of 32 live sessions, a pending instance and a just-accepted instance being rejected. The public connection limit defaults to 8.

Before the application handshake, each side queries the peer PID from the connected pipe handle and verifies the primary process-token SID against the current user. The client additionally compares the server PID with trusted bootstrap metadata. Inability to query a peer is rejection, not a fallback. Client connections specify SECURITY_IDENTIFICATION with SECURITY_SQOS_PRESENT, so a fake server is not given ordinary impersonation-level access. No async code runs while impersonating a client; this implementation never calls an impersonation API.

The DACL deliberately defines a single-user boundary, not isolation between processes with the same SID. Peer PID/token checks supplement the DACL; HMAC and the expected store ID remain required, rather than treating a matching PID alone as an authenticated application. The Windows CI tests inspect the constructed DACL, refuse a colliding first instance, reject mismatched expected SID/PID and exercise actual named-pipe communication. A hostile second-login SID, SMB access from another machine and Windows 11 desktop/packaging scenarios are not qualified by those tests.

## Bootstrap and secrets

This slice implements **session-only launch bootstrap**, not a persistent installation key store. The developer parent obtains 32 random bytes from the OS and supplies the child's copy through the anonymous stdin pipe created exclusively for that child. Only nonsecret endpoint/store-ID/server-PID metadata is passed in arguments. The child requires exactly 32 bytes and EOF. Both sides instantiate CORE-03 credentials from that key; plaintext keys are never put into argv, environment variables, RPC JSON, public files, the database or logs.

The example's parent is the trust root and starts its own known executable. The child validates the expected store ID and server PID learned from that launcher; it does not copy these expectations out of the server's unauthenticated challenge. No other application's tokens or cookies are accessed. The credential is not a model/provider credential and cannot authenticate to an external account.

Production packaging still needs OS-secret-store provisioning and recovery, protected stable discovery, key lifetime/rotation and persistent revocation. No plaintext-file fallback is silently substituted. A host may supply an already protected credential to the library, but that does not mean such a keychain integration has been implemented or tested here. Best-effort buffer clearing in the demo is not a memory-zeroization, forward-secrecy or confidentiality guarantee. HMAC authenticates the existing protocol; it does not encrypt message bodies.

## Scheduling, deadlines and resource limits

The native event loop uses Tokio with only the required features. The server admits at most the configured number of connection tasks, default 8 and allowed range 1–32. A full server drops extra connections without allocating an application session or waiting on the store. That bounds user-space connection tasks, not every kernel backlog resource and not denial of service by a malicious same-user process.

A single absolute timeout covers each whole handshake and each complete frame read/write. The default is 5 seconds for each; handshake limits cannot exceed the protocol's 10 seconds and frame limits cannot exceed 30 seconds. A sender delivering one byte at a time cannot reset the frame deadline indefinitely. Handshake packets are at most 2,048 bytes. Authenticated frames reuse CORE-03's 65,536-byte body bound, sequence numbers and directional MACs, with the length validated before allocation.

No socket read/write holds the store mutex. Command handling runs on bounded-by-session blocking jobs. Slow handshakes and partial frames therefore do not occupy the SQLite owner while another admitted client cancels. With spare capacity, this behavior is covered by a real native-transport regression. Filling every connection slot can delay a new frontend connection until expiry; this is not a blanket denial-of-service guarantee or the design's p95 250ms cancellation qualification. There is no cancellation-priority queue yet.

Shutdown must use the provided watch signal: it stops accepting new work, interrupts idle network waits, rechecks stop at command admission and drains already entered store commands. A client timeout is an unknown reply-delivery outcome, not proof the command rolled back. The client closes its logical session after any I/O/authentication/deadline error, then reconnects using the same logical request_id. The original command receipt decides replay. The server does not abort a blocking SQLite commit and declare it cancelled.

Disk transactions can still wait on the OS; a physically hung disk is not bounded by the socket deadline. Directly aborting the server future or killing the process is not graceful drain, and must use the existing journal/witness recovery semantics on restart. No claim of universal exactly-once external effects is added.

## Regression coverage

Shared native tests cover submit/cancel replay and changed-payload rejection; dropping a real transport reply then reopening the store; wrong key/store ID/server PID; observer permissions and credential revocation; a stalled handshake alongside another client's cancellation; a trickled partial authenticated frame; connection saturation and slot release; oversized and tampered frames; shutdown of idle connections; a timed-out client whose already queued command subsequently commits; framing bounds; and secret-safe diagnostics.

Linux-specific cases inspect directory/socket modes, refuse occupied and symlink paths without changing them, preserve replacement objects during cleanup and check kernel peer PID. Windows-specific cases inspect the explicit SID DACL, first-instance collision and local-only address rules, and SID/PID predicates. An integration test launches the developer binary (which launches its distinct client process), checks the verified result and confirms an existing directory is refused without altering its database.

CORE-01/02/03 suites remain enabled, including the 98 shared contract fixtures, thirteen existing process-kill scenarios and sixteen cancellation/admission races. The new native tests are not additional physical power-loss tests, a second-user attack qualification or an independent security review. Report the actual commit, CI operating systems and test counts; do not present staging/formatting as validation.

## Follow-through

Protected persistent installation identity/discovery and OS key storage are the next remaining IPC packaging boundary. Supervisor installation, a durable queue and priority handling, worker-scoped SEC-01 grants, indexed request retention/migrations, encrypted real-user data, provider adapters, ART-01 publication and UI remain separate. The demo stays opt-in and mock-only. Do not turn its Controller credential into a model-worker capability or enable live external tools because a native IPC test passes.

API references checked 2026-10-02: [Tokio 1.53.1 ServerOptions](https://docs.rs/tokio/1.53.1/tokio/net/windows/named_pipe/struct.ServerOptions.html), [ClientOptions](https://docs.rs/tokio/1.53.1/tokio/net/windows/named_pipe/struct.ClientOptions.html), [UnixStream peer credentials](https://docs.rs/tokio/1.53.1/tokio/net/struct.UnixStream.html), [Windows named pipe security](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights), [Windows CreateFile security QoS](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilea), [windows-sys 0.61.2](https://docs.rs/windows-sys/0.61.2/windows_sys/). API references explain implementation choices, not a security certification.
