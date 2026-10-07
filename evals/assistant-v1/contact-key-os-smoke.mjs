// Explicit native storage check. Only disposable Tada-owned data; no provider login.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { contactStorageKey } from '../../packages/engine/src/contact-key.mjs';
import { ContactStore, contactRoute } from '../../packages/engine/src/contact-store.mjs';

const root = mkdtempSync(join(tmpdir(), 'tada-os-key-'));
const options = { data: join(root, 'contact'), profile: join(root, 'profile') };
let store;
try {
  const key = await contactStorageKey({ ...options, initialize: true });
  const route = contactRoute({ fixture: 'os-key' });
  store = new ContactStore({ directory: options.data, passphrase: key, route, initialize: true });
  const identity = store.id; store.close();
  const restored = await contactStorageKey(options);
  assert.equal(restored, key);
  store = new ContactStore({ directory: options.data, passphrase: restored, route });
  assert.equal(store.id, identity);
  const disk = readFileSync(join(options.profile, 'storage-key.sqlite'));
  assert.equal(disk.includes(Buffer.from(key)), false);
  assert.equal(disk.includes(Buffer.from(key, 'base64url')), false);
  const child = `import {createHash} from 'node:crypto';
    import {contactStorageKey} from ${JSON.stringify(new URL('../../packages/engine/src/contact-key.mjs', import.meta.url).href)};
    const key=await contactStorageKey(${JSON.stringify(options)});
    process.stdout.write(createHash('sha256').update(key).digest('hex'));`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', child], { timeout: 20000, maxBuffer: 8192 });
  assert.equal(stdout, createHash('sha256').update(key).digest('hex'));
  console.log(JSON.stringify({ kind: 'actual_windows_current_user_storage', platform: process.platform,
    protected_key_persisted: true, plaintext_key_absent: true, conversation_reopened: true,
    separate_process_unlocked: true, extra_password_requested: false, provider_account_used: false, physical_reboot: false }));
} finally { store?.close(); rmSync(root, { recursive: true, force: true }); }
