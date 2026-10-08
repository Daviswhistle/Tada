import { TelegramAPI } from './telegram-api.mjs';
import { TelegramContact } from './telegram-contact.mjs';

// Browser setup uses the existing private Telegram adapter and encrypted journal.
// Neither the credential nor Telegram identity enters model context or API state.
export class MobileContact {
  #store; #service; #makeAPI; #contact; #pending = new Map(); #link = null; #busy = false; #closed = false; #error = null;
  constructor(store, service, makeAPI = token => new TelegramAPI(token)) {
    this.#store = store; this.#service = service; this.#makeAPI = makeAPI;
  }
  #authorize(device) {
    this.#store.assertDevice(device);
    if (this.#closed || this.#busy) throw Error('CONTACT_MOBILE_BUSY');
  }
  async #open(token, assertAuthority = () => {}) {
    const contact = new TelegramContact(this.#store, this.#service, this.#makeAPI(token));
    this.#contact = contact;
    try {
      await contact.initialize(assertAuthority);
      if (this.#closed) throw Error('CONTACT_MOBILE_CLOSED');
      contact.on('pairing', ({ candidate, user }) => {
        this.#pending.set(candidate, { candidate, user, expires: Date.now() + 5 * 60000 });
        this.#service.emit('change');
      });
      contact.on('status', () => this.#service.emit('change'));
      return contact;
    } catch (error) { await contact.close(); this.#contact = null; throw error; }
  }
  async restore() {
    const saved = this.#store.mobileCredential();
    if (!saved) return;
    try { const contact = await this.#open(saved.token); contact.start(); }
    catch { this.#error = 'CONTACT_MOBILE_RECONNECT'; }
  }
  async reconnect(device) {
    this.#authorize(device);
    const saved = this.#store.mobileCredential();
    if (!saved) throw Error('CONTACT_MOBILE_RECONNECT');
    return this.connect(device, saved.token, 'private_telegram_contact_v1');
  }
  async connect(device, token, consent) {
    this.#authorize(device);
    if (consent !== 'private_telegram_contact_v1') throw Error('CONTACT_TELEGRAM_CONSENT_REQUIRED');
    this.#busy = true;
    try {
      await this.#contact?.close(); this.#contact = null; this.#pending.clear(); this.#link = null;
      const contact = await this.#open(token, () => this.#store.assertDevice(device));
      this.#store.assertDevice(device);
      this.#store.saveMobileCredential(device, token);
      this.#error = null; contact.start(); this.#service.emit('change'); return this.status();
    } catch (error) {
      await this.#contact?.close(); this.#contact = null;
      this.#error = 'CONTACT_MOBILE_RECONNECT'; throw error;
    } finally { this.#busy = false; }
  }
  pair(device) {
    this.#authorize(device);
    if (!this.#contact) throw Error('CONTACT_MOBILE_RECONNECT');
    if (!this.#link || this.#link.expires <= Date.now()) this.#link = { url: this.#contact.pair(), expires: Date.now() + 5 * 60000 };
    return this.#link;
  }
  approve(device, candidate) {
    this.#authorize(device);
    if (!this.#contact) throw Error('CONTACT_MOBILE_RECONNECT');
    this.#contact.approve(candidate); this.#pending.clear(); this.#link = null; return this.status();
  }
  async disconnect(device) {
    this.#authorize(device); this.#busy = true;
    try {
      // Persist revocation before awaiting network shutdown.
      this.#store.saveMobileCredential(device, null);
      const binding = this.#store.telegramBinding();
      if (binding?.live) this.#service.revoke(binding.device);
      await this.#contact?.close(); this.#contact = null; this.#pending.clear(); this.#link = null; this.#error = null;
      this.#service.emit('change'); return this.status();
    } finally { this.#busy = false; }
  }
  status() {
    for (const [id, value] of this.#pending) if (value.expires <= Date.now()) this.#pending.delete(id);
    return { available: this.#store.contactVersion >= 5, enabled: !!this.#contact,
      configured: !!this.#store.mobileCredential(), error: this.#error,
      ...(this.#contact ? this.#contact.status() : this.#store.messagingStatus()), candidates: [...this.#pending.values()] };
  }
  async close() { this.#closed = true; await this.#contact?.close(); this.#contact = null; this.#pending.clear(); this.#link = null; }
}
