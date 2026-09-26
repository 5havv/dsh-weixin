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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Context } from '@deepseek-ai/cordis';

import { apply as applyBridge } from '../src/bridge/index.js';
import {
  StubAgentDefaultModel,
  StubAgents,
  StubAttachment,
  StubSystemPrompt,
  StubTools,
  StubWeixin,
} from './stubs.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`verify-bridge: ${message}`);
}

/** Let queued microtasks (the bridge's async inbound handler) run. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

interface Host {
  ctx: Context;
  agents: StubAgents;
  weixin: StubWeixin;
  attachment: StubAttachment;
  /** Channel data directory, where the session-choice memo is written. */
  dataDir: string;
  dispose(): Promise<void>;
}

async function boot(
  bridgeConfig: Record<string, unknown>,
  defaultModel: { provider: string; model: string } = {
    provider: 'stub-provider',
    model: 'stub-model',
  },
): Promise<Host> {
  const ctx = new Context();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-boot-'));
  await ctx.plugin(StubTools);
  await ctx.plugin(StubSystemPrompt);
  await ctx.plugin(StubWeixin, { dataDir });
  await ctx.plugin(StubAgents);
  await ctx.plugin(StubAgentDefaultModel, defaultModel);
  await ctx.plugin(StubAttachment);
  const fiber = await ctx.plugin({ inject: ['weixin', 'agents'], apply: applyBridge }, bridgeConfig);
  return {
    ctx,
    dataDir,
    agents: ctx.get('agents') as StubAgents,
    weixin: ctx.get('weixin') as StubWeixin,
    attachment: ctx.get('attachment') as StubAttachment,
    dispose: async () => {
      await fiber.dispose();
    },
  };
}

