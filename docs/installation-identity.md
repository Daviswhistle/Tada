# CORE-05: persistent installation identity and native discovery

This is a trusted-host library integration on top of CORE-04. The preserved design §18.3 requires an installation secret; §27.1 forbids silently falling back to plaintext when a secret service is unavailable. The new `crates/credential` module implements this boundary without changing existing task contracts, control commands, store schema or the supplied design. CORE-05 is an implementation substep, not a new product requirement.

## Public lifecycle

`Installation::initialize(new_identity_directory, &audited_task_store)` explicitly enrolls a new installation. The destination must be new and absolute. `Installation::finish_initialization(directory, &audited_task_store)` explicitly resumes an interrupted enrollment. `Installation::load(directory)` only loads an already active installation; it never enrolls, repairs or unlocks one. The caller selects this product's identity directory, not a provider account or an arbitrary vault item.

The blocking methods belong in startup or a blocking worker, outside the task-store mutex. `load` may open SQLite for its documented WAL/integrity handling; “load only” means that it does not create or change identity/key material, not that no filesystem bookkeeping can occur.

The installation metadata has one random 128-bit installation ID and the existing audited task-store ID. A different task store cannot silently adopt it. The fixed binary OS-vault record is 100 bytes: a four-byte format marker, the two 32-byte ASCII IDs and a random 256-bit local control key. IDs and a SHA-256 commitment are stored in the private metadata DB; key bytes and the full binary secret are not.

| Phase | Persisted knowledge | Allowed recovery |
| --- | --- | --- |
| RESERVED, no OS record | Installation/store IDs have been reserved | Explicit finish may create and reread its unique OS record |
| RESERVED, OS record exists | Vault write may have committed before the reply/local activation | Verify the existing record, then activate; never overwrite it |
| ACTIVE | Record was reread, bound to IDs and committed by digest | Load exactly that record; missing/changed key is an error |

An OS vault and SQLite do not share an atomic transaction. Enrollment orders ID reservation before vault creation and vault reread before activation. A crash before the reservation transaction commits can leave an incomplete new directory; it is not silently reused or guessed into a valid installation. After reservation, explicit finish checks the surviving OS record. A missing ACTIVE secret never creates a replacement. A successful OS write followed by a lost response is resolved by lookup, not a second blind write. Concurrent enrollment is serialized by an OS file lock. The immutable ACTIVE identity cannot be rewritten by the normal API.

## Native vaults

Linux uses `dbus-secret-service` with an encrypted DH session, exact fixed application/installation attributes, and the default collection. Zero prompt timeout prevents an implicit unlock prompt. Locked, unavailable and ambiguous results are distinct failures. Creation uses `replace=false`; more than one matching item is rejected rather than selecting the first. Search attributes and item labels are metadata, not secrets. No fallback to the session collection, a different application's entry or plaintext storage exists.

Windows uses `CredReadW`/`CredWriteW` for the exact `Tada/local-control/v1/<installation-id>` GENERIC credential in the current user's Credential Manager. `CRED_PERSIST_LOCAL_MACHINE` is the selected per-user persistence class; this does not mean a machine-wide credential shared with other users. Reads verify the binary format and its binding. Creation first checks absence while holding the local enrollment lock. The OS API itself can replace an existing target; the no-overwrite guarantee assumes cooperative Tada enrollment and excludes malicious same-user changes between native calls.

The public library cannot enumerate arbitrary credentials, export a raw key, choose a provider credential target or delete existing user secrets. Installation and vault secrets have no Debug/Serialize implementation. New temporary buffers use `Zeroizing`, and Windows-returned blob memory is cleared before `CredFree`; this is not a proof that every upstream/native/internal copy is zeroized. The existing HMAC protocol authenticates but does not encrypt IPC bodies.

Other platforms return `IDENTITY_UNSUPPORTED_PLATFORM` before creating an identity root. macOS keychain and native transport support remain separate work. A frontend may explicitly choose CORE-04's existing session-only launch mode, but this persistent API does not choose that fallback on the user's behalf.

## Private metadata and discovery

The new identity DB is separate from the task ledger. It uses WAL, synchronous FULL, schema/version checks, integrity checks and a singleton runtime revision. Its contents are installation IDs, digests and authenticated endpoint metadata, not task documents or provider keys. It does not migrate the task DB or modify its backup/witness contract.

Linux roots are current-user-owned 0700 directories checked through held O_NOFOLLOW/O_DIRECTORY handles. Files cannot be symlinks or hardlinks and cannot be writable by another user. Windows creates an explicitly user-owned root with a user-only inheritable full-access DACL and rejects reparse points/hardlinks. Child lock/SQLite files may be owned by that user or the creating process token's exact default-owner SID (TOKEN_OWNER); this accounts for Windows native file creation without accepting an arbitrary foreign owner. Every child must still have exactly one full-access allow ACE for the current user. The root itself must remain user-owned. Held directory/lock handles omit DELETE sharing. Existing directories are never chmodded or given a replacement ACL. Trusted local filesystem ancestry and no hostile same-user namespace replacement remain assumptions; this is not a general arbitrary-path file broker.

