/**
 * `ctx.weixin` — the Weixin channel service.
 *
 * Owns every account connection: the inbound long poll, credential and
 * context-token storage, and outbound delivery. Other plugins consume it as a
 * service and/or subscribe to its events; the bridge plugin drives an agent
 * from those events.
 *
 * @module @5havv/dsh-weixin/service
 */

import { Service, type Context } from '@deepseek-ai/cordis';

import {
  DEFAULT_BASE_URL,
  listAccountIds,
  loadAccount,
  resolveDataDir,
} from './auth/accounts.js';
import { Config as ConfigSchema, type Config as WeixinConfig } from './config.js';
import { runMonitor } from './inbound.js';
import { extractText } from './message.js';
import { sendTextToPeer, type SendTextResult } from './outbound.js';
import type { MessageItem } from './protocol/types.js';
import { applyWeixinSendTool } from './tool.js';

/** A normalized inbound WeChat message handed to consumers. */
export interface WeixinInboundMessage {
  accountId: string;
  /** Peer that sent the message. */
  fromUserId: string;
  messageId?: string;
  /** Epoch milliseconds the backend assigned to the message. */
  createdAt: number;
  /** Concatenated text of the message's text items ("" for media-only). */
  text: string;
  /** Raw item list, so consumers can detect media or quotes. */
  itemList: MessageItem[];
  /** Conversation token required to reply; stored automatically. */
  contextToken?: string;
  /** Present when the message came from a group chat. */
  groupId?: string;
}

/** One account's public state. */
export interface WeixinAccountStatus {
  accountId: string;
  baseUrl: string;
  connected: boolean;
  /** Last WeChat user id bound to this account, when known. */
  userId?: string;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    weixin: WeixinService;
  }
  interface Events {
    /** One deduplicated inbound WeChat message. @mode emit */
    'weixin/message'(message: WeixinInboundMessage): void;
    /** An account's long poll came up. @mode emit */
    'weixin/connected'(payload: { accountId: string }): void;
    /** An account's long poll stopped. @mode emit */
    'weixin/disconnected'(payload: { accountId: string; error?: string }): void;
    /** The backend reported a stale token; a re-login is required. @mode emit */
    'weixin/stale-token'(payload: { accountId: string; errcode: number }): void;
  }
}

interface RunningMonitor {
  controller: AbortController;
  done: Promise<void>;
}

/**
 * Weixin channel service (mounted as `ctx.weixin`).
 */
export class WeixinService extends Service {
  static inject = ['tools', 'systemPrompt'];
  static Config = ConfigSchema;

  private readonly settings: WeixinConfig;
  private readonly dataDir: string;
  private readonly monitors = new Map<string, RunningMonitor>();
  private readonly handlers = new Set<(message: WeixinInboundMessage) => void>();

  constructor(ctx: Context, config: WeixinConfig) {
    super(ctx, 'weixin');
    this.settings = config;
    this.dataDir = resolveDataDir(config.dataDir);

    if (config.toolEnabled !== false) {
      applyWeixinSendTool(ctx, this, config.accounts?.[0]);
    }

    // Own the connections' lifetime: start with the plugin, stop on unload.
    ctx.effect(() => {
      if (config.autoConnect !== false) void this.connectAll();
      return () => {
        void this.disconnectAll();
      };
    });
  }

  /** The resolved data directory backing this service. */
  get dataDirectory(): string {
    return this.dataDir;
  }

  /** The account used when a caller does not name one. */
  defaultAccountId(): string | undefined {
    const configured = this.settings.accounts?.filter((id) => id.trim() !== '') ?? [];
    return configured[0] ?? listAccountIds(this.dataDir).at(-1);
  }

  /** List every stored account with its connection state. */
  listAccounts(): WeixinAccountStatus[] {
    return listAccountIds(this.dataDir).map((accountId) => {
      const data = loadAccount(this.dataDir, accountId);
      return {
        accountId,
        baseUrl: data?.base_url?.trim() || DEFAULT_BASE_URL,
        connected: this.monitors.has(accountId),
        ...(data?.user_id ? { userId: data.user_id } : {}),
      };
    });
  }

  /** Whether an inbound long poll is currently running for one account. */
  isConnected(accountId: string): boolean {
    return this.monitors.has(accountId);
  }

  /** Connect every configured account (or all stored ones when none is named). */
  async connectAll(): Promise<void> {
    const configured = this.settings.accounts?.filter((id) => id.trim() !== '') ?? [];
    const targets = configured.length > 0 ? configured : listAccountIds(this.dataDir);
    for (const accountId of targets) await this.connect(accountId);
  }

