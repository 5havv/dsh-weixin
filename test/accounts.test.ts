/**
 * Unit tests for credential storage, the long-poll cursor, context tokens,
 * the single-instance lock, and Hermes credential import.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_BASE_URL,
  acquireAccountLock,
  clearAccount,
  clearContextToken,
  getContextToken,
  importAccountFromHermes,
  listAccountIds,
  loadAccount,
  loadContextTokens,
  loadSyncBuf,
  maskToken,
  resolveDataDir,
  saveAccount,
  saveSyncBuf,
  setContextToken,
} from '../src/auth/accounts.js';

const ACCOUNT = 'a1b2c3d4e5f6@im.bot';
const PEER = 'peer@im.wechat';

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-test-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('account store', () => {
  it('saves, indexes, and reloads credentials', () => {
    saveAccount(dataDir, ACCOUNT, { token: 'tok-1', base_url: DEFAULT_BASE_URL, user_id: PEER });

    expect(listAccountIds(dataDir)).toEqual([ACCOUNT]);
    const loaded = loadAccount(dataDir, ACCOUNT);
    expect(loaded?.token).toBe('tok-1');
    expect(loaded?.base_url).toBe(DEFAULT_BASE_URL);
    expect(loaded?.user_id).toBe(PEER);
    expect(loaded?.saved_at).toBeTypeOf('string');
  });

  it('merges partial updates instead of dropping stored fields', () => {
    saveAccount(dataDir, ACCOUNT, { token: 'tok-1', user_id: PEER });
    saveAccount(dataDir, ACCOUNT, { base_url: 'https://example.test' });

    const loaded = loadAccount(dataDir, ACCOUNT);
    expect(loaded?.token).toBe('tok-1');
    expect(loaded?.user_id).toBe(PEER);
    expect(loaded?.base_url).toBe('https://example.test');
  });

  it('writes account files with owner-only permissions', () => {
    saveAccount(dataDir, ACCOUNT, { token: 'tok-1' });
    const mode = fs.statSync(path.join(dataDir, 'accounts', `${ACCOUNT}.json`)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('registers an account id only once', () => {
    saveAccount(dataDir, ACCOUNT, { token: 'a' });
    saveAccount(dataDir, ACCOUNT, { token: 'b' });
    expect(listAccountIds(dataDir)).toEqual([ACCOUNT]);
  });

  it('removes every file for an account', () => {
    saveAccount(dataDir, ACCOUNT, { token: 'tok-1' });
    saveSyncBuf(dataDir, ACCOUNT, 'cursor');
    setContextToken(dataDir, ACCOUNT, PEER, 'ctx');
    clearAccount(dataDir, ACCOUNT);

    expect(listAccountIds(dataDir)).toEqual([]);
    expect(loadAccount(dataDir, ACCOUNT)).toBeNull();
    expect(loadSyncBuf(dataDir, ACCOUNT)).toBe('');
    expect(loadContextTokens(dataDir, ACCOUNT)).toEqual({});
  });

  it('rejects ids that could escape the accounts directory', () => {
    expect(() => saveAccount(dataDir, '../evil', { token: 'x' })).toThrow();
    expect(() => saveAccount(dataDir, 'a/b', { token: 'x' })).toThrow();
    expect(() => saveAccount(dataDir, '  ', { token: 'x' })).toThrow();
  });

  it('returns null for an unknown account', () => {
    expect(loadAccount(dataDir, 'nobody@im.bot')).toBeNull();
  });
});

describe('long-poll cursor', () => {
  it('round-trips the sync buffer and defaults to empty', () => {
    expect(loadSyncBuf(dataDir, ACCOUNT)).toBe('');
    saveSyncBuf(dataDir, ACCOUNT, 'ChAIVxDoi9m1');
    expect(loadSyncBuf(dataDir, ACCOUNT)).toBe('ChAIVxDoi9m1');
  });
});

describe('context tokens', () => {
  it('stores, reads, and clears one token per peer', () => {
    setContextToken(dataDir, ACCOUNT, PEER, 'ctx-1');
    setContextToken(dataDir, ACCOUNT, 'other@im.wechat', 'ctx-2');

    expect(getContextToken(dataDir, ACCOUNT, PEER)).toBe('ctx-1');
    expect(Object.keys(loadContextTokens(dataDir, ACCOUNT))).toHaveLength(2);

    clearContextToken(dataDir, ACCOUNT, PEER);
    expect(getContextToken(dataDir, ACCOUNT, PEER)).toBeUndefined();
    expect(getContextToken(dataDir, ACCOUNT, 'other@im.wechat')).toBe('ctx-2');
  });

  it('clearing an unknown peer is a no-op', () => {
    setContextToken(dataDir, ACCOUNT, PEER, 'ctx-1');
    clearContextToken(dataDir, ACCOUNT, 'nobody@im.wechat');
    expect(getContextToken(dataDir, ACCOUNT, PEER)).toBe('ctx-1');
  });
});

describe('single-instance lock', () => {
  it('grants the lock once and releases it', () => {
    const lock = acquireAccountLock(dataDir, ACCOUNT);
    expect(fs.existsSync(lock.path)).toBe(true);
    lock.release();
    expect(fs.existsSync(lock.path)).toBe(false);
  });

  it('refuses a second lock held by a live process', () => {
    const lock = acquireAccountLock(dataDir, ACCOUNT);
    expect(() => acquireAccountLock(dataDir, ACCOUNT)).toThrow(/already in use/);
    lock.release();
  });

  it('reclaims a lock left behind by a dead process', () => {
    const lockPath = path.join(dataDir, 'accounts', `${ACCOUNT}.lock`);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 2_147_483_646, acquiredAt: 'x' }));

    const lock = acquireAccountLock(dataDir, ACCOUNT);
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).pid).toBe(process.pid);
    lock.release();
  });

  it('releasing twice is safe', () => {
    const lock = acquireAccountLock(dataDir, ACCOUNT);
    lock.release();
    expect(() => lock.release()).not.toThrow();
  });
});

describe('importAccountFromHermes', () => {
  it('copies credentials, cursor, and context tokens', () => {
    const hermesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-hermes-'));
    fs.writeFileSync(
      path.join(hermesDir, `${ACCOUNT}.json`),
      JSON.stringify({ token: 'hermes-token', base_url: DEFAULT_BASE_URL, user_id: PEER }),
    );
    fs.writeFileSync(
      path.join(hermesDir, `${ACCOUNT}.sync.json`),
      JSON.stringify({ get_updates_buf: 'hermes-cursor' }),
    );
    fs.writeFileSync(
      path.join(hermesDir, `${ACCOUNT}.context-tokens.json`),
      JSON.stringify({ [PEER]: 'hermes-ctx' }),
    );

    const imported = importAccountFromHermes(dataDir, ACCOUNT, hermesDir);

    expect(imported.token).toBe('hermes-token');
    expect(imported.user_id).toBe(PEER);
    expect(loadSyncBuf(dataDir, ACCOUNT)).toBe('hermes-cursor');
    expect(getContextToken(dataDir, ACCOUNT, PEER)).toBe('hermes-ctx');
    expect(listAccountIds(dataDir)).toEqual([ACCOUNT]);

    fs.rmSync(hermesDir, { recursive: true, force: true });
  });

  it('accepts camelCase source fields', () => {
    const hermesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-hermes-'));
    fs.writeFileSync(
      path.join(hermesDir, `${ACCOUNT}.json`),
      JSON.stringify({ token: 'tok', baseUrl: 'https://example.test', userId: PEER }),
    );

    const imported = importAccountFromHermes(dataDir, ACCOUNT, hermesDir);
    expect(imported.base_url).toBe('https://example.test');
    expect(imported.user_id).toBe(PEER);

    fs.rmSync(hermesDir, { recursive: true, force: true });
  });

  it('fails loudly when the source account is missing or tokenless', () => {
    const hermesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-hermes-'));
    expect(() => importAccountFromHermes(dataDir, ACCOUNT, hermesDir)).toThrow(/no Hermes account/);

    fs.writeFileSync(path.join(hermesDir, `${ACCOUNT}.json`), JSON.stringify({ user_id: PEER }));
    expect(() => importAccountFromHermes(dataDir, ACCOUNT, hermesDir)).toThrow(/no token/);

    fs.rmSync(hermesDir, { recursive: true, force: true });
  });
});

describe('resolveDataDir', () => {
  it('prefers an explicit directory', () => {
    expect(resolveDataDir('/tmp/explicit')).toBe('/tmp/explicit');
  });

  it('falls back to $DSH_HOME/weixin', () => {
    const previous = process.env.DSH_HOME;
    process.env.DSH_HOME = '/tmp/dsh-home';
    delete process.env.DSH_WEIXIN_DATA_DIR;
    try {
      expect(resolveDataDir()).toBe('/tmp/dsh-home/weixin');
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previous;
    }
  });

  it('honours $DSH_WEIXIN_DATA_DIR over $DSH_HOME', () => {
    const previousHome = process.env.DSH_HOME;
    const previousData = process.env.DSH_WEIXIN_DATA_DIR;
    process.env.DSH_HOME = '/tmp/dsh-home';
    process.env.DSH_WEIXIN_DATA_DIR = '/tmp/override';
    try {
      expect(resolveDataDir()).toBe('/tmp/override');
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousHome;
      if (previousData === undefined) delete process.env.DSH_WEIXIN_DATA_DIR;
      else process.env.DSH_WEIXIN_DATA_DIR = previousData;
    }
  });
});

describe('maskToken', () => {
  it('never reveals a usable token', () => {
    expect(maskToken(undefined)).toBe('(none)');
    expect(maskToken('short')).toBe('***(5)');
    const masked = maskToken('1234567890abcdef');
    expect(masked).not.toContain('567890abc');
    expect(masked).toContain('(16)');
  });
});
