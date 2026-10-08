export const GOOGLE_SCOPES = Object.freeze([
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.events.readonly',
]);
export const GOOGLE_CONSENT = 'google_readonly_v1';

const uuid = value => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
const account = value => typeof value === 'string' && value.length <= 254
  && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(value) && !/[\u0000-\u001f\u007f]/u.test(value);
const token = value => typeof value === 'string' && value.length >= 16 && value.length <= 8192 && /^[\x21-\x7e]+$/u.test(value);

export function validGoogleCredential(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'connected_at,device,email,epoch,last_checked,last_error,reconnect_required,refresh_token,scopes,version'
    && value.version === 1 && uuid(value.epoch) && uuid(value.device) && token(value.refresh_token)
    && account(value.email) && Number.isSafeInteger(value.connected_at) && value.connected_at >= 0
    && (value.last_checked === null || Number.isSafeInteger(value.last_checked) && value.last_checked >= 0)
    && (value.last_error === null || ['authorization_denied', 'temporarily_unavailable', 'permission_denied', 'reconnect_required'].includes(value.last_error))
    && typeof value.reconnect_required === 'boolean' && Array.isArray(value.scopes)
    && value.scopes.length === GOOGLE_SCOPES.length
    && [...value.scopes].sort().join('\n') === [...GOOGLE_SCOPES].sort().join('\n');
}

export function validGoogleDisconnect(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'epoch,remote_revoked,version'
    && value.version === 1 && uuid(value.epoch) && typeof value.remote_revoked === 'boolean';
}
