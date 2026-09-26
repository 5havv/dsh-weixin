/**
 * Inbound long-poll loop.
 *
 * Owns one account's connection to the iLink backend: it holds the single-instance
 * token lock, keeps the `get_updates_buf` cursor on disk, de-duplicates messages,
 * and hands every genuine user message to a callback.
 *
 * @module @5havv/dsh-weixin/inbound
 */

import {
  DEFAULT_LONG_POLL_TIMEOUT_MS,
  classifyFetchError,
  getUpdates,
  notifyStart,
  notifyStop,
} from './protocol/api.js';
import type { WeixinMessage } from './protocol/types.js';
import {
  acquireAccountLock,
  loadSyncBuf,
  saveSyncBuf,
  setContextToken,
  type AccountLock,
} from './auth/accounts.js';
import { isBotMessage } from './message.js';

/** Backend error code meaning the token session is stale and needs a re-login. */
export const STALE_TOKEN_ERRCODE = -14;

/** Failures tolerated before the loop backs off for a long interval. */
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
/** Sliding window used to suppress duplicate deliveries of one message id. */
const DEDUP_WINDOW_MS = 5 * 60_000;

/** Lifecycle/health notifications surfaced to the owning service. */
export type MonitorEvent =
  | { type: 'started' }
  | { type: 'poll' }
  | { type: 'message'; message: WeixinMessage }
  | { type: 'stale-token'; errcode: number; errmsg?: string }
  | { type: 'error'; error: unknown; consecutiveFailures: number }
  | { type: 'stopped' };

export interface MonitorOptions {
  accountId: string;
  baseUrl: string;
  token?: string;
  botAgent?: string;
  /** Channel data directory (cursor, lock). */
  dataDir: string;
  /** External cancellation; aborts an in-flight long poll immediately. */
  signal?: AbortSignal;
  /** Overrides the long-poll budget; the server may suggest a new value. */
  longPollTimeoutMs?: number;
  /**
   * Consumer callback. May be async: the loop awaits it before polling again,
   * so message order is preserved even when handling downloads media.
   */
  onEvent?: (event: MonitorEvent) => void | Promise<void>;
}

/** Tracks recently seen message ids to suppress duplicate poll deliveries. */
export class Dedup {
  private readonly seen = new Map<string, number>();

  /**
   * @param id - backend message id (absent ids are never duplicates).
   * @returns true when this id was already delivered inside the window.
   */
  isDuplicate(id: string | undefined): boolean {
    if (!id) return false;
    const now = Date.now();
    for (const [key, at] of this.seen) {
      if (now - at > DEDUP_WINDOW_MS) this.seen.delete(key);
    }
    if (this.seen.has(id)) return true;
    this.seen.set(id, now);
    return false;
  }
}

/**
 * Run the inbound loop until aborted.
 *
 * Resolves (never rejects) when the loop stops, so callers can treat it as a
 * supervised background task.
 *
 * @param opts - account identity, credentials, and message callback.
 */
export async function runMonitor(opts: MonitorOptions): Promise<void> {
  const emit = async (event: MonitorEvent): Promise<void> => {
    await opts.onEvent?.(event);
  };
  let lock: AccountLock | undefined;

  try {
    lock = acquireAccountLock(opts.dataDir, opts.accountId);
  } catch (error) {
    await emit({ type: 'error', error, consecutiveFailures: 0 });
    return;
  }

  const dedup = new Dedup();
  let syncBuf = loadSyncBuf(opts.dataDir, opts.accountId);
  let consecutiveFailures = 0;
  let pollTimeoutMs = opts.longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;

  try {
    await notifyStart({
      baseUrl: opts.baseUrl,
      ...(opts.token ? { token: opts.token } : {}),
      ...(opts.botAgent ? { botAgent: opts.botAgent } : {}),
    }).catch(() => undefined); // Best-effort lifecycle hint.
    await emit({ type: 'started' });

    while (!opts.signal?.aborted) {
      try {
        const response = await getUpdates({
          baseUrl: opts.baseUrl,
          ...(opts.token ? { token: opts.token } : {}),
          ...(opts.botAgent ? { botAgent: opts.botAgent } : {}),
          get_updates_buf: syncBuf,
          timeoutMs: pollTimeoutMs,
          ...(opts.signal ? { abortSignal: opts.signal } : {}),
        });

        if (response.longpolling_timeout_ms && response.longpolling_timeout_ms > 0) {
          pollTimeoutMs = response.longpolling_timeout_ms;
        }

        const failed =
          (response.ret !== undefined && response.ret !== 0) ||
          (response.errcode !== undefined && response.errcode !== 0);

        if (failed) {
          const stale =
            response.errcode === STALE_TOKEN_ERRCODE || response.ret === STALE_TOKEN_ERRCODE;
          if (stale) {
            emit({
              type: 'stale-token',
              errcode: STALE_TOKEN_ERRCODE,
              ...(response.errmsg ? { errmsg: response.errmsg } : {}),
            });
            return;
          }
          consecutiveFailures += 1;
          emit({
            type: 'error',
            error: new Error(
              `getUpdates ret=${response.ret} errcode=${response.errcode} errmsg=${response.errmsg ?? '(none)'}`,
            ),
            consecutiveFailures,
          });
          await sleep(consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS, opts.signal);
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) consecutiveFailures = 0;
          continue;
        }

        consecutiveFailures = 0;
        emit({ type: 'poll' });

        if (response.get_updates_buf) {
          syncBuf = response.get_updates_buf;
          saveSyncBuf(opts.dataDir, opts.accountId, syncBuf);
        }

        for (const message of response.msgs ?? []) {
          if (!message.from_user_id) continue;
          if (isBotMessage(message)) continue;
          if (dedup.isDuplicate(message.message_id)) continue;
          // Replies must echo the peer's latest token, so persist it as soon as
          // it arrives — before any consumer decides what to do with the message.
          const contextToken = message.context_token?.trim();
          if (contextToken) {
            setContextToken(opts.dataDir, opts.accountId, message.from_user_id, contextToken);
          }
          await emit({ type: 'message', message });
        }
      } catch (error) {
        if (opts.signal?.aborted) break;
        consecutiveFailures += 1;
        emit({ type: 'error', error, consecutiveFailures });
        await sleep(consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS, opts.signal);
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) consecutiveFailures = 0;
      }
    }
  } finally {
    await notifyStop({
      baseUrl: opts.baseUrl,
      ...(opts.token ? { token: opts.token } : {}),
      ...(opts.botAgent ? { botAgent: opts.botAgent } : {}),
    }).catch(() => undefined);
    lock.release();
    await emit({ type: 'stopped' });
  }
}

/** Describe a monitor failure for logs without leaking request bodies. */
export function describeMonitorError(error: unknown): string {
  const classified = classifyFetchError(error);
  return `${classified.description} (${classified.kind}${classified.code ? `/${classified.code}` : ''})`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
