/**
 * iLink Bot API HTTP client.
 *
 * One thin function per CGI endpoint. All endpoint paths live under `ilink/bot/`.
 * Authentication is a bearer token obtained from the QR login flow, sent with the
 * fixed `AuthorizationType: ilink_bot_token` header.
 *
 * The documented reference for this protocol is Tencent's `openclaw-weixin`
 * channel (MIT); request/response shapes here match it exactly.
 *
 * @module @5havv/dsh-weixin/protocol/api
 */

import crypto from 'node:crypto';

import { ownPackageJson } from '../pkg.js';

import type {
  BaseInfo,
  GetConfigResp,
  GetUpdatesReq,
  GetUpdatesResp,
  GetUploadUrlReq,
  GetUploadUrlResp,
  NotifyStartResp,
  NotifyStopResp,
  QrCodeResponse,
  QrStatusResponse,
  SendMessageReq,
  SendMessageResp,
  SendTypingReq,
} from './types.js';

/** Fixed API base URL for every QR login request. */
export const FIXED_BASE_URL = 'https://ilinkai.weixin.qq.com';

/** Default `bot_type` used by this channel build. */
export const DEFAULT_ILINK_BOT_TYPE = '3';

/** Default long-poll budget for `getupdates`. */
export const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
/** Default timeout for regular API requests (sendMessage, getUploadUrl). */
export const DEFAULT_API_TIMEOUT_MS = 15_000;
/** Default timeout for lightweight requests (getConfig, sendTyping, notify*). */
export const DEFAULT_CONFIG_TIMEOUT_MS = 10_000;
/** Client-side timeout for the long-poll `get_qrcode_status` request. */
export const QR_LONG_POLL_TIMEOUT_MS = 35_000;

/** Client version encoded as `0x00MMNNPP`. */
const ILINK_APP_ID: string = ownPackageJson.ilink_appid ?? 'bot';

/**
 * Encode a semver string as the uint32 the protocol expects (`0x00MMNNPP`).
 *
 * @param version - package version such as `1.0.11`.
 * @returns the encoded client version.
 */
export function buildClientVersion(version: string): number {
  const parts = version.split('.').map((part) => Number.parseInt(part, 10));
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = parts[2] ?? 0;
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

const ILINK_APP_CLIENT_VERSION: number = buildClientVersion(ownPackageJson.version ?? '0.0.0');
const CHANNEL_VERSION: string = ownPackageJson.version ?? 'unknown';

/** Default `bot_agent` when the deployment declares none. */
export const DEFAULT_BOT_AGENT = 'dsh-weixin';

/** Maximum byte length of a sanitized `bot_agent`. */
const BOT_AGENT_MAX_LEN = 256;

const PRODUCT_RE = /^[A-Za-z0-9_.-]{1,32}\/[A-Za-z0-9_.+-]{1,32}$/;
const COMMENT_RE = /^[\x20-\x27\x2A-\x7E]{1,64}$/;

/**
 * Sanitize a user-supplied `botAgent` into a wire-safe UA-style string.
 * Malformed tokens are dropped; an empty result falls back to the default.
 *
 * @param raw - configured `botAgent`.
 * @returns the sanitized value.
 */
export function sanitizeBotAgent(raw: string | undefined): string {
  if (!raw || typeof raw !== 'string') return DEFAULT_BOT_AGENT;
  const trimmed = raw.trim();
  if (!trimmed) return DEFAULT_BOT_AGENT;

  const rawTokens = trimmed.split(/\s+/);
  const tokens: string[] = [];
  for (let i = 0; i < rawTokens.length; i += 1) {
    const token = rawTokens[i]!;
    if (token.startsWith('(') && !token.endsWith(')')) {
      let acc = token;
      while (i + 1 < rawTokens.length && !acc.endsWith(')')) {
        i += 1;
        acc += ` ${rawTokens[i]!}`;
      }
      tokens.push(acc);
    } else {
      tokens.push(token);
    }
  }

  const accepted: string[] = [];
  let pending: string | null = null;
  for (const token of tokens) {
    if (token.startsWith('(') && token.endsWith(')')) {
      const inner = token.slice(1, -1);
      if (pending && COMMENT_RE.test(inner)) accepted.push(`${pending} (${inner})`);
      else if (pending) accepted.push(pending);
      pending = null;
      continue;
    }
    if (pending) accepted.push(pending);
    pending = PRODUCT_RE.test(token) ? token : null;
  }
  if (pending) accepted.push(pending);
  if (accepted.length === 0) return DEFAULT_BOT_AGENT;

  const joined = accepted.join(' ');
  if (Buffer.byteLength(joined, 'utf-8') <= BOT_AGENT_MAX_LEN) return joined;

  const truncated: string[] = [];
  let len = 0;
  for (const token of accepted) {
    const add = (truncated.length === 0 ? 0 : 1) + Buffer.byteLength(token, 'utf-8');
    if (len + add > BOT_AGENT_MAX_LEN) break;
    truncated.push(token);
    len += add;
  }
  return truncated.length > 0 ? truncated.join(' ') : DEFAULT_BOT_AGENT;
}

/**
 * Build the `base_info` payload attached to every request.
 *
 * @param botAgent - optional deployment-declared agent string.
 * @returns the base info payload.
 */
export function buildBaseInfo(botAgent?: string): BaseInfo {
  return {
    channel_version: CHANNEL_VERSION,
    bot_agent: sanitizeBotAgent(botAgent),
  };
}

/** Options shared by every authenticated API call. */
export interface WeixinApiOptions {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
  /** Deployment-declared `bot_agent` sent in `base_info`. */
  botAgent?: string;
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

/** `X-WECHAT-UIN`: random uint32 rendered as a decimal string, then base64. */
function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

function buildCommonHeaders(): Record<string, string> {
  return {
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
  };
}

function buildPostHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
    ...buildCommonHeaders(),
  };
  if (token?.trim()) headers.Authorization = `Bearer ${token.trim()}`;
  return headers;
}

