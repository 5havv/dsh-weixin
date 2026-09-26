/**
 * Outbound sending with the iLink session rules applied.
 *
 * The backend ties replies to a per-conversation `context_token` that the peer
 * refreshes by messaging the bot. A stale token surfaces as `-2 prepare failed`
 * (or `-14`); the documented recovery is to resend once *without* the token,
 * which the backend accepts as a degraded fallback. Only when that also fails
 * does the peer genuinely need to message the bot first.
 *
 * @module @5havv/dsh-weixin/outbound
 */

import path from 'node:path';

import { clearContextToken, getContextToken } from './auth/accounts.js';
import { buildItemMessage, buildMediaItem, buildTextMessage, chunkText } from './message.js';
import { uploadOutboundMedia } from './media.js';
import { isStaleSessionError, sendMessage } from './protocol/api.js';
import type { WeixinApiOptions } from './protocol/api.js';
import { CDN_BASE_URL } from './protocol/cdn.js';
import type { WeixinMessage } from './protocol/types.js';

/** Default per-message character budget for WeChat text. */
export const DEFAULT_MAX_TEXT_LENGTH = 4_000;

/** Default outbound media byte ceiling. */
export const DEFAULT_MAX_MEDIA_BYTES = 20 * 1024 * 1024;

export interface SendTextOptions {
  /** Channel data directory (context-token store). */
  dataDir: string;
  accountId: string;
  baseUrl: string;
  token?: string;
  botAgent?: string;
  /** Peer to send to (the `from_user_id` of an inbound message). */
  toUserId: string;
  /** Full reply text; long text is chunked automatically. */
  text: string;
  maxChunkLength?: number;
  /** Invoked when a stale context token forced a tokenless send. */
  onStaleSession?: (peerId: string) => void;
}

export interface SendMediaOptions {
  dataDir: string;
  accountId: string;
  baseUrl: string;
  token?: string;
  botAgent?: string;
  toUserId: string;
  /** Absolute path of the local file to upload and send. */
  filePath: string;
  /** Optional text sent before the file. */
  caption?: string;
  /** Media CDN base URL; defaults to the standard endpoint. */
  cdnBaseUrl?: string;
  maxChunkLength?: number;
  onStaleSession?: (peerId: string) => void;
}

export interface SendTextResult {
  messageIds: string[];
  /** True when at least one message was delivered without a context token. */
  usedTokenlessFallback: boolean;
}

/**
 * Raised when the peer's conversation session is gone and cannot be revived by
 * sending: the peer must message the bot again (or re-pair) before it can be
 * pushed to.
 */
export class SessionNotReadyError extends Error {
  constructor(peerId: string, cause: string) {
    super(
      `微信会话尚未就绪，无法向 ${peerId} 发送消息（${cause}）。` +
        '该联系人需要先给 bot 发一条消息以刷新会话。',
    );
    this.name = 'SessionNotReadyError';
  }
}

/**
 * Send one already-built message, applying the stale-session fallback.
 *
 * @param params - transport identity plus a builder called once per attempt.
 * @returns the assigned message id and whether the tokenless path was used.
 * @throws {SessionNotReadyError} when the conversation cannot be revived.
 */
async function sendOne(params: {
  dataDir: string;
  accountId: string;
  toUserId: string;
  apiBase: WeixinApiOptions;
  build: (contextToken?: string) => WeixinMessage;
  onStaleSession?: (peerId: string) => void;
}): Promise<{ messageId: string; usedTokenlessFallback: boolean }> {
  const contextToken = getContextToken(params.dataDir, params.accountId, params.toUserId);

  const attempt = async (token?: string): Promise<string> => {
    const response = await sendMessage({
      ...params.apiBase,
      body: { msg: params.build(token) },
    });
    return response.message_id ?? '';
  };

  try {
    return { messageId: await attempt(contextToken), usedTokenlessFallback: false };
  } catch (error) {
    if (!isStaleSessionError(error)) throw error;
    if (!contextToken) throw new SessionNotReadyError(params.toUserId, describe(error));
    // Stale context token: forget it so later sends skip it, then retry once
    // without any token.
    clearContextToken(params.dataDir, params.accountId, params.toUserId);
    params.onStaleSession?.(params.toUserId);
  }

  try {
    return { messageId: await attempt(undefined), usedTokenlessFallback: true };
  } catch (error) {
    if (isStaleSessionError(error)) throw new SessionNotReadyError(params.toUserId, describe(error));
    throw error;
  }
}

