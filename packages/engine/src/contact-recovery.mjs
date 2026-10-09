// Immutable historical records. Nothing in this namespace is a dispatch target.
import { createHash } from 'node:crypto';
import { validateBackupSnapshot, backupRecordGroups, BACKUP_COLUMNS, MAX_BACKUP_BYTES } from './contact-backup.mjs';
import { validMailAction } from './mail-actions.mjs';
import { validBrowserActions } from './browser-actions.mjs';
import { followupInstant, followupTimezone, validateFollowupProposal, isFollowupId } from './followup-contract.mjs';
const hash = v => createHash('sha256').update(v).digest('hex');
const fail = () => { throw Error('CONTACT_RECOVERY_INVALID'); };
const obj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v, names) => obj(v) && Object.keys(v).sort().join(',') === names.split(',').sort().join(',');
const n = v => Number.isSafeInteger(v) && v >= 0;
const text = (v, max = 65536) => typeof v === 'string' && v.isWellFormed() && Buffer.byteLength(v) <= max;
// Citation limits are UTF-16 code units in the existing model/provider
// contract. The surrounding archive and row limits still bound UTF-8 bytes.
const characters = (v, max) => typeof v === 'string' && v.isWellFormed() && v.length <= max;
const hex = v => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const state = (v, choices) => choices.split(',').includes(v);
const safeUrl = v => { try { const u = new URL(v); return ['https:','http:'].includes(u.protocol) && !u.username && !u.password && !/[\u0000-\u0020\u007f-\u009f]/u.test(v); } catch { return false; } };
const nullableText = v => v === null || text(v, 1024);
const keyFor = (name, row) => name === 'browser_actions' ? row.name : name === 'proactive_runs' ? row.turn : ['turns','requests'].includes(name) ? row.seq : row.id;
export const recoveryRecordKey = keyFor;
const evidenceFingerprint = s => JSON.stringify([s.source,s.path,s.sha256,s.observed_at,s.citations?.map(c => [c.url,c.title]) ?? null]);

