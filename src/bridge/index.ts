/**
 * Weixin ↔ agent bridge.
 *
 * Turns inbound WeChat direct messages into agent turns and pushes the agent's
 * reply back to the same conversation. Session routing is `per-peer` by default:
 * every contact gets an independent agent and session, so memories never bleed
 * between conversations.
 *
 * This is a consumer plugin: it depends on `ctx.weixin` (the channel service)
 * and `ctx.agents` (the agent registry) and owns no protocol code of its own.
 *
 * @module @5havv/dsh-weixin/bridge
 */

import type { Context } from '@deepseek-ai/cordis';
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent';
import {
  createUserMessage,
  type AssistantMessage,
  type ReasoningEffortId,
} from '@deepseek-ai/dsh-llm';
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session';

import type { WeixinInboundMessage } from '../service.js';
import { Config as BridgeConfigSchema, type BridgeConfig } from './config.js';

export const name = 'weixin-bridge';

/** The channel service and the agent registry are both required. */
export const inject = ['weixin', 'agents'];

export const Config = BridgeConfigSchema;

declare module '@deepseek-ai/dsh-llm/message' {
  interface MessageSourceMap {
    /** A message relayed from a WeChat conversation. */
    weixin: {
      kind: 'weixin';
      accountId: string;
      peerId: string;
    };
  }
}

/** Routing record for one live conversation. */
interface PeerLink {
  accountId: string;
  peerId: string;
}

/**
 * Whether an inbound message may drive an agent.
 *
 * Direct messages and group messages have independent policies; group traffic
 * defaults to disabled because the iLink bot identity usually receives none.
 *
 * @param message - the inbound message.
 * @param config - bridge configuration.
 * @returns true when the message should be processed.
 */
function isAllowed(message: WeixinInboundMessage, config: BridgeConfig): boolean {
  if (message.groupId) {
    const policy = config.groupPolicy ?? 'disabled';
    if (policy === 'disabled') return false;
    if (policy === 'allowlist') return (config.groupAllowlist ?? []).includes(message.groupId);
    return true;
  }
  const policy = config.dmPolicy ?? 'open';
  if (policy === 'disabled') return false;
  if (policy === 'allowlist') return (config.allowlist ?? []).includes(message.fromUserId);
  return true;
}

/** Structural view of the deployment's default-model service (`ctx.agentDefaultModel`). */
interface DefaultModelService {
  currentSelection(): { provider: string; model: string; reasoningEffort?: ReasoningEffortId };
}

/**
 * Resolve the model for agents this bridge creates.
 *
 * The agent loop applies no default model of its own: every other
 * agent-creating subsystem (`dsh-webhook`, `dsh-headless`, the web session
 * controller) reads `agentDefaultModel.currentSelection()` explicitly. Without
 * this, a created agent's very first model request fails immediately with an
 * empty provider.
 *
 * @param ctx - context that may carry the deployment's default-model service.
 * @param config - bridge config; an explicit provider+model pair wins when both are set.
 * @returns options for `agents.create`/`resume`, or undefined when none can be resolved.
 */
function resolveAgentOptions(ctx: Context, config: BridgeConfig): AgentOptions | undefined {
  if (config.provider && config.model) {
    return { provider: config.provider, model: config.model };
  }
  // `agentDefaultModel` is optional: not every composition mounts it, and this
  // plugin must not fail to load because it is absent.
  const service = (ctx as unknown as { get(name: string): unknown }).get('agentDefaultModel') as
    | DefaultModelService
    | undefined;
  try {
    const selected = service?.currentSelection();
    if (selected?.provider && selected?.model) {
      return {
        provider: selected.provider,
        model: selected.model,
        ...(selected.reasoningEffort ? { reasoningEffort: selected.reasoningEffort } : {}),
      };
    }
  } catch {
    // A default-model service mid-teardown simply resolves to none.
  }
  return undefined;
}