/** Emit one inbound WeChat message through the channel service's event. */
function inbound(
  host: Host,
  fromUserId: string,
  text: string,
  accountId = 'acct@im.bot',
  media: unknown[] = [],
  mediaFailures: unknown[] = [],
): void {
  host.ctx.emit('weixin/message', {
    accountId,
    fromUserId,
    createdAt: Date.now(),
    text,
    itemList: text ? [{ type: 1, text_item: { text } }] : [{ type: 2, image_item: {} }],
    media,
    mediaFailures,
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

    // Regression: the agent loop applies no default model, so a bridge-created
    // agent must carry the deployment's selection or its first request fails.
    assert(
      host.agents.createOptions[0]?.agentOptions?.provider === 'stub-provider',
      'the bridge must pass the deployment default provider',
    );
    assert(
      host.agents.createOptions[0]?.agentOptions?.model === 'stub-model',
      'the bridge must pass the deployment default model',
    );
    assert(
      typeof host.agents.createOptions[0]?.cwd === 'string',
      'the bridge must pass an absolute cwd',
    );

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
    // A message with neither text nor a retrieved attachment has nothing to say.
    const host = await boot({ enabled: true, dmPolicy: 'open' });
    inbound(host, 'peer-a@im.wechat', '');
    await tick();
    assert(host.agents.createCalls === 0, 'an empty message must not open a turn');
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

  // ── 5b. an explicit provider+model in config wins over the deployment default ──
  {
    const host = await boot({
      enabled: true,
      dmPolicy: 'open',
      provider: 'cfg-provider',
      model: 'cfg-model',
    });
    inbound(host, 'peer-a@im.wechat', 'hi');
    await tick();
    assert(
      host.agents.createOptions[0]?.agentOptions?.provider === 'cfg-provider' &&
        host.agents.createOptions[0]?.agentOptions?.model === 'cfg-model',
      'configured provider/model must override the deployment default',
    );
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

  // ── 7. a session that cannot be opened falls back to an alternate id ──────
  {
    const host = await boot({ enabled: true, dmPolicy: 'open' });
    const canonical = 'weixin:acct@im.bot:peer-a@im.wechat';
    // Simulates a live handle held by another DSH instance: resume fails and
    // create collides with the session already on disk.
    host.agents.conflicting.add(canonical);

    inbound(host, 'peer-a@im.wechat', 'hi');
    await tick();

    const fallback = `${canonical}:b`;
    assert(host.agents.agents.has(fallback), 'a blocked session must fall back to an alternate id');
    assert(
      host.agents.agents.get(fallback)?.sent.length === 1,
      'the message must still reach an agent through the fallback session',
    );
    assert(host.weixin.sent.length === 0, 'no error notice when the fallback works');
    await host.dispose();
  }

  // ── 8. when no session can be opened the contact is told, not ignored ─────
  {
    const host = await boot({ enabled: true, dmPolicy: 'open' });
    const canonical = 'weixin:acct@im.bot:peer-a@im.wechat';
    host.agents.conflicting.add(canonical);
    host.agents.conflicting.add(`${canonical}:b`);

    inbound(host, 'peer-a@im.wechat', 'hi');
    await tick();

    assert(host.agents.createCalls === 0, 'no agent can be created in this scenario');
    assert(host.weixin.sent.length === 1, 'the contact must be told the bot could not open the session');
    assert(
      host.weixin.sent[0]!.text.includes('无法打开'),
      'the notice should explain that the session could not be opened',
    );
    await host.dispose();
  }

  // ── 9. the session a conversation settled on is remembered ────────────────
  {
    const host = await boot({ enabled: true, dmPolicy: 'open' });
    const canonical = 'weixin:acct@im.bot:peer-a@im.wechat';
    host.agents.conflicting.add(canonical);

    inbound(host, 'peer-a@im.wechat', 'hi');
    await tick();

    const fallback = `${canonical}:b`;
    const memo = JSON.parse(
      fs.readFileSync(path.join(host.dataDir, 'bridge-sessions.json'), 'utf-8'),
    ) as Record<string, string>;
    assert(
      memo[canonical] === fallback,
      'the chosen session must be persisted so a restart keeps the same conversation',
    );
    await host.dispose();
  }

  // ── 10. an inbound image becomes an attachment block ──────────────────────
  {
    const host = await boot({ enabled: true, dmPolicy: 'open', attachImages: true });
    const imagePath = path.join(host.dataDir, 'photo.png');
    fs.writeFileSync(
      imagePath,
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from([1, 2, 3]),
      ]),
    );

    inbound(host, 'peer-a@im.wechat', '', 'acct@im.bot', [
      { kind: 'image', mime: 'image/png', name: 'photo.png', path: imagePath, size: 11 },
    ]);
    await tick();

    const blocks =
      host.agents.agents.get('weixin:acct@im.bot:peer-a@im.wechat')?.sent[0]?.content ?? [];
    assert(
      blocks.some((block) => block.type === 'image'),
      'an image must arrive as an attachment block, not just a path',
    );
    assert(host.attachment.savedImages.length === 1, 'the image must be stored exactly once');
    assert(
      host.attachment.savedImages[0]?.mediaType === 'image/png',
      'the detected image type must be used',
    );
    await host.dispose();
  }

  // ── 11. media the agent cannot see is described by path, failures included ─
  {
    const host = await boot({ enabled: true, dmPolicy: 'open', attachImages: false });
    const filePath = path.join(host.dataDir, 'report.pdf');
    fs.writeFileSync(filePath, Buffer.from('%PDF-1.4'));

    inbound(
      host,
      'peer-a@im.wechat',
      'see attached',
      'acct@im.bot',
      [{ kind: 'file', mime: 'application/pdf', name: 'report.pdf', path: filePath, size: 8 }],
      [{ kind: 'image', reason: 'CDN download HTTP 403' }],
    );
    await tick();

    const blocks =
      host.agents.agents.get('weixin:acct@im.bot:peer-a@im.wechat')?.sent[0]?.content ?? [];
    const note = blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('\n');
    assert(note.includes('see attached'), 'the message text must survive alongside media');
    assert(note.includes(filePath), 'the cached file path must reach the agent');
    assert(note.includes('CDN download HTTP 403'), 'a failed attachment must be reported');
    assert(host.attachment.savedImages.length === 0, 'no image block when attachImages is off');
    await host.dispose();
  }

  process.stdout.write(
    '✅ verify-bridge: routing, relay, policy, bursts, turns, session fallback, continuity, and media all behave\n',
  );
}
main().catch((error: unknown) => {
  process.stderr.write(
    `❌ verify-bridge failed: ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
