/**
 * Account credential storage for the Weixin channel.
 *
 * Layout under the data directory (default `$DSH_HOME/weixin`):
 *
 * ```
 * accounts.json                      # index of registered account ids
 * accounts/<accountId>.json          # { token, base_url, user_id, saved_at }
 * accounts/<accountId>.sync.json     # { get_updates_buf } long-poll cursor
 * accounts/<accountId>.context-tokens.json   # peerId -> context_token
 * accounts/<accountId>.lock          # single-instance lock for the token
 * ```
 *
 * The per-account file shape intentionally mirrors the Hermes agent's
 * `~/.hermes/weixin/accounts/<id>.json` so credentials can be imported without
 * a re-login (see {@link importAccountFromHermes}).
 *
 * @module @5havv/dsh-weixin/auth/accounts
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** One account's persisted credentials. */
export interface WeixinAccountData {
  token?: string;
  base_url?: string;
  /** Last WeChat user id that completed QR login. */
  user_id?: string;
  saved_at?: string;
}

/** Default API base URL when an account stores none. */
export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';

/**
 * Resolve the directory holding all Weixin channel state.
 *
 * @param explicit - an explicit `dataDir` from plugin config, when set.
 * @returns the absolute data directory (not necessarily created yet).
 */
export function resolveDataDir(explicit?: string): string {
  if (explicit?.trim()) return path.resolve(explicit.trim());
  const fromEnv = process.env.DSH_WEIXIN_DATA_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  const dshHome = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh');
  return path.join(dshHome, 'weixin');
}

function accountsDir(dataDir: string): string {
  return path.join(dataDir, 'accounts');
}

/** Guard against path traversal while keeping iLink ids (`x@im.bot`) readable. */
function assertSafeAccountId(accountId: string): string {
  const trimmed = accountId.trim();
  if (!trimmed) throw new Error('weixin: accountId must not be empty');
  if (/[\\/]/.test(trimmed) || trimmed === '.' || trimmed === '..') {
    throw new Error(`weixin: invalid accountId ${JSON.stringify(accountId)}`);
  }
  return trimmed;
}

function accountPath(dataDir: string, accountId: string): string {
  return path.join(accountsDir(dataDir), `${assertSafeAccountId(accountId)}.json`);
}

function readJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function writeJsonPrivate(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best effort on filesystems without POSIX permissions.
  }
}

/** List account ids registered in the index file. */
export function listAccountIds(dataDir: string): string[] {
  const parsed = readJson<unknown>(path.join(dataDir, 'accounts.json'));
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((id): id is string => typeof id === 'string' && id.trim() !== '');
}

/** Register an account id in the index (idempotent). */
export function registerAccountId(dataDir: string, accountId: string): void {
  const id = assertSafeAccountId(accountId);
  const existing = listAccountIds(dataDir);
  if (existing.includes(id)) return;
  writeJsonPrivate(path.join(dataDir, 'accounts.json'), [...existing, id]);
}

/** Remove an account id from the index. */
export function unregisterAccountId(dataDir: string, accountId: string): void {
  const existing = listAccountIds(dataDir);
  const updated = existing.filter((id) => id !== accountId);
  if (updated.length !== existing.length) {
    writeJsonPrivate(path.join(dataDir, 'accounts.json'), updated);
  }
}

/** Load one account's stored credentials. */
export function loadAccount(dataDir: string, accountId: string): WeixinAccountData | null {
  return readJson<WeixinAccountData>(accountPath(dataDir, accountId));
}

/**
 * Merge and persist account credentials.
 *
 * Provided fields overwrite stored ones; omitted fields are preserved.
 *
 * @param dataDir - channel data directory.
 * @param accountId - account identity.
 * @param update - fields to merge in.
 * @returns the merged account data.
 */
