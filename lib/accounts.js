// Account allowlist + credential lookup. Credentials live only in env vars.

export const ACCOUNTS = ['hb', 'pw', 'expo', 'pwshow'];

export function isSandbox(env = process.env) {
  return String(env.AUTHNET_SANDBOX_MODE).toLowerCase() === 'true';
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
 * Live mode never falls back: every account must have its own live credentials.
 */
export function getAccount(code, env = process.env) {
  if (!isAllowedAccount(code)) return null;
  const sandbox = isSandbox(env);
  const creds = readCredentials(code, sandbox, env) || (sandbox ? readCredentials('pw', true, env) : null);
  if (!creds) return null;
  return {
    code,
    sandbox,
    environment: sandbox ? 'sandbox' : 'live',
    ...creds,
  };
}
