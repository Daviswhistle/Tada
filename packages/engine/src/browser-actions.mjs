import { validBrowserFileActions } from './browser-file-actions.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { validateContract } from '../../contracts/src/index.mjs';
import { isActionTransitionAllowed } from '../../contracts/src/generated/action-transitions.mjs';
export const browserHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const keys = (v, names) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === names.split(',').sort().join(',');
export function validBrowserActions(value) {
  if (value?.version === 2) return validBrowserFileActions(value);
  return keys(value, 'version,records') && value.version === 1 && Array.isArray(value.records) && value.records.length <= 256 && new Set(value.records.map(r => r?.action?.action_id)).size === value.records.length && value.records.every(r => keys(r, 'action,payload,origin,turn,created,resolved,receipt') && validateContract('ActionRecord', r.action).valid && ['DISPATCHING', 'VERIFIED', 'UNCERTAIN', 'ACKNOWLEDGED', 'FAILED'].includes(r.action.state)
    && keys(r.payload, 'turn,epoch,url,key,ref,label,value,acceptance') && r.payload.turn === r.turn && r.payload.acceptance === 'textbox_dom_value' && typeof r.payload.value === 'string' && r.payload.value.length <= 8000 && r.action.intent_hash === browserHash(r.payload) && r.action.payload_ref === `blob://sha256/${browserHash(r.payload)}`
    && typeof r.payload.label === 'string' && r.payload.label.length <= 300 && ['epoch','url','key','ref'].every(k => typeof r.payload[k] === 'string' && r.payload[k].length > 0 && r.payload[k].length <= 4096)
    && typeof r.origin === 'string' && /^https?:\/\//u.test(r.origin) && Number.isSafeInteger(r.turn) && r.turn > 0 && Number.isSafeInteger(r.created) && r.created > 0
    && (r.resolved === null || keys(r.resolved, 'device,at') && typeof r.resolved.device === 'string' && Number.isSafeInteger(r.resolved.at))
    && (r.receipt === null || keys(r.receipt, 'version,verification_scope,requested_sha256,observed_sha256,observed_at,server_persistence,applied') && r.receipt.version === 1 && r.receipt.verification_scope === 'textbox_dom_value' && r.receipt.server_persistence === 'not_checked' && typeof r.receipt.applied === 'boolean' && /^[a-f0-9]{64}$/u.test(r.receipt.requested_sha256) && (r.receipt.observed_sha256 === null || /^[a-f0-9]{64}$/u.test(r.receipt.observed_sha256)) && Number.isSafeInteger(r.receipt.observed_at)
      && r.receipt.requested_sha256 === browserHash(r.payload.value)
      && (r.action.state !== 'VERIFIED' || r.receipt.applied && r.receipt.observed_sha256 === r.receipt.requested_sha256)
      && (r.action.state !== 'ACKNOWLEDGED' || r.receipt.applied && r.receipt.observed_sha256 !== r.receipt.requested_sha256)
      && (r.action.state !== 'FAILED' || !r.receipt.applied))
    && (!['VERIFIED','ACKNOWLEDGED','FAILED'].includes(r.action.state) || r.receipt !== null));
}
export function beginBrowserAction(turn, grant, observation, ref, value) {
  const id = `browser-${randomUUID()}`, payload = { turn, epoch: grant.epoch, url: grant.url, key: observation.key, ref, label: observation.fields.find(f => f.ref === ref)?.label ?? '', value, acceptance: 'textbox_dom_value' }, intent = browserHash(payload);
  const action = { schema_version: 1, action_id: id, task_id: `turn-${turn}`, version: 1, state: 'PREPARED', effect: 'external_write', intent_hash: intent, payload_ref: `blob://sha256/${intent}`, method: 'browser.fill_textbox', endpoint: grant.origin, account_ref: 'shared_page_account_not_independently_verified', target: JSON.stringify({ tab: grant.target, epoch: grant.epoch, document: observation.key, ref }), policy_revision: 1, cancel_epoch: 0, precondition_version: 1, verifier_version: 'textbox_dom_value_v1', side_effect_state: 'none', reconciliation_verdict: 'NOT_OBSERVED', acceptance_status: 'pending', evidence_refs: [] };
  if (!validateContract('ActionRecord', action).valid || !isActionTransitionAllowed(action.state, 'DISPATCHING'))
    throw Error('CONTACT_BROWSER_ACTION_INVALID');
  Object.assign(action, { state: 'DISPATCHING', version: 2, fencing_token: 1 });
  return { action, payload, origin: grant.origin, turn, created: Date.now(), resolved: null, receipt: null };
}
export function browserUncertain(record) {
  if (record.action.state !== 'DISPATCHING')
    return record;
  return { ...record, action: { ...record.action, version: record.action.version + 1, state: 'UNCERTAIN', side_effect_state: 'uncertain', reconciliation_verdict: 'UNCERTAIN', acceptance_status: 'inconclusive' } };
}
export function finishBrowserAction(record, requested, observation, applied) {
  if (!['DISPATCHING', 'UNCERTAIN'].includes(record.action.state))
    throw Error('CONTACT_BROWSER_ACTION_INVALID');
  if (requested !== record.payload.value) throw Error('CONTACT_BROWSER_ACTION_INVALID');
  if (applied && observation && (observation.url !== record.payload.url || typeof observation.value !== 'string')) return browserUncertain(record);
  if (applied && !observation)
    return browserUncertain(record);
  const receipt = { version: 1, verification_scope: 'textbox_dom_value', requested_sha256: browserHash(requested), observed_sha256: observation ? browserHash(observation.value) : null, observed_at: Date.now(), server_persistence: 'not_checked', applied };
  const matched = applied && observation.value === requested;
  const action = { ...record.action, version: record.action.version + 1, state: 'ACKNOWLEDGED', side_effect_state: applied ? 'confirmed' : 'none', reconciliation_verdict: applied ? matched ? 'CONFIRMED_APPLIED' : 'APPLIED_MISMATCH' : 'CONFIRMED_NOT_APPLIED', acceptance_status: matched ? 'pass' : 'fail', receipt_ref: `receipt:${record.action.action_id}`, evidence_refs: [`receipt:${record.action.action_id}`] };
  if (!applied)
    action.state = 'FAILED';
  else if (matched)
    action.state = 'VERIFIED';
  return { ...record, action, receipt };
}
