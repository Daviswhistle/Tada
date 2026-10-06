// A contact channel into the SAME host service and conversation, not a second
// model loop. Only host-approved private Telegram identity may submit work.
import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';

const hash = value => createHash('sha256').update(value).digest('hex');
const id = value => Number.isSafeInteger(value) && value > 0 && value < 2 ** 52;
const safe = error => /^CONTACT_[A-Z_]{1,64}$/u.test(error?.message) ? error.message : 'CONTACT_TELEGRAM_FAILED';
export class TelegramContact extends EventEmitter {
  #store; #service; #api; #bot; #codes = new Map(); #candidates = new Map(); #abort = new AbortController();
  #polling; #sending; #closed = false; #online = false; #nextSend = 0; #lastError = null; #pairWindow = 0; #pairCount = 0; #suspended = false; #pollActive = false;
  constructor(store, service, api) { super(); this.#store = store; this.#service = service; this.#api = api; }
  async initialize() {
    if (this.#closed || this.#bot) throw new Error('CONTACT_TELEGRAM_ALREADY_STARTED');
    if (this.#store.contactVersion < 2) throw new Error('CONTACT_MESSAGING_UPGRADE_REQUIRED');
    const bot = await this.#api.inspect(this.#abort.signal);
    this.#store.telegramConfigure(bot.id); this.#bot = bot;
    return bot;
  }
  pair() {
    if (!this.#bot || this.#closed || this.#suspended) throw new Error('CONTACT_TELEGRAM_NOT_INSPECTED');
    if (this.#store.telegramBinding()?.live) throw new Error('CONTACT_TELEGRAM_ALREADY_PAIRED');
    this.#prune();
    if (this.#codes.size >= 4) throw new Error('CONTACT_PAIR_LIMIT');
    const code = randomBytes(32).toString('base64url');
    this.#codes.set(hash(code), Date.now() + 5 * 60000);
    return `https://t.me/${this.#bot.username}?start=${code}`;
  }
  #prune() {
    for (const [code, expires] of this.#codes) if (expires <= Date.now()) this.#codes.delete(code);
    for (const [key, value] of this.#candidates) if (value.expires <= Date.now()) this.#candidates.delete(key);
  }
  approve(candidateId) {
    this.#prune();
    const candidate = this.#candidates.get(candidateId);
    if (!candidate || this.#closed) throw new Error('CONTACT_PAIR_REJECTED');
    const device = this.#store.telegramBind({ bot: this.#bot.id, chat: candidate.chat, user: candidate.user, after_message: candidate.message });
    this.#codes.clear(); this.#candidates.clear();
    this.#service.emit('change'); return device;
  }
  async pollOnce() {
    if (this.#closed || this.#suspended || !this.#bot) throw new Error('CONTACT_TELEGRAM_NOT_INSPECTED');
    if (this.#pollActive) throw new Error('CONTACT_TELEGRAM_POLL_BUSY');
    this.#pollActive = true;
    try {
      const updates = await this.#api.updates(this.#store.telegramCursor(), this.#abort.signal);
      for (const update of updates) {
        if (this.#closed || this.#suspended) break;
        this.#receive(update);
        // Admission precedes upstream ACK. If this commit is lost, the stable
        // bot/chat/message key replays the same turn, not another model request.
        this.#store.telegramAdvance(update.update_id);
      }
      this.#online = true; this.#lastError = null;
    } finally { this.#pollActive = false; }
  }
  #receive(update) {
    const message = update.message;
    if (!message || message.chat?.type !== 'private' || !id(message.chat.id)
        || message.from?.is_bot !== false || message.from.id !== message.chat.id || !id(message.message_id)
        || message.sender_chat || message.via_bot || message.business_connection_id
        || message.guest_query_id || message.forward_origin) return;
    const chat = String(message.chat.id), user = String(message.from.id), text = message.text;
    if (typeof text === 'string' && /^\/start [A-Za-z0-9_-]{43}$/u.test(text)) {
      this.#prune();
      if (Date.now() - this.#pairWindow >= 60000) { this.#pairCount = 0; this.#pairWindow = Date.now(); }
      if (++this.#pairCount > 20 || this.#candidates.size >= 4) return;
      const key = hash(text.slice(7));
      if (!this.#codes.has(key)) return;
      this.#codes.delete(key);
      const candidateId = randomUUID();
      this.#candidates.set(candidateId, { chat, user, message: message.message_id, expires: Date.now() + 5 * 60000 });
      // No history, model call, or outbound message before local owner approval.
      this.emit('pairing', { candidate: candidateId, user }); return;
    }
    const binding = this.#store.telegramBinding();
    if (!binding?.live || binding.bot !== this.#bot.id || binding.chat !== chat || binding.user !== user
        || message.message_id <= binding.after_message) return;
    const noteKey = this.#store.telegramRequestId(this.#bot.id, chat, message.message_id);
    if (text === '/stop') { this.#service.revoke(binding.device); return; }
    if (text === '/cancel') {
      const pending = this.#store.telegramCancel(binding.device, noteKey);
      if (pending !== null) this.#service.cancel(pending);
      else this.#store.telegramNote(noteKey, '이 채팅에서 접수한 요청 중 지금 취소할 대기 요청은 없어요.');
      return;
    }
    if (typeof text !== 'string' || !text.trim()) {
      this.#store.telegramNote(noteKey, '아직 이 연락 경로에서는 텍스트만 읽을 수 있어요. 음성·사진·첨부 내용은 읽은 것으로 처리하지 않았어요.'); return;
    }
    const scheduled = /^\/(review|review-cancel) ([a-f0-9-]{36}) ([1-9][0-9]{0,8})$/u.exec(text);
    if (scheduled && this.#store.contactVersion === 4) {
      try {
        const result = scheduled[1] === 'review'
          ? this.#service.armReview(binding.device, scheduled[2], Number(scheduled[3]), 'one_local_read_only_review')
          : this.#service.cancelReview(binding.device, scheduled[2], Number(scheduled[3]));
        this.#store.telegramNote(noteKey, result?.state === 'armed' ? '확정한 업무 버전을 약속한 시각에 한 번 로컬 자료로 확인하고 같은 대화로 결과를 알려드려요. 호스트가 실행 중이어야 합니다.'
          : '이 업무의 현재 자동 확인 상태를 연락 화면에서 확인할 수 있어요. 이미 처리한 예약은 재실행하지 않았어요.');
      } catch (error) {
        if (/^CONTACT_(REVIEW|FOLLOWUP|DEVICE)_/u.test(safe(error))) this.#store.telegramNote(noteKey, '업무 버전·시각·접근권이 바뀌어 적용하지 않았어요. 연락 화면에서 현재 기록을 확인해 주세요.');
        else throw error;
      }
      return;
    }
    const review = /^\/(confirm|dismiss) ([a-f0-9-]{36})$/u.exec(text);
    if (review && this.#store.contactVersion >= 3) {
      try {
        const result = this.#service.confirmFollowup(binding.device, review[2], review[1] === 'confirm' ? 'approve' : 'reject');
        let text = '이 제안은 저장하지 않았어요.';
        if (result.status === 'approved') {
          const item = this.#store.followup(result.commitment);
          text = `${result.replay ? '이 확인은 이미 처리됐어요.' : '확정한 내용을 같은 비서의 맡긴 일에 저장했어요.'} 현재 상태: ${{ open: '챙길 일', waiting: '회신·조건 대기', done: '사용자 확인 완료', cancelled: '취소' }[item.state]}.`;
          if (['open', 'waiting'].includes(item.state) && item.notify_at) text += ` 확인 시각: ${item.notify_at}. 실행 중인 호스트에서 한 번 알려드려요.`;
        }
        if (result.status === 'approved' && this.#store.contactVersion === 4) {
          const item = this.#store.followup(result.commitment);
          if (['open', 'waiting'].includes(item.state) && item.notify_at) text += `\n현재 허용된 로컬 자료와 로컬 모델 최대 8회 호출로 한 번 직접 확인하려면 /review ${item.id} ${item.version}\n메일·웹·파일 수정·타인 연락은 포함되지 않고, 기존 전체 사용 한도를 공유해요. 24시간 넘게 늦으면 실행하지 않아요. 취소: /review-cancel ${item.id} ${item.version}`;
        }
        this.#store.telegramNote(noteKey, text);
      } catch (error) {
        if (/^CONTACT_FOLLOWUP_|^CONTACT_DEVICE_REVOKED$/u.test(safe(error))) this.#store.telegramNote(noteKey, '제안이 변경·만료됐거나 현재 상태와 맞지 않아 적용하지 않았어요. 연락 화면에서 최신 내용을 확인해 주세요.');
        else throw error;
      }
      return;
    }
    if (text.startsWith('/')) {
      this.#store.telegramNote(noteKey, '일은 평소 말하듯 맡겨 주세요. /cancel은 이 채팅의 최근 대기 요청을 취소하고 /stop은 텔레그램 연결을 해제해요.'); return;
    }
    const requestId = this.#store.telegramRequestId(this.#bot.id, chat, message.message_id);
    try { this.#service.submit(binding.device, requestId, text); }
    catch (error) {
      if (['CONTACT_MESSAGE_INVALID','CONTACT_QUEUE_LIMIT','CONTACT_REQUEST_ID_REUSED'].includes(safe(error))) {
        this.#store.telegramNote(noteKey, '이 메시지를 새 요청으로 접수하지 못했어요. 크기·대기 한도 또는 기존 요청과의 충돌을 연락 화면에서 확인해 주세요.');
      } else throw error;
    }
  }
  async deliverOnce(now = Date.now()) {
    if (this.#closed || this.#suspended || !this.#bot || now < this.#nextSend) return false;
    this.#store.telegramQueueResults();
    const delivery = this.#store.telegramClaimDelivery(now);
    if (!delivery) return false;
    this.#nextSend = now + 1100;
    try {
      const receipt = await this.#api.send(delivery, this.#abort.signal);
      this.#store.telegramDelivery(delivery.id, 'sent', { receipt });
    } catch (error) {
      const code = safe(error);
      if (code === 'CONTACT_TELEGRAM_RATE_LIMIT' && error.definitelyRejected && error.retryAfter) {
        this.#store.telegramDelivery(delivery.id, 'queued', { retryAt: Date.now() + error.retryAfter * 1000, error: code });
      } else this.#store.telegramDelivery(delivery.id, error.definitelyRejected ? 'rejected' : 'unknown', { error: code });
      this.#lastError = code;
      if (code === 'CONTACT_TELEGRAM_ACCESS_DENIED') { this.#service.revoke(delivery.device); this.#suspend(error); }
    }
    this.#service.emit('change'); return true;
  }
  #suspend(error) {
    // Stop both network loops, not the user's browser conversation. Do not keep
    // transmitting after another consumer owns polling or credentials fail.
    this.#suspended = true; this.#online = false; this.#lastError = safe(error);
    this.#abort.abort(); this.#api.close(); this.emit('status', this.#lastError);
  }
  start() {
    if (!this.#bot || this.#closed || this.#suspended || this.#polling) throw new Error('CONTACT_TELEGRAM_ALREADY_STARTED');
    const wait = async ms => { try { await pause(ms, undefined, { signal: this.#abort.signal }); } catch { /* shutdown */ } };
    this.#polling = (async () => {
      while (!this.#closed && !this.#suspended) {
        try { await this.pollOnce(); }
        catch (error) {
          if (this.#closed) break;
          this.#online = false; this.#lastError = safe(error); this.emit('status', this.#lastError);
          if (['CONTACT_TELEGRAM_ACCESS_DENIED','CONTACT_TELEGRAM_POLL_CONFLICT','CONTACT_TELEGRAM_BOT_CHANGED'].includes(this.#lastError)
              || !this.#lastError.startsWith('CONTACT_TELEGRAM_')) { this.#suspend(error); break; }
          await wait(Math.max(2000, Math.min(60000, (error.retryAfter ?? 5) * 1000)));
        }
        // Avoid a tight loop when a test endpoint or a noisy queue returns early.
        await wait(100);
      }
    })().catch(error => { this.#suspend(error); });
    this.#sending = (async () => {
      while (!this.#closed && !this.#suspended) { await this.deliverOnce(); await wait(1100); }
    })().catch(error => { this.#suspend(error); });
  }
  status() { return { online: this.#online, suspended: this.#suspended, last_error: this.#lastError, ...this.#store.messagingStatus() }; }
  async close() {
    this.#closed = true; this.#codes.clear(); this.#candidates.clear(); this.#abort.abort(); this.#api.close();
    await Promise.all([this.#polling, this.#sending]);
  }
}