/** Network error categories, for actionable diagnostics. */
export type FetchErrorKind = 'dns' | 'tcp' | 'tls' | 'timeout' | 'http' | 'unknown';

/**
 * Classify a fetch-level failure. HTTP 4xx/5xx are reported separately by callers.
 *
 * @param error - the thrown error.
 * @returns the category, a human description, and an optional code.
 */
export function classifyFetchError(error: unknown): {
  kind: FetchErrorKind;
  description: string;
  code?: string;
} {
  if (error instanceof Error && error.name === 'AbortError') {
    return { kind: 'timeout', description: 'request timeout' };
  }
  const cause = (error as NodeJS.ErrnoException)?.cause;
  const causeCode = String((cause as { code?: string } | undefined)?.code ?? '');
  const text = `${String(cause ?? error ?? '')} ${causeCode}`;

  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(text)) {
    return { kind: 'dns', description: 'DNS resolution failed', ...(causeCode ? { code: causeCode } : {}) };
  }
  if (/ECONNREFUSED/i.test(text)) {
    return { kind: 'tcp', description: 'TCP connection refused', ...(causeCode ? { code: causeCode } : {}) };
  }
  if (/UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH/i.test(text)) {
    return { kind: 'tcp', description: 'TCP timeout or host unreachable', ...(causeCode ? { code: causeCode } : {}) };
  }
  if (/UND_ERR_SOCKET|SSL|TLS|CERT|UNABLE_TO_VERIFY|DEPTH_ZERO/i.test(text)) {
    return { kind: 'tls', description: 'TLS handshake error', ...(causeCode ? { code: causeCode } : {}) };
  }
  return { kind: 'unknown', description: 'network request failed' };
}

/** Combine an internal timeout controller with an optional external abort signal. */
function combineAbortSignals(internal?: AbortController, external?: AbortSignal): {
  signal?: AbortSignal;
  cleanup: () => void;
} {
  if (!external) return { ...(internal ? { signal: internal.signal } : {}), cleanup: () => {} };
  if (!internal) return { signal: external, cleanup: () => {} };
  if (external.aborted) {
    internal.abort();
    return { signal: internal.signal, cleanup: () => {} };
  }
  const onAbort = (): void => internal.abort();
  external.addEventListener('abort', onAbort, { once: true });
  return {
    signal: internal.signal,
    cleanup: () => external.removeEventListener('abort', onAbort),
  };
}