export function recoveryGroups(snapshot) {
  validateBackupSnapshot(snapshot);
  return structuredClone(backupRecordGroups(snapshot));
}
// Validate relationships across generations too: a new document may legitimately
// revise an older restored document. No old device/token/grant becomes live.
export function validateRecoveryGroups(groups) {
  if (!Array.isArray(groups) || !groups.length || Buffer.byteLength(JSON.stringify(groups)) > MAX_BACKUP_BYTES) fail();
  const maps = Object.fromEntries(Object.keys(BACKUP_COLUMNS).map(k => [k, new Map()])), journals = new Set();
  let count = 0;
  for (const group of groups) {
    validateBackupSnapshot(group);
    if (group.version === 2 && group.recovered.length || journals.has(group.source.journal_id)) fail();
    journals.add(group.source.journal_id);
    for (const [name, minimum] of Object.entries({telegram_outbox:2,followups:3,followup_proposals:3,followup_notices:3,followup_reviews:4,proactive_runs:5,browser_actions:5,mail_actions:6})) if (group.source.schema_version < minimum && group.records[name].length) fail();
    for (const [name, rows] of Object.entries(group.records)) for (const row of rows) {
      const key = keyFor(name, row);
      if (++count > 200000 || maps[name].has(key) || Buffer.byteLength(JSON.stringify(row)) > 262144) fail();
      maps[name].set(key, row);
    }
  }
  const { turns, devices, followups, followup_reviews: reviews, telegram_outbox: outbox, mail_actions: mail, proactive_runs: proactive } = maps;
  const requestIds = new Set(), evidence = new Map();
  for (const row of turns.values()) {
    if (!Number.isFinite(new Date(row.created).getTime()) || !/^[a-zA-Z0-9_-]{16,80}$/u.test(row.request_id) || requestIds.has(row.request_id) || !row.payload.text.trim()) fail();
    requestIds.add(row.request_id);
    const a = row.answer;
    if (a !== null) {
      if (row.state !== 'answered' || !text(a.text,262144) || !a.text.trim() || !Array.isArray(a.sources) || a.sources.length > 256
          || Object.keys(a).some(k => !['text','sources','verification','usage','document','mail_action_id','quiet','refused','notice','calendar_reminder','observed_at'].includes(k))
          || a.verification !== undefined && !state(a.verification,'cited_sources_rechecked,saved_document_sources_checked,provider_web_report_checked,not_applicable')
          || ['quiet','refused','calendar_reminder'].some(k => a[k] !== undefined && typeof a[k] !== 'boolean')
          || a.notice !== undefined && !text(a.notice) || a.observed_at !== undefined && !n(a.observed_at)) fail();
      for (const s of a.sources) if (!obj(s) || !['id','source','path','sha256','observed_at'].every(k => text(s[k],32768))
          || Object.keys(s).some(k => !['id','source','path','sha256','observed_at','citations'].includes(k)) || !hex(s.sha256)
          || !Number.isFinite(Date.parse(s.observed_at)) || s.citations !== undefined && (s.source !== 'ChatGPT public web research' || !Array.isArray(s.citations) || s.citations.length > 128 || s.citations.some(c => !exact(c,'url,title') || !characters(c.url,8192) || !safeUrl(c.url) || !characters(c.title,4096)))) fail();
      for (const source of a.sources) {
        const number = Number(source.id.slice(1)), fingerprint = evidenceFingerprint(source);
        if (!/^S[1-9][0-9]*$/u.test(source.id) || !Number.isSafeInteger(number) || number >= Number.MAX_SAFE_INTEGER - 1000000
            || evidence.has(source.id) && evidence.get(source.id) !== fingerprint) fail();
        evidence.set(source.id, fingerprint);
      }
      if (a.usage !== undefined && (!exact(a.usage,'requests,input_tokens,output_tokens,unknown_requests') || !Object.values(a.usage).every(n))) fail();
      if (a.mail_action_id !== undefined && (!mail.has(a.mail_action_id) || mail.get(a.mail_action_id).turn !== row.seq || a.document)) fail();
      if (a.document) {
        const d = a.document, parent = d.based_on === null ? null : turns.get(d.based_on)?.answer;
        if (![1,2].includes(d.version) || !exact(d,d.version === 2 ? 'version,id,root,revision,based_on,title,format,sha256,author' : 'version,id,root,revision,based_on,title,format,sha256')
            || d.id !== row.seq || !n(d.root) || d.root < 1 || !n(d.revision) || d.revision < 1 || !text(d.title,480) || !d.title.trim() || d.title.length > 120
            || !state(d.format,'text,markdown') || Buffer.byteLength(a.text) > 4096 || d.sha256 !== hash(a.text)
            || (d.based_on === null ? d.root !== d.id || d.revision !== 1 : !n(d.based_on) || d.based_on >= d.id || !parent?.document
              || parent.document.root !== d.root || parent.document.revision + 1 !== d.revision || d.version === 2 && parent.document.format !== d.format)
            || d.version === 2 && (d.author !== 'owner' || !parent || row.payload.text !== '문서를 직접 수정했어요.' || a.verification !== 'not_applicable' || JSON.stringify(parent.sources) !== JSON.stringify(a.sources))) fail();
      }
    } else if (row.state === 'answered') fail();
  }
  const unique = (rows, key) => { const seen = new Set(); for (const row of rows) { const v = key(row); if (seen.has(v)) fail(); seen.add(v); } };
  for (const f of followups.values()) {
    const v = f.payload;
    if (!isFollowupId(f.id) || !n(f.version) || !f.version || !turns.has(f.origin_turn) || !devices.has(f.device) || !n(f.created) || !n(f.updated) || f.updated < f.created
        || !obj(v) || Object.keys(v).sort().join(',') !== (v.approval_basis === undefined ? 'details,notify_at,state,timezone,title,user_quote,waiting_for' : 'approval_basis,delegation_epoch,details,notify_at,state,timezone,title,user_quote,waiting_for')
        || !state(f.state,'open,waiting,done,cancelled') || v.state !== f.state || !text(v.title,240) || !v.title.trim() || !text(v.details,2400) || !text(v.user_quote,1500)
        || !nullableText(v.waiting_for) || (v.state === 'waiting') !== (v.waiting_for !== null)
        || (v.notify_at === null ? f.notify_at !== null : followupInstant(v.notify_at) !== f.notify_at)
        || v.approval_basis !== undefined && (v.approval_basis !== 'owner_delegation' || !isFollowupId(v.delegation_epoch))) fail();
    followupTimezone(v.timezone);
  }
  unique(maps.followup_proposals.values(), r => `${r.turn}:${r.operation_id}`);
  for (const p of maps.followup_proposals.values()) {
    if (!isFollowupId(p.id) || !devices.has(p.device) || !n(p.created) || !state(p.state,'pending,approved,rejected,expired,superseded') || !exact(p.payload,'spec,timezone')) fail();
    // Validate the saved request at its saved admission time, not today's date.
    validateFollowupProposal(p.payload.spec, turns.get(p.turn)?.payload.text, Math.min(p.created, p.payload.spec.notify_at === null ? p.created : followupInstant(p.payload.spec.notify_at) - 1));
    followupTimezone(p.payload.timezone);
    if (p.operation_id !== p.payload.spec.operation_id || p.payload.spec.target !== null && !followups.has(p.payload.spec.target)) fail();
  }
  unique(reviews.values(), r => `${r.commitment}:${r.version}`);
  for (const r of reviews.values()) {
    const p = r.payload, t = turns.get(r.turn);
    if (!hex(r.id) || !followups.has(r.commitment) || !n(r.version) || !r.version || r.version > followups.get(r.commitment).version || !devices.has(r.device)
        || !n(r.due) || !n(r.created) || !nullableText(r.error) || !state(r.state,'armed,queued,cancelled') || !exact(p,'commitment,version,device,due,consent,text')
        || ['commitment','version','device','due'].some(k => p[k] !== r[k]) || p.consent !== 'one_local_read_only_review' || !text(p.text,4096)
        || r.turn !== null && (!t || t.request_id !== `review_${r.id}` || t.device !== r.device || t.payload.text !== p.text)) fail();
  }
  unique([...reviews.values()].filter(r => r.turn !== null), r => r.turn);
  for (const r of proactive.values()) if (!exact(r.payload,'turn,epoch,fingerprint,created') || ['turn','epoch','fingerprint','created'].some(k => r[k] !== r.payload[k]) || !isFollowupId(r.epoch) || !hex(r.fingerprint) || !n(r.created) || [...reviews.values()].some(v => v.turn === r.turn)) fail();
  for (const m of mail.values()) if (!validMailAction(m.payload) || ['id','turn','state'].some(k => m[k] !== m.payload[k]) || !devices.has(m.payload.device) || turns.get(m.turn)?.answer?.mail_action_id !== m.id) fail();
  unique(mail.values(), r => r.turn);
  for (const b of maps.browser_actions.values()) {
    if (!validBrowserActions(b.payload) || b.payload.records.length !== 1) fail();
    const r = b.payload.records[0];
    if (b.name !== `browser_action:${r.action.state}:${r.action.action_id}` || !turns.has(r.turn)) fail();
  }
  unique(maps.browser_actions.values(), r => r.payload.records[0].action.action_id);
  for (const o of outbox.values()) {
    const p = o.payload, r = o.receipt;
    if (!hex(o.id) || !devices.has(o.device) || !n(o.part) || o.part > 19 || !n(o.created) || !n(o.not_before) || !nullableText(o.error)
        || !state(o.state,'queued,sending,sent,unknown,rejected,suppressed') || !(exact(p,'chat,bot,text') || exact(p,'chat,bot,text,group') && hex(p.group))
        || ![p.chat,p.bot].every(v => typeof v === 'string' && /^[1-9][0-9]{0,15}$/u.test(v)) || !text(p.text,65536)
        || r !== null && (!obj(r) || !n(r.message_id) || !r.message_id || r.chat !== p.chat || r.bot !== p.bot || r.text_hash !== hash(p.text))
        || o.state === 'sent' && r === null) fail();
  }
  unique([...outbox.values()].filter(r => r.payload.group !== undefined), r => `${r.device}:${r.payload.group}:${r.part}`);
  unique(maps.followup_notices.values(), r => `${r.commitment}:${r.version}`);
  for (const r of maps.followup_notices.values()) {
    const p = r.payload;
    if (!hex(r.id) || !followups.has(r.commitment) || !n(r.version) || !r.version || r.version > followups.get(r.commitment).version
        || !n(r.created) || !state(r.state,'ready,seen,superseded') || r.telegram_id !== null && !outbox.has(r.telegram_id)
        || !exact(p,'title,details,scheduled_at,timezone,text,waiting_for,late') || !text(p.title,240) || !text(p.details,2400) || !text(p.text) || !nullableText(p.waiting_for) || typeof p.late !== 'boolean') fail();
    followupInstant(p.scheduled_at); followupTimezone(p.timezone);
  }
  return groups;
}