export function saveAccount(
  dataDir: string,
  accountId: string,
  update: WeixinAccountData,
): WeixinAccountData {
  const id = assertSafeAccountId(accountId);
  const existing = loadAccount(dataDir, id) ?? {};
  const token = update.token?.trim() || existing.token;
  const baseUrl = update.base_url?.trim() || existing.base_url;
  const userId = update.user_id?.trim() || existing.user_id;

  const merged: WeixinAccountData = {
    ...(token ? { token } : {}),
    ...(baseUrl ? { base_url: baseUrl } : {}),
    ...(userId ? { user_id: userId } : {}),
    ...(token ? { saved_at: new Date().toISOString() } : existing.saved_at ? { saved_at: existing.saved_at } : {}),
  };
  writeJsonPrivate(accountPath(dataDir, id), merged);
  registerAccountId(dataDir, id);
  return merged;
}

/** Delete every file belonging to one account (credentials, cursor, tokens, lock). */
export function clearAccount(dataDir: string, accountId: string): void {
  const id = assertSafeAccountId(accountId);
  for (const suffix of ['.json', '.sync.json', '.context-tokens.json', '.lock']) {
    try {
      fs.unlinkSync(path.join(accountsDir(dataDir), `${id}${suffix}`));
    } catch {
      // Already absent.
    }
  }
  unregisterAccountId(dataDir, id);
}

// ---------------------------------------------------------------------------
// Long-poll cursor
// ---------------------------------------------------------------------------

function syncPath(dataDir: string, accountId: string): string {
  return path.join(accountsDir(dataDir), `${assertSafeAccountId(accountId)}.sync.json`);
}

/** Load the persisted `get_updates_buf` cursor, or "" when absent. */
export function loadSyncBuf(dataDir: string, accountId: string): string {
  const parsed = readJson<{ get_updates_buf?: string }>(syncPath(dataDir, accountId));
  return typeof parsed?.get_updates_buf === 'string' ? parsed.get_updates_buf : '';
}

/** Persist the `get_updates_buf` cursor. */
export function saveSyncBuf(dataDir: string, accountId: string, getUpdatesBuf: string): void {
  writeJsonPrivate(syncPath(dataDir, accountId), { get_updates_buf: getUpdatesBuf });
}

// ---------------------------------------------------------------------------
// Context tokens
// ---------------------------------------------------------------------------

export type ContextTokenStore = Record<string, string>;

function contextTokensPath(dataDir: string, accountId: string): string {
  return path.join(accountsDir(dataDir), `${assertSafeAccountId(accountId)}.context-tokens.json`);
}

/** Load all peer -> context_token entries for one account. */
export function loadContextTokens(dataDir: string, accountId: string): ContextTokenStore {
  return readJson<ContextTokenStore>(contextTokensPath(dataDir, accountId)) ?? {};
}

/** Read one peer's context token. */
export function getContextToken(
  dataDir: string,
  accountId: string,
  peerId: string,
): string | undefined {
  return loadContextTokens(dataDir, accountId)[peerId];
}

/** Store one peer's context token (required when replying to that peer). */
export function setContextToken(
  dataDir: string,
  accountId: string,
  peerId: string,
  contextToken: string,
): void {
  const store = loadContextTokens(dataDir, accountId);
  if (store[peerId] === contextToken) return;
  writeJsonPrivate(contextTokensPath(dataDir, accountId), { ...store, [peerId]: contextToken });
}

/** Drop one peer's context token (e.g. after the backend reports it stale). */
export function clearContextToken(dataDir: string, accountId: string, peerId: string): void {
  const store = loadContextTokens(dataDir, accountId);
  if (!(peerId in store)) return;
  const { [peerId]: _removed, ...rest } = store;
  writeJsonPrivate(contextTokensPath(dataDir, accountId), rest);
}

// ---------------------------------------------------------------------------
// Single-instance lock
// ---------------------------------------------------------------------------

