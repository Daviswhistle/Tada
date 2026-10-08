import { platform, release } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';

const GOOGLE_SCOPE = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.events.readonly',
].join(' ');

export function validateSystemBrowserUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) throw Error('SYSTEM_BROWSER_URL_REJECTED');
  if (/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/#setup=[A-Za-z0-9_-]{43}$/u.test(value)) return value;
  let url;
  try { url = new URL(value); } catch { throw Error('SYSTEM_BROWSER_URL_REJECTED'); }
  if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth'
      || url.username || url.password || url.hash
      || [...url.searchParams.keys()].sort().join(',') !== 'access_type,client_id,code_challenge,code_challenge_method,include_granted_scopes,prompt,redirect_uri,response_type,scope,state'
      || ['client_id', 'code_challenge', 'state'].some(key => url.searchParams.getAll(key).length !== 1)
      || !/^[A-Za-z0-9._-]{10,200}\.apps\.googleusercontent\.com$/u.test(url.searchParams.get('client_id'))
      || !/^[A-Za-z0-9_-]{43}$/u.test(url.searchParams.get('code_challenge'))
      || !/^[A-Za-z0-9_-]{43}$/u.test(url.searchParams.get('state'))
      || url.searchParams.get('response_type') !== 'code'
      || url.searchParams.get('scope') !== GOOGLE_SCOPE
      || url.searchParams.get('code_challenge_method') !== 'S256'
      || url.searchParams.get('access_type') !== 'offline'
      || url.searchParams.get('include_granted_scopes') !== 'false'
      || url.searchParams.get('prompt') !== 'consent'
      || !/^http:\/\/127\.0\.0\.1:(?:[1-9][0-9]{0,4})\/oauth2\/callback$/u.test(url.searchParams.get('redirect_uri') ?? '')) {
    throw Error('SYSTEM_BROWSER_URL_REJECTED');
  }
  return url.href;
}

export async function openSystemBrowser(value) {
  const url = validateSystemBrowserUrl(value);
  let executable, args;
  if (platform() === 'win32' || (platform() === 'linux' && /microsoft/iu.test(release()))) {
    executable = platform() === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
    args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`Start-Process '${url}'`, 'utf16le').toString('base64')];
  } else { executable = platform() === 'darwin' ? 'open' : 'xdg-open'; args = [url]; }
  return new Promise(resolve => execFile(executable, args, { timeout: 10000, windowsHide: true }, error => resolve(!error)));
}
