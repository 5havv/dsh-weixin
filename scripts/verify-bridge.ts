/**
 * Runtime verification for the Weixin↔agent bridge.
 *
 * Boots a Cordis host with stub `weixin`/`agents`/`tools`/`systemPrompt`
 * services, mounts the real bridge, then drives one inbound message and one
 * assistant turn through it. Asserts the inbound text reaches an agent and the
 * assembled reply goes back out over WeChat — plus that policy gating works.
 *
 * @module @5havv/dsh-weixin/scripts/verify-bridge
 */

import { Context } from '@deepseek-ai/cordis';

import { apply as applyBridge } from '../src/bridge/index.js';
import { StubAgents, StubSystemPrompt, StubTools, StubWeixin } from './stubs.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`verify-bridge: ${message}`);
}

/** Let queued microtasks (the bridge's async inbound handler) run. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

interface Host {
  ctx: Context;
  agents: StubAgents;
  weixin: StubWeixin;
  dispose(): Promise<void>;
}

async function boot(bridgeConfig: Record<string, unknown>): Promise<Host> {
  const ctx = new Context();
  await ctx.plugin(StubTools);
  await ctx.plugin(StubSystemPrompt);
  await ctx.plugin(StubWeixin);
  await ctx.plugin(StubAgents);
  const fiber = await ctx.plugin({ inject: ['weixin', 'agents'], apply: applyBridge }, bridgeConfig);
  return {
    ctx,
    agents: ctx.get('agents') as StubAgents,
    weixin: ctx.get('weixin') as StubWeixin,
    dispose: async () => {
      await fiber.dispose();
    },
  };
}

/** Emit one inbound WeChat message through the channel service's event. */
function inbound(host: Host, fromUserId: string, text: string, accountId = 'acct@im.bot'): void {
  host.ctx.emit('weixin/message', {
    accountId,
    fromUserId,
    createdAt: Date.now(),
    text,
    itemList: [{ type: 1, text_item: { text } }],
    contextToken: 'ctx-token',
  });
}

/** Emit one assembled assistant message for a turn. */
function assistantMessage(host: Host, sessionId: string, reply: string, turn = 1): void {
  host.ctx.emit(
    'session/event',
    { id: sessionId } as never,
    {
      type: 'assistant/message',
      seq: 1,
      time: Date.now(),
      data: { turn, step: 1, message: { content: [{ type: 'text', text: reply }] }, stream: [] },
    } as never,
  );
}

/** Emit the turn boundary that flushes a turn's reply. */
function turnEnd(host: Host, sessionId: string, turn = 1): void {
  host.ctx.emit(
    'session/event',
    { id: sessionId } as never,
    { type: 'turn/end', seq: 2, time: Date.now(), data: { turn, reason: { kind: 'success' } } } as never,
  );
}

/** Emit one complete assistant turn (message, then boundary). */
function assistantTurn(host: Host, sessionId: string, reply: string, turn = 1): void {
  assistantMessage(host, sessionId, reply, turn);
  turnEnd(host, sessionId, turn);
}

