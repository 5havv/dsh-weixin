/**
 * Runtime verification for the Weixin service plugin.
 *
 * Boots a minimal Cordis host with stub `tools`/`systemPrompt` services, mounts
 * the real {@link WeixinService}, and asserts the service occupies `ctx.weixin`,
 * registers the `weixin_send` tool, and unwinds every registration on dispose.
 * Offline: `autoConnect` is disabled, so no network or stored credentials are
 * required.
 *
 * @module @5havv/dsh-weixin/scripts/verify-plugin
 */

import { Context } from '@deepseek-ai/cordis';

import { WeixinService } from '../src/service.js';
import { StubSystemPrompt, StubTools } from './stubs.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`verify-plugin: ${message}`);
}

async function main(): Promise<void> {
  const ctx = new Context();
  await ctx.plugin(StubTools);
  await ctx.plugin(StubSystemPrompt);

  const fiber = await ctx.plugin(WeixinService, {
    dataDir: '/tmp/dsh-weixin-verify',
    autoConnect: false,
    accounts: ['demo@im.bot'],
  });

  assert(ctx.weixin instanceof WeixinService, 'ctx.weixin should expose the WeixinService');
  assert(ctx.weixin.dataDirectory === '/tmp/dsh-weixin-verify', 'dataDir should come from config');
  assert(
    ctx.weixin.defaultAccountId() === 'demo@im.bot',
    'defaultAccountId should prefer the configured account',
  );

  const tools = ctx.get('tools') as StubTools;
  const sendTool = tools.registered.find((tool) => tool.name === 'weixin_send');
  assert(sendTool, 'weixin_send tool should be registered');
  assert(typeof sendTool.execute === 'function', 'weixin_send should expose an execute function');

  // `defineTool` compiles the shorthand spec into standard JSON Schema.
  const parameters = sendTool.parameters as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  assert(parameters.properties?.toUserId, 'weixin_send should declare a toUserId parameter');
  assert(parameters.properties?.text, 'weixin_send should declare a text parameter');
  assert(
    Array.isArray(parameters.required) && parameters.required.includes('toUserId'),
    'weixin_send should require toUserId',
  );

  const prompt = ctx.get('systemPrompt') as StubSystemPrompt;
  assert(
    prompt.sections.some((section) => section.name === 'tool:weixin_send'),
    'system-prompt guidance for weixin_send should be registered',
  );

  await fiber.dispose();
  assert(!ctx.get('weixin'), 'ctx.weixin should be released after dispose');
  assert(
    !(ctx.get('tools') as StubTools).registered.some((tool) => tool.name === 'weixin_send'),
    'weixin_send should be unregistered after dispose',
  );

  process.stdout.write('✅ verify-plugin: service mounts, tool registers, dispose unwinds\n');
}

main().catch((error: unknown) => {
  process.stderr.write(
    `❌ verify-plugin failed: ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