/** GET a QR-flow endpoint (no bearer token on this path). */
export async function apiGetFetch(params: {
  baseUrl: string;
  endpoint: string;
  timeoutMs?: number;
  label: string;
}): Promise<string> {
  const url = new URL(params.endpoint, ensureTrailingSlash(params.baseUrl));
  const controller = params.timeoutMs ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), params.timeoutMs) : undefined;
  try {
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: buildCommonHeaders(),
      ...(controller ? { signal: controller.signal } : {}),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${params.label} HTTP ${response.status}: ${text}`);
    return text;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** POST a JSON body to an endpoint, optionally authenticated. */
export async function apiPostFetch(params: {
  baseUrl: string;
  endpoint: string;
  body: string;
  token?: string;
  timeoutMs?: number;
  label: string;
  abortSignal?: AbortSignal;
}): Promise<string> {
  const url = new URL(params.endpoint, ensureTrailingSlash(params.baseUrl));
  const controller = params.timeoutMs !== undefined ? new AbortController() : undefined;
  const timer =
    controller && params.timeoutMs !== undefined
      ? setTimeout(() => controller.abort(), params.timeoutMs)
      : undefined;
  const { signal, cleanup } = combineAbortSignals(controller, params.abortSignal);
  try {
    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: buildPostHeaders(params.token),
      body: params.body,
      ...(signal ? { signal } : {}),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${params.label} HTTP ${response.status}: ${text}`);
    return text;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    cleanup();
  }
}

const LOSSLESS_ID_FIELDS = new Set(['message_id', 'msg_id', 'svr_id']);

/**
 * Parse an iLink JSON response while preserving uint64 identifiers.
 *
 * `JSON.parse` would silently round integers beyond 2^53; this pre-pass quotes
 * the known identifier fields so they survive as strings. Only real object keys
 * are rewritten, never text inside string values.
 *
 * @param rawText - the raw response body.
 * @returns the parsed response.
 */
export function parseWeixinApiJson<T>(rawText: string): T {
  let output = '';
  let index = 0;
  while (index < rawText.length) {
    if (rawText[index] !== '"') {
      output += rawText[index++];
      continue;
    }
    const stringStart = index;
    index += 1;
    let escaped = false;
    while (index < rawText.length) {
      const char = rawText[index++];
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') break;
    }
    const stringToken = rawText.slice(stringStart, index);
    output += stringToken;

    let cursor = index;
    while (/\s/.test(rawText[cursor] ?? '')) cursor += 1;
    if (rawText[cursor] !== ':') continue;

    let key: unknown;
    try {
      key = JSON.parse(stringToken);
    } catch {
      continue;
    }
    if (typeof key !== 'string' || !LOSSLESS_ID_FIELDS.has(key)) continue;

    output += rawText.slice(index, cursor + 1);
    cursor += 1;
    while (/\s/.test(rawText[cursor] ?? '')) output += rawText[cursor++];
    const numberStart = cursor;
    if (rawText[cursor] === '-') cursor += 1;
    while (/\d/.test(rawText[cursor] ?? '')) cursor += 1;
    if (cursor > numberStart && !(cursor === numberStart + 1 && rawText[numberStart] === '-')) {
      output += `"${rawText.slice(numberStart, cursor)}"`;
      index = cursor;
    } else {
      index = numberStart;
    }
  }
  return JSON.parse(output) as T;
}

/**
 * Long-poll for new messages.
 *
 * A client-side timeout is normal long-poll behaviour: it resolves to an empty
 * response so the caller can simply poll again.
 *
 * @param params - long-poll parameters.
 * @returns the server response, or an empty response on client timeout.
 */
