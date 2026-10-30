// Account allowlist + credential lookup. Credentials live only in env vars.

export const ACCOUNTS = ['hb', 'pw', 'expo', 'pwshow'];

export function isSandbox(env = process.env) {
  return String(env.AUTHNET_SANDBOX_MODE).toLowerCase() === 'true';
}

/** Accounts named in AUTHNET_LIVE_ACCOUNTS (e.g. "pw" or "pw,hb") are live even while AUTHNET_SANDBOX_MODE is true. */
export function liveAccounts(env = process.env) {
  return String(env.AUTHNET_LIVE_ACCOUNTS || '')
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

/** True when this account runs against the Authorize.net sandbox. */
export function isSandboxFor(code, env = process.env) {
  return isSandbox(env) && !liveAccounts(env).includes(code);
}

export function isAllowedAccount(code) {
  return typeof code === 'string' && ACCOUNTS.includes(code);
}

function readCredentials(code, sandbox, env) {
  const prefix = `AUTHNET_${sandbox ? 'SANDBOX_' : ''}${code.toUpperCase()}_`;
  const loginId = env[`${prefix}LOGIN_ID`];
  const transactionKey = env[`${prefix}TXN_KEY`];
  const clientKey = env[`${prefix}CLIENT_KEY`];
  return loginId && transactionKey && clientKey ? { loginId, transactionKey, clientKey } : null;
}

/**
 * Returns { code, sandbox, environment, loginId, transactionKey, clientKey }
 * or null if the account is not allowlisted or any credential is missing.
 *
 * Sandbox only: an account with no sandbox credentials of its own shares Panel World's
 * (the sandbox is just a test system, so one sandbox account can stand in for all four).
 * A live account (every account when AUTHNET_SANDBOX_MODE is not "true", or those named in
 * AUTHNET_LIVE_ACCOUNTS) never falls back: it needs its own live credentials, or it is unavailable
 * rather than silently taking test payments.
 */
export function getAccount(code, env = process.env) {
  if (!isAllowedAccount(code)) return null;
  const sandbox = isSandboxFor(code, env);
  const creds = readCredentials(code, sandbox, env) || (sandbox ? readCredentials('pw', true, env) : null);
  if (!creds) return null;
  return {
    code,
    sandbox,
    environment: sandbox ? 'sandbox' : 'live',
    ...creds,
  };
}
