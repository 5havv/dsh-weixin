/**
 * QR-code login flow for the iLink Bot API.
 *
 * The flow is exposed as two programmatic steps — {@link startLogin} then
 * {@link waitForLogin} — so both a terminal CLI and (later) the DSH Web UI can
 * drive it with their own presentation and verification-code input.
 *
 * @module @5havv/dsh-weixin/auth/qr-login
 */

import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ILINK_BOT_TYPE,
  FIXED_BASE_URL,
  fetchBotQrCode,
  pollQrStatus,
} from '../protocol/api.js';
import type { QrLoginStatus } from '../protocol/types.js';

import { listAccountIds, loadAccount, saveAccount, type WeixinAccountData } from './accounts.js';

/** Login QR codes are valid for five minutes before the server expires them. */
const LOGIN_TTL_MS = 5 * 60_000;
/** Default overall budget for a login attempt. */
const DEFAULT_LOGIN_TIMEOUT_MS = 8 * 60_000;
/** Delay between two status polls when the server answers immediately. */
const POLL_INTERVAL_MS = 1_000;
/** How many times an expired QR code may be refreshed before giving up. */
const MAX_QR_REFRESH = 3;

interface ActiveLogin {
  sessionKey: string;
  qrcode: string;
  qrcodeUrl: string;
  startedAt: number;
  /** Effective polling host; may change after an IDC redirect. */
  currentBaseUrl: string;
  pendingVerifyCode?: string;
}

const activeLogins = new Map<string, ActiveLogin>();

/** A login attempt that has a QR code ready to display. */
export interface LoginSession {
  sessionKey: string;
  qrcode: string;
  /** QR content URL — render this as a QR image for the user to scan. */
  qrcodeUrl: string;
}

/** One observable step of the login flow. */
export interface LoginProgress {
  status: QrLoginStatus | 'error' | 'timeout';
  /** Human-readable, already localized for CLI/UI display. */
  message: string;
  qrcodeUrl?: string;
}

/** Outcome of {@link waitForLogin}. */
export interface LoginResult {
  ok: boolean;
  accountId?: string;
  token?: string;
  baseUrl?: string;
  /** WeChat user id that scanned the code. */
  userId?: string;
  /** The scanned bot is already bound to this instance; existing credentials stay valid. */
  alreadyConnected?: boolean;
  message: string;
}

/** Collect up to ten known tokens so the backend can recognize a re-login. */
function collectLocalTokenList(dataDir: string): string[] {
  const ids = listAccountIds(dataDir);
  const tokens: string[] = [];
  for (let i = ids.length - 1; i >= 0 && tokens.length < 10; i -= 1) {
    const token = loadAccount(dataDir, ids[i]!)?.token?.trim();
    if (token) tokens.push(token);
  }
  return tokens;
}

function isFresh(login: ActiveLogin): boolean {
  return Date.now() - login.startedAt < LOGIN_TTL_MS;
}

/**
 * Begin a login attempt and obtain a QR code.
 *
 * @param opts - data directory, optional bot type/force flag.
 * @returns the session, including the QR content to display.
 */
export async function startLogin(opts: {
  dataDir: string;
  botType?: string;
  force?: boolean;
}): Promise<LoginSession> {
  const sessionKey = randomUUID();
  const botType = opts.botType ?? DEFAULT_ILINK_BOT_TYPE;
  const response = await fetchBotQrCode({
    botType,
    localTokenList: collectLocalTokenList(opts.dataDir),
    baseUrl: FIXED_BASE_URL,
  });

  const login: ActiveLogin = {
    sessionKey,
    qrcode: response.qrcode,
    qrcodeUrl: response.qrcode_img_content,
    startedAt: Date.now(),
    currentBaseUrl: FIXED_BASE_URL,
  };
  activeLogins.set(sessionKey, login);

  return { sessionKey, qrcode: login.qrcode, qrcodeUrl: login.qrcodeUrl };
}

/** Drop a login session that the caller no longer cares about. */
export function cancelLogin(sessionKey: string): void {
  activeLogins.delete(sessionKey);
}

/**
 * Poll until the login succeeds, fails, or times out.
 *
 * @param opts - session identity plus optional progress/verification hooks.
 * @returns the login outcome; on success the credentials are already persisted.
 */