  /** Stop every running account monitor. */
  async disconnectAll(): Promise<void> {
    await Promise.all([...this.monitors.keys()].map((accountId) => this.disconnect(accountId)));
  }

  /**
   * Open the inbound long poll for one account.
   *
   * Idempotent: an already-connected account is left untouched. A running
   * monitor is a supervised background task, so failures surface as
   * `weixin/disconnected` rather than as a rejection here.
   *
   * @param accountId - stored account identity.
   * @throws when the account has no stored credentials.
   */
  async connect(accountId: string): Promise<void> {
    if (this.monitors.has(accountId)) return;
    const account = loadAccount(this.dataDir, accountId);
    if (!account?.token) {
      throw new Error(`weixin: account ${accountId} has no stored token; run the login flow first`);
    }
    const baseUrl = account.base_url?.trim() || DEFAULT_BASE_URL;
    const controller = new AbortController();

    const done = runMonitor({
      accountId,
      baseUrl,
      token: account.token,
      ...(this.settings.botAgent ? { botAgent: this.settings.botAgent } : {}),
      ...(this.settings.pollTimeoutMs ? { longPollTimeoutMs: this.settings.pollTimeoutMs } : {}),
      dataDir: this.dataDir,
      signal: controller.signal,
      onEvent: (event) => {
        switch (event.type) {
          case 'started':
            this.ctx.emit('weixin/connected', { accountId });
            break;
          case 'message': {
            const incoming = event.message;
            const fromUserId = incoming.from_user_id ?? '';
            // The context token is already persisted by the inbound loop.
            const contextToken = incoming.context_token?.trim();
            const payload: WeixinInboundMessage = {
              accountId,
              fromUserId,
              ...(incoming.message_id ? { messageId: incoming.message_id } : {}),
              createdAt: incoming.create_time_ms ?? Date.now(),
              text: extractText(incoming.item_list),
              itemList: incoming.item_list ?? [],
              ...(contextToken ? { contextToken } : {}),
              ...(incoming.group_id ? { groupId: incoming.group_id } : {}),
            };
            for (const handler of this.handlers) handler(payload);
            this.ctx.emit('weixin/message', payload);
            break;
          }
          case 'stale-token':
            this.ctx.emit('weixin/stale-token', { accountId, errcode: event.errcode });
            break;
          case 'error':
            this.ctx.logger?.warn?.('weixin monitor error', { accountId, error: String(event.error) });
            break;
          case 'stopped':
            this.ctx.emit('weixin/disconnected', { accountId });
            break;
          default:
            break;
        }
      },
    }).finally(() => {
      this.monitors.delete(accountId);
    });

    this.monitors.set(accountId, { controller, done });
  }

  /**
   * Stop one account's long poll and wait for it to drain.
   *
   * @param accountId - account identity.
   */
  async disconnect(accountId: string): Promise<void> {
    const running = this.monitors.get(accountId);
    if (!running) return;
    running.controller.abort();
    await running.done;
    this.monitors.delete(accountId);
  }

  /**
   * Send text to a WeChat peer, chunking long text and applying the
   * stale-session fallback.
   *
   * @param accountId - sending account.
   * @param toUserId - target peer id.
   * @param text - message body.
   * @returns the assigned message ids.
   */
  async sendText(accountId: string, toUserId: string, text: string): Promise<SendTextResult> {
    const account = loadAccount(this.dataDir, accountId);
    if (!account?.token) {
      throw new Error(`weixin: account ${accountId} has no stored token`);
    }
    return sendTextToPeer({
      dataDir: this.dataDir,
      accountId,
      baseUrl: account.base_url?.trim() || DEFAULT_BASE_URL,
      token: account.token,
      ...(this.settings.botAgent ? { botAgent: this.settings.botAgent } : {}),
      ...(this.settings.maxMessageLength ? { maxChunkLength: this.settings.maxMessageLength } : {}),
      toUserId,
      text,
      onStaleSession: (peerId) => {
        this.ctx.logger?.warn?.(`weixin: stale context token for ${peerId}; resent without it`);
      },
    });
  }

  /**
   * Subscribe to inbound messages without going through Cordis events.
   *
   * @param handler - called for every deduplicated inbound message.
   * @returns a disposer removing the handler.
   */
  onMessage(handler: (message: WeixinInboundMessage) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}

export default WeixinService;