`Installation::bind(Arc<Mutex<Store>>)` freshly rereads the OS record, compares the audited store identity, acquires a lifetime daemon lock and binds a fresh native endpoint. Only after binding does it publish endpoint metadata in an atomic SQLite transaction. Each publication has an increasing local revision, a random runtime instance, store ID, installation ID, server PID and supervisor generation. Its exact serialized bytes have a domain-separated HMAC. Every publication uses a new runtime subdirectory/address rather than unlinking a possibly live stale socket.

`tada_credential::connect(identity_directory, limits).await` loads the OS key, checks the live daemon lock and verifies the signed metadata. It permits only the native address derived from that installation/runtime instance. Then CORE-04 checks the kernel peer PID/user and CORE-03 checks the expected store ID and HMAC proof. The new additive `Client::connect_pinned` also compares the authenticated challenge's supervisor generation with discovery. It does not copy trust expectations from an unauthenticated challenge. Old session-only `Client::connect` callers keep their original API and behavior.

The identity lock protects short metadata/enrollment operations; it is separate from the daemon lifetime lock. Socket waits and OS-vault lookup do not hold the task-store mutex. A bound server retains its daemon lock until native serving drains. Offline or stale metadata is a connection error, not authority to launch a daemon, execute a task or create a new key. Reconnection always retains the existing logical request ID and the original control-journal replay semantics.

The last runtime descriptor may remain after exit, but a released daemon lock makes it offline. Leftover run directories from abrupt termination are not recursively deleted; production bounded retention is still needed. Rolling back both the metadata and OS vault together cannot be universally detected from local state alone. Signed discovery is not a remote anti-rollback service. Root/admin/same-user compromise remain outside this boundary.

## Running and testing

Ordinary tests use a private in-memory vault compiled only into the test binary. There is no runtime environment switch or production mock backend. They exercise unchanged identity, no duplicate vault writes, interrupted enrollment, missing/changed keys, vault failures, lock conflicts, invalid roots, immutable metadata, signed-discovery attacks, native replay and generation pinning:

```sh
cargo test --locked -p tada-credential -- --nocapture
```

The **opt-in** native-vault suite writes unique disposable Tada fixture entries into the current user's OS secret store. Run it only in an isolated test account/session. It requires a functioning unlocked Secret Service on Linux or a usable Windows user Credential Manager; missing dependencies fail rather than skip. It never uses provider keys. Exact fixture entries are deleted on cleanup, not other applications' credentials:

```sh
cargo test --locked -p tada-credential --features os-vault-tests os_tests:: -- --nocapture --test-threads=1
```

The native suite tests persisted record roundtrips and missing ACTIVE keys, actual process kills at RESERVED/vault-written/ACTIVE enrollment checkpoints, and a client reconnecting after its distinct server process exits and restarts. The client retains the same installation ID, replays the original submit result and observes CANCELLED with cancellation epoch 1. Checkpoint hooks exist only in unit-test binaries. These are process-exit/kill regression tests, not full OS reboot, physical power-loss or independent security certification.

The Linux CI wrapper starts a separate D-Bus/keyring session and uses disposable XDG storage. Its fixed keyring password is a test fixture, not an application key or production fallback. Windows CI uses uniquely named current-user fixture credentials. Ordinary Linux/Windows suites and macOS unsupported-capability checks remain separate from these native-vault tests. The fixture-count denominator must not be reduced to hide failures.

## Remaining integration

This PR supplies persistent enrollment, load, authenticated discovery and a serving wrapper; it does not install `agentd`, register auto-start, render a settings UI or schedule tasks. A trusted launcher still chooses the identity directory and task store. Human-friendly discovery paths, migration/recovery UX, storage retention, key rotation and durable live revocation need explicit follow-through.

Deleting the OS record blocks new load/bind/reconnect. It does not instantly revoke a key already cached inside a running server/client session; CORE-03's in-memory session revocation remains a separate mechanism. Do not claim the stored key has become a worker grant or provider token. No model call, external tool, paid fallback, artifact completion or task execution permission is introduced.

References checked 2026-10-02: [dbus-secret-service 4.1.0](https://docs.rs/dbus-secret-service/4.1.0/dbus_secret_service/), its [prompt timeout](https://docs.rs/dbus-secret-service/4.1.0/dbus_secret_service/struct.SecretService.html#method.connect_with_max_prompt_timeout), [Secret Service specification](https://specifications.freedesktop.org/secret-service-spec/latest/), [CredReadW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credreadw), [CredWriteW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credwritew), [CREDENTIALW persistence](https://learn.microsoft.com/en-us/windows/win32/api/wincred/ns-wincred-credentialw), [GetSecurityInfo](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-getsecurityinfo). They establish external API contracts, not a third-party Tada audit.

Windows ownership reference: [Owner of a New Object](https://learn.microsoft.com/en-us/windows/win32/secauthz/owner-of-a-new-object) and [TOKEN_OWNER](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-token_owner). A native regression checks the actual child-file owner against TOKEN_OWNER and retains the exact user-only DACL checks. This does not request elevation or change the process token.
