// Account allowlist + credential lookup. Credentials live only in env vars.

export const ACCOUNTS = ['hb', 'pw', 'expo', 'pwshow'];

export function isSandbox(env = process.env) {
  return String(env.AUTHNET_SANDBOX_MODE).toLowerCase() === 'true';
}

export function isAllowedAccount(code) {
  return typeof code === 'string' && ACCOUNTS.includes(code);
}

/**
 * Returns { code, sandbox, environment, loginId, transactionKey, clientKey }
 * or null if the account is not allowlisted or any credential is missing.
 */
export function getAccount(code, env = process.env) {
  if (!isAllowedAccount(code)) return null;
  const sandbox = isSandbox(env);
  const prefix = `AUTHNET_${sandbox ? 'SANDBOX_' : ''}${code.toUpperCase()}_`;
  const loginId = env[`${prefix}LOGIN_ID`];
  const transactionKey = env[`${prefix}TXN_KEY`];
  const clientKey = env[`${prefix}CLIENT_KEY`];
  if (!loginId || !transactionKey || !clientKey) return null;
  return {
    code,
    sandbox,
    environment: sandbox ? 'sandbox' : 'live',
    loginId,
    transactionKey,
    clientKey,
  };
}