/** Transport identity shared by every send to one account. */
function apiOptionsFor(opts: {
  baseUrl: string;
  token?: string;
  botAgent?: string;
}): WeixinApiOptions {
  return {
    baseUrl: opts.baseUrl,
    ...(opts.token ? { token: opts.token } : {}),
    ...(opts.botAgent ? { botAgent: opts.botAgent } : {}),
  };
}

/**
 * Send text to one peer, applying chunking and the stale-session fallback.
 *
 * @param opts - account identity, target peer, and text.
 * @returns the assigned message ids.
 * @throws {SessionNotReadyError} when the peer's session cannot be revived.
 */
export async function sendTextToPeer(opts: SendTextOptions): Promise<SendTextResult> {
  const apiBase = apiOptionsFor(opts);
  const chunks = chunkText(opts.text, opts.maxChunkLength ?? DEFAULT_MAX_TEXT_LENGTH);
  const messageIds: string[] = [];
  let usedTokenlessFallback = false;

  for (const chunk of chunks) {
    const result = await sendOne({
      dataDir: opts.dataDir,
      accountId: opts.accountId,
      toUserId: opts.toUserId,
      apiBase,
      build: (contextToken) => buildTextMessage(opts.toUserId, chunk, contextToken),
      ...(opts.onStaleSession ? { onStaleSession: opts.onStaleSession } : {}),
    });
    messageIds.push(result.messageId);
    usedTokenlessFallback ||= result.usedTokenlessFallback;
  }

  return { messageIds, usedTokenlessFallback };
}

/**
 * Upload one local file to the Weixin CDN and send it to a peer.
 *
 * The upload is independent of the conversation session, so it happens once;
 * only the resulting message send participates in the stale-session fallback.
 *
 * @param opts - account identity, target peer, and the file to send.
 * @returns the assigned message ids (caption first, then the file).
 * @throws when the file cannot be read or the upload is refused.
 * @throws {SessionNotReadyError} when the peer's session cannot be revived.
 */
export async function sendMediaToPeer(opts: SendMediaOptions): Promise<SendTextResult> {
  const uploaded = await uploadOutboundMedia({
    filePath: opts.filePath,
    toUserId: opts.toUserId,
    baseUrl: opts.baseUrl,
    ...(opts.token ? { token: opts.token } : {}),
    ...(opts.botAgent ? { botAgent: opts.botAgent } : {}),
    cdnBaseUrl: opts.cdnBaseUrl ?? CDN_BASE_URL,
  });

  const item = buildMediaItem(uploaded, path.basename(opts.filePath));
  const apiBase = apiOptionsFor(opts);
  const messageIds: string[] = [];
  let usedTokenlessFallback = false;

  const send = async (build: (contextToken?: string) => WeixinMessage): Promise<void> => {
    const result = await sendOne({
      dataDir: opts.dataDir,
      accountId: opts.accountId,
      toUserId: opts.toUserId,
      apiBase,
      build,
      ...(opts.onStaleSession ? { onStaleSession: opts.onStaleSession } : {}),
    });
    messageIds.push(result.messageId);
    usedTokenlessFallback ||= result.usedTokenlessFallback;
  };

  const caption = opts.caption?.trim();
  if (caption) {
    for (const chunk of chunkText(caption, opts.maxChunkLength ?? DEFAULT_MAX_TEXT_LENGTH)) {
      await send((contextToken) => buildTextMessage(opts.toUserId, chunk, contextToken));
    }
  }
  await send((contextToken) => buildItemMessage(opts.toUserId, item, contextToken));

  return { messageIds, usedTokenlessFallback };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
