export const GOOGLE_SCOPES = Object.freeze([
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.events.readonly',
]);
export const GOOGLE_SEND_SCOPES = Object.freeze([...GOOGLE_SCOPES, 'https://www.googleapis.com/auth/gmail.send']);
export const GOOGLE_SEND_CONSENT = 'google_read_and_send_v1';
export const googleScopesMatch = (scopes, send = false) => Array.isArray(scopes)
  && scopes.length === (send ? GOOGLE_SEND_SCOPES : GOOGLE_SCOPES).length
  && [...scopes].sort().join('\n') === [...(send ? GOOGLE_SEND_SCOPES : GOOGLE_SCOPES)].sort().join('\n');
export const GOOGLE_CONSENT = 'google_readonly_v1';
export const RELATED_MAIL_CONSENT = 'related_mail_readonly_v1';

const uuid = value => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
const account = value => typeof value === 'string' && value.length <= 254
  && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(value) && !/[\u0000-\u001f\u007f]/u.test(value);
const token = value => typeof value === 'string' && value.length >= 16 && value.length <= 8192 && /^[\x21-\x7e]+$/u.test(value);

export function validGoogleCredential(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === (value.version === 2 ? 'connected_at,device,email,epoch,last_checked,last_error,reconnect_required,refresh_token,scopes,send_enabled,version' : 'connected_at,device,email,epoch,last_checked,last_error,reconnect_required,refresh_token,scopes,version')
    && [1, 2].includes(value.version) && (value.version === 1 || typeof value.send_enabled === 'boolean') && uuid(value.epoch) && uuid(value.device) && token(value.refresh_token)
    && account(value.email) && Number.isSafeInteger(value.connected_at) && value.connected_at >= 0
    && (value.last_checked === null || Number.isSafeInteger(value.last_checked) && value.last_checked >= 0)
    && (value.last_error === null || ['authorization_denied', 'temporarily_unavailable', 'permission_denied', 'reconnect_required'].includes(value.last_error))
    && typeof value.reconnect_required === 'boolean' && Array.isArray(value.scopes)
    && googleScopesMatch(value.scopes, value.version === 2);
}

export function validGoogleDisconnect(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'epoch,remote_revoked,version'
    && value.version === 1 && uuid(value.epoch) && typeof value.remote_revoked === 'boolean';
}

export function validRelatedMail(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'device,enabled,epoch,google_epoch,version'
    && value.version === 1 && typeof value.enabled === 'boolean' && uuid(value.epoch) && uuid(value.device)
    && (value.google_epoch === null || uuid(value.google_epoch)) && (!value.enabled || value.google_epoch !== null);
}