export async function getUpdates(
  params: GetUpdatesReq & WeixinApiOptions & { abortSignal?: AbortSignal; longPollTimeoutMs?: number },
): Promise<GetUpdatesResp> {
  const timeout = params.longPollTimeoutMs ?? params.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  try {
    const rawText = await apiPostFetch({
      baseUrl: params.baseUrl,
      endpoint: 'ilink/bot/getupdates',
      body: JSON.stringify({
        get_updates_buf: params.get_updates_buf ?? '',
        base_info: buildBaseInfo(params.botAgent),
      }),
      ...(params.token ? { token: params.token } : {}),
      timeoutMs: timeout,
      label: 'getUpdates',
      ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
    });
    return parseWeixinApiJson<GetUpdatesResp>(rawText);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { ret: 0, msgs: [], get_updates_buf: params.get_updates_buf ?? '' };
    }
    throw error;
  }
}

/** Backend code for a rate-limited request. */
export const RATE_LIMIT_ERRCODE = -2;
/** Backend code for an expired session. */
export const SESSION_EXPIRED_ERRCODE = -14;

/** A `sendmessage` rejection carrying the backend's own codes. */
export class SendMessageError extends Error {
  readonly ret: number | undefined;
  readonly errcode: number | undefined;
  readonly errmsg: string | undefined;

  constructor(ret: number | undefined, errcode: number | undefined, errmsg: string | undefined) {
    super(`sendMessage ret=${ret ?? '(none)'} errcode=${errcode ?? '(none)'} errmsg=${errmsg ?? '(none)'}`);
    this.name = 'SendMessageError';
    this.ret = ret;
    this.errcode = errcode;
    this.errmsg = errmsg;
  }
}

/**
 * Recognize the stale-session variants of the backend's `-2` response.
 *
 * `-2` is overloaded: with `prepare failed` / `unknown error` it means the
 * conversation context is stale rather than that the caller is rate limited.
 *
 * @param error - the send failure.
 * @returns true when the session is stale and a tokenless resend may succeed.
 */
export function isStaleSessionError(error: unknown): boolean {
  if (!(error instanceof SendMessageError)) return false;
  if (error.ret === SESSION_EXPIRED_ERRCODE || error.errcode === SESSION_EXPIRED_ERRCODE) return true;
  const isMinusTwo = error.ret === RATE_LIMIT_ERRCODE || error.errcode === RATE_LIMIT_ERRCODE;
  if (!isMinusTwo) return false;
  const message = (error.errmsg ?? '').trim().toLowerCase();
  return message === 'prepare failed' || message === 'unknown error';
}

/**
 * Send one message downstream.
 *
 * @param params - target base URL/token plus the message body.
 * @returns the server response.
 * @throws {SendMessageError} when the backend rejects the message.
 */
export async function sendMessage(
  params: WeixinApiOptions & { body: SendMessageReq },
): Promise<SendMessageResp> {
  const rawText = await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: 'ilink/bot/sendmessage',
    body: JSON.stringify({ ...params.body, base_info: buildBaseInfo(params.botAgent) }),
    ...(params.token ? { token: params.token } : {}),
    timeoutMs: params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
    label: 'sendMessage',
  });
  const response = parseWeixinApiJson<SendMessageResp>(rawText);
  const failed =
    (response.ret !== undefined && response.ret !== 0) ||
    (response.errcode !== undefined && response.errcode !== 0);
  if (failed) throw new SendMessageError(response.ret, response.errcode, response.errmsg);
  return response;
}

/** Fetch bot config (includes the typing ticket) for one user. */
export async function getConfig(
  params: WeixinApiOptions & { ilinkUserId: string; contextToken?: string },
): Promise<GetConfigResp> {
  const rawText = await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: 'ilink/bot/getconfig',
    body: JSON.stringify({
      ilink_user_id: params.ilinkUserId,
      context_token: params.contextToken,
      base_info: buildBaseInfo(params.botAgent),
    }),
    ...(params.token ? { token: params.token } : {}),
    timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
    label: 'getConfig',
  });
  return JSON.parse(rawText) as GetConfigResp;
}

