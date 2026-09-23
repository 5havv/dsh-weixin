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

import { clearContextToken, getContextToken } from './auth/accounts.js';
import { buildTextMessage, chunkText } from './message.js';
import { isStaleSessionError, sendMessage } from './protocol/api.js';
import type { WeixinApiOptions } from './protocol/api.js';

/** Default per-message character budget for WeChat text. */
export const DEFAULT_MAX_TEXT_LENGTH = 4_000;

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

export interface SendTextResult {
  messageIds: string[];
  /** True when at least one chunk was delivered without a context token. */
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
 * Send text to one peer, applying chunking and the stale-session fallback.
 *
 * @param opts - account identity, target peer, and text.
 * @returns the assigned message ids.
 * @throws {SessionNotReadyError} when the peer's session cannot be revived.
 */
export async function sendTextToPeer(opts: SendTextOptions): Promise<SendTextResult> {
  const maxLength = opts.maxChunkLength ?? DEFAULT_MAX_TEXT_LENGTH;
  const chunks = chunkText(opts.text, maxLength);
  const messageIds: string[] = [];
  let usedTokenlessFallback = false;

  for (const chunk of chunks) {
    const contextToken = getContextToken(opts.dataDir, opts.accountId, opts.toUserId);
    const apiBase: WeixinApiOptions = {
      baseUrl: opts.baseUrl,
      ...(opts.token ? { token: opts.token } : {}),
      ...(opts.botAgent ? { botAgent: opts.botAgent } : {}),
    };

    try {
      const response = await sendMessage({
        ...apiBase,
        body: { msg: buildTextMessage(opts.toUserId, chunk, contextToken) },
      });
      messageIds.push(response.message_id ?? '');
      continue;
    } catch (error) {
      if (!isStaleSessionError(error) || !contextToken) {
        if (isStaleSessionError(error)) {
          throw new SessionNotReadyError(opts.toUserId, describe(error));
        }
        throw error;
      }
      // Stale context token: forget it so later sends skip it, then retry once
      // without any token.
      clearContextToken(opts.dataDir, opts.accountId, opts.toUserId);
      opts.onStaleSession?.(opts.toUserId);
    }

    try {
      const response = await sendMessage({
        ...apiBase,
        body: { msg: buildTextMessage(opts.toUserId, chunk) },
      });
      messageIds.push(response.message_id ?? '');
      usedTokenlessFallback = true;
    } catch (error) {
      if (isStaleSessionError(error)) {
        throw new SessionNotReadyError(opts.toUserId, describe(error));
      }
      throw error;
    }
  }

  return { messageIds, usedTokenlessFallback };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
