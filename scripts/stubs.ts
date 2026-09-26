/**
 * Minimal service stand-ins used by the verification scripts.
 *
 * Each stub mirrors the real DSH service contract that the plugin actually
 * depends on — in particular, registries scope their entries to the *calling*
 * fiber via Cordis's caller-traced `this.ctx`, exactly like the real
 * `ToolRuntime`/system-prompt registries do.
 *
 * @module @5havv/dsh-weixin/scripts/stubs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Context, Service } from '@deepseek-ai/cordis';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';

/** Stand-in for the DSH tool registry. */
export class StubTools extends Service {
  readonly registered: ToolDefinition[] = [];

  constructor(ctx: Context) {
    super(ctx, 'tools');
  }

  register(definition: ToolDefinition): () => void {
    return this.ctx.effect(() => {
      this.registered.push(definition);
      return () => {
        const index = this.registered.indexOf(definition);
        if (index >= 0) this.registered.splice(index, 1);
      };
    });
  }
}

/** Stand-in for the DSH system-prompt registry. */
export class StubSystemPrompt extends Service {
  readonly sections: { name: string; order?: number }[] = [];

  constructor(ctx: Context) {
    super(ctx, 'systemPrompt');
  }

  section(section: { name: string; order?: number }): () => void {
    return this.ctx.effect(() => {
      this.sections.push(section);
      return () => {
        const index = this.sections.indexOf(section);
        if (index >= 0) this.sections.splice(index, 1);
      };
    });
  }
}

/** One message handed to a stubbed agent. */
export interface SentMessage {
  content: { type: string; text?: string }[];
  source: { kind: string; [key: string]: unknown };
  target: string;
  wakeup: boolean;
}

/** Stand-in for a live agent, recording whatever the bridge dispatches. */
export class StubAgent {
  readonly sent: SentMessage[] = [];

  constructor(readonly id: string) {}

  send(message: SentMessage, target: string, wakeup: boolean): void {
    this.sent.push({ ...message, target, wakeup });
  }
}

/** Creation options recorded by {@link StubAgents}. */
export interface RecordedCreateOptions {
  sessionId: unknown;
  agentOptions?: { provider?: string; model?: string; reasoningEffort?: unknown };
  agentPreset?: string;
  cwd?: string;
}

/** Stand-in for the agent registry. */
export class StubAgents extends Service {
  readonly agents = new Map<string, StubAgent>();
  /** Every `create` call, in order, with the options the bridge passed. */
  readonly createOptions: RecordedCreateOptions[] = [];
  /**
   * Session ids whose `create` must fail as if the session already exists on
   * disk — the state a second DSH instance sees when another process still
   * holds the session's write handle.
   */
  readonly conflicting = new Set<string>();
  createCalls = 0;

  constructor(ctx: Context) {
    super(ctx, 'agents');
  }

  get(id: unknown): StubAgent | undefined {
    return this.agents.get(String(id));
  }

  async create(options: {
    sessionId: unknown;
    agentOptions?: RecordedCreateOptions['agentOptions'];
    meta?: { cwd?: string; agentPreset?: string };
  }): Promise<{ agent: StubAgent; dispose(): Promise<void> }> {
    const id = String(options.sessionId);
    if (this.conflicting.has(id)) {
      throw new Error(`SessionAlreadyExistsError: session "${id}" already exists`);
    }
    this.createOptions.push({
      sessionId: options.sessionId,
      ...(options.agentOptions ? { agentOptions: options.agentOptions } : {}),
      ...(options.meta?.agentPreset ? { agentPreset: options.meta.agentPreset } : {}),
      ...(options.meta?.cwd ? { cwd: options.meta.cwd } : {}),
    });
    const agent = new StubAgent(id);
    this.agents.set(id, agent);
    this.createCalls += 1;
    return { agent, dispose: async () => undefined };
  }

  async resume(): Promise<{ agent: StubAgent; dispose(): Promise<void> }> {
    throw new Error('SessionAlreadyOwnedError: session is already owned by an active write handle');
  }
}

/**
 * Stand-in for `ctx.agentDefaultModel`.
 *
 * The agent loop applies no default model of its own, so a bridge that omits
 * `agentOptions` produces an agent whose first request fails with an empty
 * provider. This stub lets the integration checks assert the bridge reads the
 * deployment default.
 */
export class StubAgentDefaultModel extends Service {
  constructor(
    ctx: Context,
    private readonly selection: {
      provider: string;
      model: string;
      reasoningEffort?: unknown;
    } = { provider: 'stub-provider', model: 'stub-model' },
  ) {
    super(ctx, 'agentDefaultModel');
  }

  currentSelection(): { provider: string; model: string; reasoningEffort?: unknown } {
    return this.selection;
  }
}

/** Stand-in for the Weixin service, recording outbound sends. */
export class StubWeixin extends Service {
  readonly sent: { accountId: string; toUserId: string; text: string }[] = [];
  /** Where the bridge persists per-peer session choices. */
  readonly dataDirectory: string;

  constructor(ctx: Context, config?: { dataDir?: string }) {
    super(ctx, 'weixin');
    this.dataDirectory =
      config?.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-stub-'));
  }

  async sendText(accountId: string, toUserId: string, text: string): Promise<{ messageIds: string[]; usedTokenlessFallback: boolean }> {
    this.sent.push({ accountId, toUserId, text });
    return { messageIds: ['stub-1'], usedTokenlessFallback: false };
  }
}