/** Send or cancel a typing indicator. */
export async function sendTyping(
  params: WeixinApiOptions & { body: SendTypingReq },
): Promise<void> {
  await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: 'ilink/bot/sendtyping',
    body: JSON.stringify({ ...params.body, base_info: buildBaseInfo(params.botAgent) }),
    ...(params.token ? { token: params.token } : {}),
    timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
    label: 'sendTyping',
  });
}

/** Obtain a pre-signed CDN upload URL for a media file (used from v0.2 on). */
export async function getUploadUrl(
  params: GetUploadUrlReq & WeixinApiOptions,
): Promise<GetUploadUrlResp> {
  const rawText = await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: 'ilink/bot/getuploadurl',
    body: JSON.stringify({
      filekey: params.filekey,
      media_type: params.media_type,
      to_user_id: params.to_user_id,
      rawsize: params.rawsize,
      rawfilemd5: params.rawfilemd5,
      filesize: params.filesize,
      thumb_rawsize: params.thumb_rawsize,
      thumb_rawfilemd5: params.thumb_rawfilemd5,
      thumb_filesize: params.thumb_filesize,
      no_need_thumb: params.no_need_thumb,
      aeskey: params.aeskey,
      base_info: buildBaseInfo(params.botAgent),
    }),
    ...(params.token ? { token: params.token } : {}),
    timeoutMs: params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
    label: 'getUploadUrl',
  });
  return JSON.parse(rawText) as GetUploadUrlResp;
}

/** Notify the backend that this client is starting. */
export async function notifyStart(params: WeixinApiOptions): Promise<NotifyStartResp> {
  const rawText = await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: 'ilink/bot/msg/notifystart',
    body: JSON.stringify({ base_info: buildBaseInfo(params.botAgent) }),
    ...(params.token ? { token: params.token } : {}),
    timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
    label: 'notifyStart',
  });
  return JSON.parse(rawText) as NotifyStartResp;
}

/** Notify the backend that this client is stopping. */
export async function notifyStop(params: WeixinApiOptions): Promise<NotifyStopResp> {
  const rawText = await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: 'ilink/bot/msg/notifystop',
    body: JSON.stringify({ base_info: buildBaseInfo(params.botAgent) }),
    ...(params.token ? { token: params.token } : {}),
    timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
    label: 'notifyStop',
  });
  return JSON.parse(rawText) as NotifyStopResp;
}

/**
 * Request a login QR code.
 *
 * @param params - optional bot type, previously used tokens, and base URL.
 * @returns the QR payload to render for the user.
 */
export async function fetchBotQrCode(params?: {
  botType?: string;
  localTokenList?: string[];
  baseUrl?: string;
}): Promise<QrCodeResponse> {
  const botType = params?.botType ?? DEFAULT_ILINK_BOT_TYPE;
  const rawText = await apiPostFetch({
    baseUrl: params?.baseUrl ?? FIXED_BASE_URL,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    body: JSON.stringify({ local_token_list: params?.localTokenList ?? [] }),
    label: 'fetchBotQrCode',
  });
  return JSON.parse(rawText) as QrCodeResponse;
}

/**
 * Long-poll the status of a login QR code.
 *
 * Client timeouts and gateway errors both degrade to `wait` so the caller keeps
 * polling; only a genuinely fatal response should end the login.
 *
 * @param params - the QR identifier, an optional verification code, and the base URL to poll.
 * @returns the current status response.
 */
export async function pollQrStatus(params: {
  qrcode: string;
  verifyCode?: string;
  baseUrl?: string;
}): Promise<QrStatusResponse> {
  try {
    let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(params.qrcode)}`;
    if (params.verifyCode) endpoint += `&verify_code=${encodeURIComponent(params.verifyCode)}`;
    const rawText = await apiGetFetch({
      baseUrl: params.baseUrl ?? FIXED_BASE_URL,
      endpoint,
      timeoutMs: QR_LONG_POLL_TIMEOUT_MS,
      label: 'pollQrStatus',
    });
    return JSON.parse(rawText) as QrStatusResponse;
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'AbortError') {
      // Gateway 5xx / transient network failures are treated as "keep waiting".
    }
    return { status: 'wait' };
  }
}