async function main(): Promise<void> {
  // ── 1. per-peer routing: inbound text reaches a per-contact agent ──────────
  {
    const host = await boot({ enabled: true, dmPolicy: 'open', sessionMode: 'per-peer' });
    inbound(host, 'peer-a@im.wechat', '你好');
    await tick();

    assert(host.agents.createCalls === 1, 'exactly one agent should be created');
    const agent = host.agents.agents.get('weixin:acct@im.bot:peer-a@im.wechat');
    assert(agent, 'a per-peer session id should key the agent');
    assert(agent.sent.length === 1, 'the inbound message should be dispatched to the agent');
    assert(agent.sent[0]!.content[0]!.text === '你好', 'the agent should receive the message text');
    assert(agent.sent[0]!.source.kind === 'weixin', 'the message source should be tagged weixin');
    assert(agent.sent[0]!.source.peerId === 'peer-a@im.wechat', 'the source should carry the peer id');
    assert(agent.sent[0]!.target === 'next-turn', 'the message should open its own turn');
    assert(agent.sent[0]!.wakeup === true, 'the message should wake the agent');

    // ── 2. the assembled assistant reply is sent back to the same peer ───────
    assistantTurn(host, 'weixin:acct@im.bot:peer-a@im.wechat', '你好，我是 DSH。');
    await tick();

    assert(host.weixin.sent.length === 1, 'the reply should be sent over WeChat');
    assert(host.weixin.sent[0]!.toUserId === 'peer-a@im.wechat', 'the reply should target the sender');
    assert(host.weixin.sent[0]!.text === '你好，我是 DSH。', 'the reply text should be forwarded');

    // A second contact must get its own session, not the first one's.
    inbound(host, 'peer-b@im.wechat', 'hello');
    await tick();
    assert(host.agents.createCalls === 2, 'a second contact should get its own agent');
    assert(host.agents.agents.has('weixin:acct@im.bot:peer-b@im.wechat'), 'peer-b needs its own session');

    await host.dispose();
  }

  // ── 3. allowlist policy blocks everyone not listed ────────────────────────
  {
    const host = await boot({ enabled: true, dmPolicy: 'allowlist', allowlist: ['vip@im.wechat'] });
    inbound(host, 'stranger@im.wechat', 'let me in');
    await tick();
    assert(host.agents.createCalls === 0, 'a non-allowlisted sender must not reach an agent');

    inbound(host, 'vip@im.wechat', 'hi');
    await tick();
    assert(host.agents.createCalls === 1, 'an allowlisted sender should reach an agent');
    await host.dispose();
  }

  // ── 4. disabled bridge (and media-only messages) stay silent ──────────────
  {
    const host = await boot({ enabled: false });
    inbound(host, 'peer-a@im.wechat', 'hello');
    await tick();
    assert(host.agents.createCalls === 0, 'a disabled bridge must not create agents');
    await host.dispose();
  }
  {
    const host = await boot({ enabled: true, dmPolicy: 'open' });
    host.ctx.emit('weixin/message', {
      accountId: 'acct@im.bot',
      fromUserId: 'peer-a@im.wechat',
      createdAt: Date.now(),
      text: '',
      itemList: [{ type: 2, image_item: {} }],
    });
    await tick();
    assert(host.agents.createCalls === 0, 'a media-only message is out of v0.1 scope');
    await host.dispose();
  }

  // ── 5. concurrent messages from one contact create exactly one agent ──────
  {
    const host = await boot({ enabled: true, dmPolicy: 'open' });
    inbound(host, 'peer-a@im.wechat', 'first');
    inbound(host, 'peer-a@im.wechat', 'second');
    await tick();
    assert(host.agents.createCalls === 1, 'a burst must not race into duplicate agent creation');
    const agent = host.agents.agents.get('weixin:acct@im.bot:peer-a@im.wechat');
    assert(agent?.sent.length === 2, 'both messages should reach the same agent');
    await host.dispose();
  }

  // ── 6. interleaved turns keep their own reply buffers ─────────────────────
  {
    const host = await boot({ enabled: true, dmPolicy: 'open' });
    const sessionId = 'weixin:acct@im.bot:peer-a@im.wechat';
    inbound(host, 'peer-a@im.wechat', 'q1');
    await tick();
    inbound(host, 'peer-a@im.wechat', 'q2');
    await tick();

    // Turn 2 produces output before turn 1 closes: turn 1's buffer must survive.
    assistantMessage(host, sessionId, 'a1', 1);
    assistantMessage(host, sessionId, 'a2', 2);
    turnEnd(host, sessionId, 1);
    await tick();
    assert(host.weixin.sent.length === 1, 'closing turn 1 should send exactly one reply');
    assert(host.weixin.sent[0]!.text === 'a1', 'turn 1 must not pick up turn 2 output');

    turnEnd(host, sessionId, 2);
    await tick();
    assert(host.weixin.sent.length === 2, 'closing turn 2 should send its own reply');
    assert(host.weixin.sent[1]!.text === 'a2', 'turn 2 should send its own text');
    await host.dispose();
  }

  process.stdout.write(
    '✅ verify-bridge: routing, reply relay, policy, bursts, and interleaved turns all behave\n',
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `❌ verify-bridge failed: ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
