// Fixed public SIWC destinations. Injection is a test seam, never CLI configuration.
export const AUTH = 'https://auth.openai.com';
export const API = 'https://api.openai.com/v1';
export function authURL(value) {
  const url = new URL(value);
  if (url.origin !== AUTH || url.username || url.password || url.hash || url.search) throw Error('CHATGPT_DISCOVERY_INVALID');
  return url.href;
}
export function providerError(code, status, param, requestId, shape = 'error_object') {
  const knownCode = typeof code === 'string' && /^[a-z][a-z0-9_]{0,95}$/u.test(code) ? code : undefined;
  const kind = knownCode === 'subscription_sharing_usage_limit_exceeded' ? 'CHATGPT_USAGE_LIMIT'
    : ['subscription_sharing_usage_unavailable', 'subscription_sharing_user_unavailable'].includes(knownCode) ? 'CHATGPT_USAGE_UNAVAILABLE'
    : knownCode === 'subscription_sharing_user_not_eligible' ? 'CHATGPT_PLAN_UNAVAILABLE'
    : knownCode === 'subscription_sharing_unsupported_capability' ? 'CHATGPT_CAPABILITY_UNAVAILABLE'
    : knownCode === 'subscription_sharing_route_not_supported' ? 'CHATGPT_ROUTE_UNAVAILABLE'
    : knownCode === 'invalid_client' ? 'CHATGPT_CLIENT_REJECTED'
    : status === 401 ? 'CHATGPT_SIGN_IN_REQUIRED' : status === 403 ? 'CHATGPT_PERMISSION_DENIED'
    : status === 429 ? 'CHATGPT_USAGE_LIMIT' : status >= 500 ? 'CHATGPT_TEMPORARILY_UNAVAILABLE' : status === 200 ? 'CHATGPT_RESPONSE_FAILED' : 'CHATGPT_REQUEST_REJECTED';
  const error = Error(kind); error.status = status; error.code = knownCode; error.body_shape = shape;
  // Keep machine diagnostics, never a server's free-form message or echoed input.
  if (typeof param === 'string' && param.length <= 100 && /^(?:input|tools|model|reasoning|service_tier|stream|store|scope)(?:\.[a-z_]+|\[[0-9]+\])*$/u.test(param)) error.param = param;
  if (typeof requestId === 'string' && /^[A-Za-z0-9_-]{1,200}$/u.test(requestId)) error.request_id = requestId;
  return error;
}
export async function response(fetcher, url, { signal, ...options } = {}) {
  signal?.throwIfAborted();
  try {
    const res = await fetcher(url, { ...options, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(20000) });
    if (!res.ok) {
      let data;
      try { data = JSON.parse(await bodyText(res, 8192)); } catch { /* malformed/private diagnostics are not exposed */ }
      const shape = typeof data?.error === 'string' ? 'oauth_error' : data?.error && typeof data.error === 'object' ? 'error_object' : data && Object.hasOwn(data, 'detail') ? 'detail' : 'unrecognized';
      throw providerError(typeof data?.error === 'string' ? data.error : data?.error?.code, res.status, data?.error?.param, res.headers.get('x-request-id'), shape);
    }
    return res;
  } catch (error) {
    if (signal?.aborted) throw Error('ASSISTANT_CANCELLED');
    if (/^CHATGPT_[A-Z_]+$/u.test(error?.message)) throw error;
    throw Error('CHATGPT_NETWORK_FAILED');
  }
}
export async function bodyText(res, maxBytes = 262144) {
  const reader = res.body?.getReader();
  if (!reader) throw Error('CHATGPT_RESPONSE_INVALID');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > maxBytes) throw Error('CHATGPT_RESPONSE_LIMIT');
      chunks.push(value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function jsonResponse(fetcher, url, options, maxBytes = 262144) {
  try { return JSON.parse(await bodyText(await response(fetcher, url, options), maxBytes)); }
  catch (error) {
    if (/^CHATGPT_[A-Z_]+$|^ASSISTANT_CANCELLED$/u.test(error?.message)) throw error;
    throw Error('CHATGPT_RESPONSE_INVALID');
  }
}