/** Concatenate the text blocks of one assembled assistant message. */
function textOf(message: AssistantMessage): string {
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('').trim();
}

/**
 * Mount the bridge.
 *
 * @param ctx - context carrying `weixin` and `agents`.
 * @param config - resolved bridge configuration.
 */
export function apply(ctx: Context, config: BridgeConfig): void {
  if (config.enabled === false) return;

  ctx.logger?.info?.(
    `weixin-bridge: enabled (sessionMode=${config.sessionMode ?? 'per-peer'}, ` +
      `dmPolicy=${config.dmPolicy ?? 'open'}, groupPolicy=${config.groupPolicy ?? 'disabled'})`,
  );

  /** sessionId -> conversation routing. */
  const links = new Map<string, PeerLink>();
  /**
   * `sessionId#turn` -> assistant text accumulated for that turn. Keying by turn
   * (rather than by session) keeps a fast follow-up message from discarding the
   * reply still being assembled for the turn before it.
   */
  const buffers = new Map<string, string[]>();
  /**
   * canonical session key -> in-flight agent creation. Two messages from the
   * same contact can arrive before the first agent is published; without this,
   * both would call `agents.create` and the second would fail on a duplicate id.
   */
  const pendingAgents = new Map<string, Promise<{ agent: Agent; sessionId: SessionId }>>();

  const bufferKey = (sessionId: string, turn: number): string => `${sessionId}#${turn}`;

  const sessionKeyFor = (message: WeixinInboundMessage): string =>
    config.sessionMode === 'shared'
      ? 'weixin:shared'
      : `weixin:${message.accountId}:${message.fromUserId}`;

  /** Compose the agent's scoped world before it is published. */
  const setup = (agentCtx: Context): void => {
    agentCtx.get('systemPrompt')?.section({
      name: 'weixin-channel',
      order: 90,
      text:
        'Your reply is delivered to the user over WeChat. Keep it concise and ' +
        'self-contained: very long answers are split into several messages, and ' +
        'attachments cannot be sent back yet.',
    });
  };

  /**
   * Session identities tried for one conversation, in order.
   *
   * The first is the stable per-peer id. The second is a fallback used when the
   * primary session exists on disk but cannot be opened in this process — for
   * example when another live DSH instance still holds its write handle. Without
   * it the contact would be stuck forever with no way to reach the bot.
   */
  const sessionCandidates = (canonical: string): SessionId[] => [
    SessionId(canonical),
    SessionId(`${canonical}:b`),
  ];

  /**
   * Resolve the live agent for one conversation, creating or resuming it.
   *
   * @param canonical - the stable per-peer session key.
   * @returns the agent together with the session id actually in use.
   * @throws when no candidate session could be opened.
   */
  const ensureAgent = (canonical: string): Promise<{ agent: Agent; sessionId: SessionId }> => {
    const existing = pendingAgents.get(canonical);
    if (existing) return existing;

    const inFlight = (async (): Promise<{ agent: Agent; sessionId: SessionId }> => {
      const agentOptions = resolveAgentOptions(ctx, config);
      if (!agentOptions) {
        ctx.logger?.warn?.(
          'weixin-bridge: no model resolved (config provider/model empty and agentDefaultModel ' +
            'unavailable) — the agent will fail its first request',
        );
      }
      const meta = {
        cwd: process.cwd(),
        ...(config.agentPreset ? { agentPreset: config.agentPreset } : {}),
      };
      const hasPersistence = Boolean(ctx.get('sessionPersistence'));
      let lastError: unknown;

      for (const sessionId of sessionCandidates(canonical)) {
        const live = ctx.agents.get(sessionId);
        if (live) return { agent: live, sessionId };

        if (hasPersistence) {
          try {
            const handle = await ctx.agents.resume({
              resumeSessionId: sessionId,
              ...(agentOptions ? { agentOptions } : {}),
              setup,
            });
            return { agent: handle.agent, sessionId };
          } catch (error) {
            lastError = error;
            ctx.logger?.info?.(
              `weixin-bridge: no resumable session ${sessionId} (${String(error)})`,
            );
          }
        }

        try {
          const handle = await ctx.agents.create({
            sessionId,
            meta,
            ...(agentOptions ? { agentOptions } : {}),
            setup,
          });
          return { agent: handle.agent, sessionId };
        } catch (error) {
          lastError = error;
          ctx.logger?.warn?.(`weixin-bridge: could not open session ${sessionId}: ${String(error)}`);
        }
      }
      throw lastError ?? new Error('weixin-bridge: no session candidate could be opened');
    })();

    // A failed creation must not be cached, or the contact could never retry.
    const tracked = inFlight.catch((error: unknown) => {
      pendingAgents.delete(canonical);
      throw error;
    });
    pendingAgents.set(canonical, tracked);
    return tracked;
  };

  const onInbound = async (message: WeixinInboundMessage): Promise<void> => {
    if (!isAllowed(message, config)) {
      ctx.logger?.info?.(
        `weixin-bridge: ignoring message from ${message.fromUserId} ` +
          `(group=${message.groupId ?? 'no'}, dmPolicy=${config.dmPolicy ?? 'open'})`,
      );
      return;
    }
    const text = message.text.trim();
    if (!text) {
      // v0.1 handles text only; media arrives in v0.2.
      ctx.logger?.info?.(
        `weixin-bridge: ignoring message from ${message.fromUserId} with no text ` +
          `(itemTypes=[${message.itemList.map((item) => item.type).join(',')}])`,
      );
      return;
    }

    const canonical = sessionKeyFor(message);
    const link: PeerLink = { accountId: message.accountId, peerId: message.fromUserId };

    try {
      const { agent, sessionId } = await ensureAgent(canonical);
      links.set(sessionId, link);
      agent.send(
        createUserMessage({
          content: [{ type: 'text', text }],
          source: {
            kind: 'weixin',
            accountId: message.accountId,
            peerId: message.fromUserId,
          },
        }),
        'next-turn',
        true,
      );
      ctx.logger?.info?.(
        `weixin-bridge: dispatched message from ${message.fromUserId} to session ${sessionId}`,
      );
    } catch (error) {
      // Never drop a contact's message silently: tell them the bot failed.
      ctx.logger?.error?.(
        `weixin-bridge: failed to dispatch message from ${message.fromUserId}: ${String(error)}`,
      );
      void ctx.weixin
        .sendText(
          link.accountId,
          link.peerId,
          '⚠️ 你的消息已收到，但 DSH 侧无法打开这段会话（可能是另一个 DSH 实例仍占用它）。' +
            '请检查后重试。',
        )
        .catch(() => undefined);
    }
  };

  const onSessionEvent = (session: Session, event: SessionEvent): void => {
    const link = links.get(session.id);
    if (!link) return;

    if (event.type === 'assistant/message') {
      const text = textOf(event.data.message);
      if (text) {
        const key = bufferKey(session.id, event.data.turn);
        const buffer = buffers.get(key) ?? [];
        buffer.push(text);
        buffers.set(key, buffer);
      }
      return;
    }

    if (event.type !== 'turn/end') return;

    const key = bufferKey(session.id, event.data.turn);
    const reply = (buffers.get(key) ?? []).join('\n\n').trim();
    buffers.delete(key);
    if (!reply) return;

    void ctx.weixin
      .sendText(link.accountId, link.peerId, reply)
      .then(() => {
        ctx.logger?.info?.(`weixin-bridge: replied to ${link.peerId} (${reply.length} chars)`);
      })
      .catch((error: unknown) => {
        ctx.logger?.warn?.(
          `weixin-bridge: reply to ${link.peerId} failed: ${String(error)}`,
        );
      });
  };

  ctx.on('weixin/message', (message) => {
    void onInbound(message);
  });
  ctx.on('session/event', onSessionEvent);
}
