// Version 2 records add selected-file work; the text-only v1 grant and records
// keep their original meaning. All bytes are sealed by the contact journal.
import { createHash, randomUUID } from 'node:crypto';
import { validateContract } from '../../contracts/src/index.mjs';
export const FILE_LIMIT = 32768;
// Same obvious-credential exclusions as the native read broker.
export const SECRET_FILE_PATTERN = 'credentials|secrets|password|token|id_rsa|id_ed25519|비밀번호|인증정보';
export const fileHash = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = value => fileHash(JSON.stringify(value));
const exact = (v, fields) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === fields.split(',').sort().join(',');
const text = (v, max) => typeof v === 'string' && v.isWellFormed() && v.length <= max;
const hex = v => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
export const fileName = v => text(v, 200) && v.length > 0 && !v.startsWith('.') && !new RegExp(SECRET_FILE_PATTERN,'iu').test(v) && !/[\x00-\x1f\x7f/\\]/u.test(v) && /\.(?:txt|csv|tsv|json|md|log)$/iu.test(v);
export function fileCopy(name, type, bytes) {
  if (!fileName(name) || !text(type, 200) || /[\x00-\x1f\x7f]/u.test(type) || !Buffer.isBuffer(bytes) || bytes.length > FILE_LIMIT) throw Error('CONTACT_BROWSER_FILE_INVALID');
  return { name, type, data: bytes.toString('base64'), sha256: fileHash(bytes) };
}
function validFile(v) {
  if (!exact(v, 'name,type,data,sha256') || !fileName(v.name) || !text(v.type,200) || /[\x00-\x1f\x7f]/u.test(v.type) || !text(v.data, Math.ceil(FILE_LIMIT / 3) * 4) || !hex(v.sha256)) return false;
  const bytes = Buffer.from(v.data, 'base64');
  return bytes.length <= FILE_LIMIT && bytes.toString('base64') === v.data && fileHash(bytes) === v.sha256;
}
export function validBrowserFileActions(value) {
  return exact(value,'version,records') && value.version === 2 && Array.isArray(value.records) && value.records.length <= 256
    && new Set(value.records.map(r => r?.action?.action_id)).size === value.records.length && value.records.every(r => {
      if (!exact(r,'action,payload,origin,turn,created,resolved,receipt') || !validateContract('ActionRecord',r.action).valid) return false;
      const p = r.payload, a = r.action, receipt = r.receipt;
      if (!exact(p,'turn,epoch,url,key,ref,label,value,acceptance,original,replacement,submit') || p.acceptance !== 'selected_file_result'
          || p.turn !== r.turn || !Number.isSafeInteger(r.turn) || r.turn < 1 || !Number.isSafeInteger(r.created) || r.created < 1
          || !['epoch','url','key','ref'].every(k => text(p[k],4096) && p[k].length > 0) || !text(p.label,300)
          || !validFile(p.original) || !validFile(p.replacement) || p.value !== p.replacement.name || !(p.submit === null || text(p.submit,40) && /^submit-[1-9][0-9]*$/u.test(p.submit))
          || a.intent_hash !== digest(p) || a.payload_ref !== `blob://sha256/${digest(p)}` || a.method !== 'browser.replace_selected_file'
          || !['selected_file_download_v1','selected_file_download_v2'].includes(a.verifier_version) || a.endpoint !== r.origin || a.task_id !== `turn-${r.turn}`
          || !['DISPATCHING','VERIFIED','UNCERTAIN','ACKNOWLEDGED','FAILED'].includes(a.state)
          || !(r.resolved === null || exact(r.resolved,'device,at') && text(r.resolved.device,200) && Number.isSafeInteger(r.resolved.at))) return false;
      try { if (new URL(p.url).origin !== r.origin || !/^https?:\/\//u.test(r.origin)) return false; } catch { return false; }
      if (receipt === null) return ['DISPATCHING','UNCERTAIN'].includes(a.state);
      if(!exact(receipt,'version,verification_scope,requested_sha256,observed_sha256,observed_at,server_persistence,applied')
        || receipt.requested_sha256 !== p.replacement.sha256 || !(receipt.observed_sha256 === null || hex(receipt.observed_sha256))
        || !Number.isSafeInteger(receipt.observed_at) || typeof receipt.applied !== 'boolean')return false;
      if(a.verifier_version === 'selected_file_download_v2')return receipt.version === 3
        && receipt.verification_scope === 'selected_file_download_observation' && receipt.server_persistence === 'not_checked'
        && (a.state === 'FAILED' ? !receipt.applied && receipt.observed_sha256 === null
          : a.state === 'UNCERTAIN' && receipt.applied && a.side_effect_state === 'uncertain'
            && a.reconciliation_verdict === 'UNCERTAIN' && a.acceptance_status === 'inconclusive');
      // Historical hash-only receipts retain their recorded meaning. New work
      // cannot enter that verifier or use downloads to clear uncertain effects.
      return receipt.version === 2 && receipt.verification_scope === 'selected_file_download'
        && receipt.server_persistence === (receipt.observed_sha256 === null ? 'not_checked' : 'download_readback')
        && (a.state === 'VERIFIED' ? receipt.applied && receipt.observed_sha256 === receipt.requested_sha256
          : a.state === 'ACKNOWLEDGED' ? receipt.applied && receipt.observed_sha256 !== null && receipt.observed_sha256 !== receipt.requested_sha256
            : a.state === 'FAILED' ? !receipt.applied && receipt.observed_sha256 === null : a.state === 'UNCERTAIN' && receipt.applied && receipt.observed_sha256 === null);
    });
}
export function beginBrowserFileAction(turn, grant, observation, ref, original, replacement, submit) {
  if (grant.files !== true) throw Error('CONTACT_BROWSER_FILE_PERMISSION_REQUIRED');
  const payload = { turn, epoch:grant.epoch, url:grant.url, key:observation.key, ref, label:observation.files.find(f => f.ref === ref)?.label ?? '', value:replacement.name, acceptance:'selected_file_result', original, replacement, submit };
  const id = `browser-${randomUUID()}`, hash = digest(payload);
  const action = { schema_version:1, action_id:id, task_id:`turn-${turn}`, version:2, state:'DISPATCHING', effect:'external_write', intent_hash:hash, payload_ref:`blob://sha256/${hash}`, method:'browser.replace_selected_file', endpoint:grant.origin, account_ref:'shared_page_account_not_independently_verified', target:JSON.stringify({tab:grant.target,epoch:grant.epoch,document:observation.key,ref}), policy_revision:1, cancel_epoch:0, precondition_version:1, verifier_version:'selected_file_download_v2', side_effect_state:'none', reconciliation_verdict:'NOT_OBSERVED', acceptance_status:'pending', evidence_refs:[], fencing_token:1 };
  const record = { action, payload, origin:grant.origin, turn, created:Date.now(), resolved:null, receipt:null };
  if (!validBrowserFileActions({version:2,records:[record]})) throw Error('CONTACT_BROWSER_FILE_INVALID');
  return record;
}
export function finishBrowserFileAction(record, applied, observedHash = null) {
  if (record.action.verifier_version !== 'selected_file_download_v2' || record.payload.acceptance !== 'selected_file_result' || !['DISPATCHING','UNCERTAIN'].includes(record.action.state) || typeof applied !== 'boolean' || !(observedHash === null || hex(observedHash)) || !applied && observedHash !== null) throw Error('CONTACT_BROWSER_FILE_INVALID');
  // applied records dispatch/DOM replacement, never proof of server effects.
  // A matching download may predate this upload under a different URL.
  const state = applied ? 'UNCERTAIN' : 'FAILED';
  const receipt = { version:3, verification_scope:'selected_file_download_observation', requested_sha256:record.payload.replacement.sha256, observed_sha256:observedHash, observed_at:Date.now(), server_persistence:'not_checked', applied };
  const action = { ...record.action, version:record.action.version+1, state, side_effect_state:applied?'uncertain':'none', reconciliation_verdict:applied?'UNCERTAIN':'CONFIRMED_NOT_APPLIED', acceptance_status:applied?'inconclusive':'fail', receipt_ref:`receipt:${record.action.action_id}`, evidence_refs:[`receipt:${record.action.action_id}`] };
  return {...record, action, receipt};
}
