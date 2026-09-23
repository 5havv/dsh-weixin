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

/** Stand-in for the agent registry. */
export class StubAgents extends Service {
  readonly agents = new Map<string, StubAgent>();
  createCalls = 0;

  constructor(ctx: Context) {
    super(ctx, 'agents');
  }

  get(id: unknown): StubAgent | undefined {
    return this.agents.get(String(id));
  }

  async create(options: { sessionId: unknown }): Promise<{ agent: StubAgent; dispose(): Promise<void> }> {
    const id = String(options.sessionId);
    const agent = new StubAgent(id);
    this.agents.set(id, agent);
    this.createCalls += 1;
    return { agent, dispose: async () => undefined };
  }

  async resume(): Promise<{ agent: StubAgent; dispose(): Promise<void> }> {
    throw new Error('stub: no persisted session');
  }
}

/** Stand-in for the Weixin service, recording outbound sends. */
export class StubWeixin extends Service {
  readonly sent: { accountId: string; toUserId: string; text: string }[] = [];

  constructor(ctx: Context) {
    super(ctx, 'weixin');
  }

  async sendText(accountId: string, toUserId: string, text: string): Promise<{ messageIds: string[]; usedTokenlessFallback: boolean }> {
    this.sent.push({ accountId, toUserId, text });
    return { messageIds: ['stub-1'], usedTokenlessFallback: false };
  }
}