export class RecoveredRecords {
  #groups; #maps; #meta = new Map(); #evidence = new Map(); #nextEvidence = 1;
  constructor(groups) {
    this.#groups = structuredClone(validateRecoveryGroups(groups));
    this.#maps = Object.fromEntries(Object.keys(BACKUP_COLUMNS).map(k => [k, new Map()]));
    for (const g of this.#groups) for (const [name, rows] of Object.entries(g.records)) for (const row of rows) {
      const key = keyFor(name,row); this.#maps[name].set(key,row);
      if (name === 'turns') for (const source of row.answer?.sources ?? []) {
        this.#evidence.set(source.id,evidenceFingerprint(source));
        this.#nextEvidence = Math.max(this.#nextEvidence,Number(source.id.slice(1)) + 1);
      }
      this.#meta.set(`${name}:${key}`, { quarantined: true, snapshot_at: g.created_at, generation: g.source.journal_id });
    }
  }
  nextEvidence() { return this.#nextEvidence; }
  hasEvidence(evidence) { return this.#evidence.has(evidence.id) && this.#evidence.get(evidence.id) === evidenceFingerprint(evidence); }
  groups() { return structuredClone(this.#groups); }
  row(name, key) { const r = this.#maps[name].get(key); return r ? structuredClone(r) : null; }
  rows(name) { return structuredClone([...this.#maps[name].values()]); }
  metadata(name,key) { const r = this.#meta.get(`${name}:${key}`); return r ? { ...r } : null; }
  hasRequest(id) { return [...this.#maps.turns.values()].some(r => r.request_id === id); }
  maximum(name) { return [...this.#maps[name].keys()].reduce((max,k) => Math.max(max,k), 0); }
  turn(id) {
    const r = this.row('turns',id); if (!r) return null;
    return { seq:r.seq,request_id:r.request_id,device:r.device,state:r.state,created:r.created,text:r.payload.text,answer:r.answer,error:r.error,
      ...(r.answer?.document?.version === 2 ? {origin:'owner_edit'} : this.#maps.proactive_runs.has(id) ? {origin:'proactive'} : {}), recovery:this.metadata('turns',id) };
  }
  usage(turn = null) {
    const rows = this.rows('requests').filter(r => turn === null || r.turn === turn);
    const value = {requests:rows.length,input_tokens:0,output_tokens:0,unknown_requests:0};
    for (const r of rows) { value.input_tokens += r.input_tokens; value.output_tokens += r.output_tokens; value.unknown_requests += r.state !== 'observed' ? 1 : 0; }
    if (!Object.values(value).every(n)) fail(); return value;
  }
}