export interface AccountLock {
  path: string;
  release(): void;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Acquire the single-instance lock for one account's token.
 *
 * The iLink backend allows only one live gateway per token; two pollers would
 * race on the sync cursor and drop messages. A lock left behind by a dead
 * process is reclaimed automatically.
 *
 * @param dataDir - channel data directory.
 * @param accountId - account identity.
 * @returns the held lock.
 * @throws when another live process already holds it.
 */
export function acquireAccountLock(dataDir: string, accountId: string): AccountLock {
  const id = assertSafeAccountId(accountId);
  const lockPath = path.join(accountsDir(dataDir), `${id}.lock`);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
      fs.closeSync(fd);
      return {
        path: lockPath,
        release() {
          try {
            fs.unlinkSync(lockPath);
          } catch {
            // Already released.
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const holder = readJson<{ pid?: number }>(lockPath);
      const pid = holder?.pid ?? -1;
      if (isProcessAlive(pid)) {
        throw new Error(
          `weixin: account ${id} is already in use by pid ${pid} (${lockPath}). ` +
            'Only one process may hold an iLink token at a time.',
        );
      }
      // Stale lock from a dead process — reclaim and retry once.
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // Another racer removed it first.
      }
    }
  }
  throw new Error(`weixin: could not acquire lock for account ${id} (${lockPath})`);
}

// ---------------------------------------------------------------------------
// Hermes import
// ---------------------------------------------------------------------------

/** Default Hermes credentials directory. */
export function defaultHermesDir(): string {
  return path.join(os.homedir(), '.hermes', 'weixin', 'accounts');
}

/** Shape of a Hermes/OpenClaw-style account file. */
interface ForeignAccountFile {
  token?: string;
  base_url?: string;
  baseUrl?: string;
  user_id?: string;
  userId?: string;
  saved_at?: string;
  savedAt?: string;
}

/**
 * Import an account previously created by the Hermes agent (same iLink backend).
 *
 * Copies credentials, the long-poll cursor, and context tokens into this
 * channel's data directory. The source account remains untouched.
 *
 * @param dataDir - destination channel data directory.
 * @param accountId - account identity, e.g. `a1b2c3d4e5f6@im.bot`.
 * @param fromDir - source directory; defaults to `~/.hermes/weixin/accounts`.
 * @returns the imported account data.
 * @throws when the source account file is missing or has no token.
 */
export function importAccountFromHermes(
  dataDir: string,
  accountId: string,
  fromDir?: string,
): WeixinAccountData {
  const sourceDir = fromDir?.trim() || defaultHermesDir();
  const source = readJson<ForeignAccountFile>(path.join(sourceDir, `${assertSafeAccountId(accountId)}.json`));
  if (!source) throw new Error(`weixin: no Hermes account file at ${sourceDir}/${accountId}.json`);
  const token = source.token?.trim();
  if (!token) throw new Error(`weixin: Hermes account ${accountId} carries no token`);

  const data = saveAccount(dataDir, accountId, {
    token,
    base_url: source.base_url?.trim() || source.baseUrl?.trim() || DEFAULT_BASE_URL,
    ...(source.user_id?.trim() || source.userId?.trim()
      ? { user_id: (source.user_id ?? source.userId)!.trim() }
      : {}),
    ...(source.saved_at ?? source.savedAt ? { saved_at: (source.saved_at ?? source.savedAt)! } : {}),
  });

  const sourceSync = readJson<{ get_updates_buf?: string }>(
    path.join(sourceDir, `${accountId}.sync.json`),
  );
  if (typeof sourceSync?.get_updates_buf === 'string') {
    saveSyncBuf(dataDir, accountId, sourceSync.get_updates_buf);
  }

  const sourceTokens = readJson<ContextTokenStore>(
    path.join(sourceDir, `${accountId}.context-tokens.json`),
  );
  if (sourceTokens && typeof sourceTokens === 'object') {
    writeJsonPrivate(contextTokensPath(dataDir, accountId), sourceTokens);
  }

  return data;
}

/**
 * Render a token for logs without revealing it.
 *
 * @param token - the secret.
 * @returns a masked, length-annotated placeholder.
 */
export function maskToken(token: string | undefined): string {
  if (!token) return '(none)';
  if (token.length <= 8) return `***(${token.length})`;
  return `${token.slice(0, 4)}***${token.slice(-2)}(${token.length})`;
}