export async function waitForLogin(opts: {
  sessionKey: string;
  dataDir: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (progress: LoginProgress) => void;
  /** Asked when the server demands a verification code shown on the phone. */
  requestVerifyCode?: (retry: boolean) => Promise<string>;
  maxQrRefresh?: number;
}): Promise<LoginResult> {
  const login = activeLogins.get(opts.sessionKey);
  if (!login) return { ok: false, message: '没有进行中的登录，请先调用 startLogin。' };

  const deadline = Date.now() + Math.max(opts.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS, 1_000);
  const maxRefresh = opts.maxQrRefresh ?? MAX_QR_REFRESH;
  const progress = opts.onProgress ?? ((): void => {});
  let refreshCount = 1;
  let sawScan = false;

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) {
      activeLogins.delete(opts.sessionKey);
      return { ok: false, message: '登录已取消。' };
    }
    if (!isFresh(login)) {
      activeLogins.delete(opts.sessionKey);
      return { ok: false, message: '二维码已过期，请重新生成。' };
    }

    const response = await pollQrStatus({
      qrcode: login.qrcode,
      ...(login.pendingVerifyCode ? { verifyCode: login.pendingVerifyCode } : {}),
      baseUrl: login.currentBaseUrl,
    });

    switch (response.status) {
      case 'wait':
        break;

      case 'scaned':
        // A pending code surviving a `scaned` response means the code was correct.
        login.pendingVerifyCode = undefined;
        if (!sawScan) {
          sawScan = true;
          progress({ status: 'scaned', message: '已扫码，请在手机上确认。' });
        }
        break;

      case 'need_verifycode': {
        if (!opts.requestVerifyCode) {
          activeLogins.delete(opts.sessionKey);
          return { ok: false, message: '登录需要验证码，但当前环境无法输入。' };
        }
        const retry = Boolean(login.pendingVerifyCode);
        progress({
          status: 'need_verifycode',
          message: retry ? '验证码不正确，请重新输入。' : '请输入手机微信上显示的数字。',
        });
        login.pendingVerifyCode = await opts.requestVerifyCode(retry);
        continue; // Poll again immediately with the supplied code.
      }

      case 'verify_code_blocked': {
        login.pendingVerifyCode = undefined;
        refreshCount += 1;
        if (refreshCount > maxRefresh) {
          activeLogins.delete(opts.sessionKey);
          return { ok: false, message: '验证码多次错误，登录已停止。' };
        }
        progress({ status: 'verify_code_blocked', message: '验证码多次错误，正在刷新二维码。' });
        await refreshQr(login, opts.dataDir);
        sawScan = false;
        break;
      }

      case 'expired': {
        refreshCount += 1;
        if (refreshCount > maxRefresh) {
          activeLogins.delete(opts.sessionKey);
          return { ok: false, message: '二维码多次失效，登录已停止。' };
        }
        progress({ status: 'expired', message: '二维码已过期，正在刷新。' });
        await refreshQr(login, opts.dataDir);
        sawScan = false;
        break;
      }

      case 'scaned_but_redirect': {
        if (response.redirect_host) {
          login.currentBaseUrl = `https://${response.redirect_host}`;
          progress({ status: 'scaned_but_redirect', message: '已切换服务器，继续等待确认。' });
        }
        break;
      }

      case 'binded_redirect': {
        activeLogins.delete(opts.sessionKey);
        return {
          ok: true,
          alreadyConnected: true,
          message: '该微信号已绑定过，无需重复登录。',
        };
      }

      case 'confirmed': {
        if (!response.ilink_bot_id) {
          activeLogins.delete(opts.sessionKey);
          return { ok: false, message: '登录失败：服务器未返回 ilink_bot_id。' };
        }
        const accountId = response.ilink_bot_id;
        const data: WeixinAccountData = {
          ...(response.bot_token ? { token: response.bot_token } : {}),
          base_url: response.baseurl?.trim() || FIXED_BASE_URL,
          ...(response.ilink_user_id ? { user_id: response.ilink_user_id } : {}),
        };
        saveAccount(opts.dataDir, accountId, data);
        activeLogins.delete(opts.sessionKey);
        progress({ status: 'confirmed', message: `登录成功：${accountId}` });
        return {
          ok: true,
          accountId,
          ...(response.bot_token ? { token: response.bot_token } : {}),
          baseUrl: data.base_url,
          ...(response.ilink_user_id ? { userId: response.ilink_user_id } : {}),
          message: `登录成功：${accountId}`,
        };
      }

      default: {
        progress({ status: 'error', message: `未知登录状态：${String(response.status)}` });
        break;
      }
    }
    await sleep(POLL_INTERVAL_MS, opts.signal);
  }

  activeLogins.delete(opts.sessionKey);
  return { ok: false, message: '登录超时，请重试。' };
}

async function refreshQr(login: ActiveLogin, dataDir: string): Promise<void> {
  const response = await fetchBotQrCode({
    localTokenList: collectLocalTokenList(dataDir),
    baseUrl: FIXED_BASE_URL,
  });
  login.qrcode = response.qrcode;
  login.qrcodeUrl = response.qrcode_img_content;
  login.startedAt = Date.now();
  login.currentBaseUrl = FIXED_BASE_URL;
  login.pendingVerifyCode = undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
