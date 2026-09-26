/**
 * Model-facing `weixin_send` tool: lets an agent push a text message to a WeChat
 * contact through a connected account.
 *
 * The relay itself lives in {@link WeixinService}; this module owns only the
 * schema, validation, and presentation.
 *
 * @module @5havv/dsh-weixin/tool
 */

import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';

import type { WeixinService } from './service.js';

/**
 * Register the `weixin_send` tool and its system-prompt guidance.
 *
 * @param ctx - context whose `tools`/`systemPrompt` registries receive the
 *   registrations; both are effect-scoped and unwind with the plugin.
 * @param service - the connected Weixin service used to perform the send.
 * @param defaultAccountId - account used when the model omits `accountId`.
 */
export function applyWeixinSendTool(
  ctx: Context,
  service: WeixinService,
  defaultAccountId?: string,
): void {
  ctx.systemPrompt.section({
    name: 'tool:weixin_send',
    order: 120,
    text:
      'Use the weixin_send tool to push a message to a WeChat contact, optionally with a ' +
      'local file attached (images, video, and documents are supported). ' +
      'It only reaches contacts that have already messaged this bot; replies to an ' +
      'inbound WeChat message are sent automatically and do not need this tool.',
  });

  ctx.tools.register(
    defineTool({
      name: 'weixin_send',
      description:
        'Send a message to a WeChat contact through a connected Weixin account. ' +
        'Pass filePath to attach a local file (sent as an image, video, or document by its type). ' +
        'Use it for proactive messages; ordinary replies to a WeChat conversation are automatic.',
      parameters: {
        toUserId: {
          type: 'string',
          required: true,
          description: 'Target WeChat peer id, e.g. "o9cq…@im.wechat".',
        },
        text: {
          type: 'string',
          description:
            'Message text. Long text is chunked automatically. When filePath is given this ' +
            'becomes the caption sent before the file.',
        },
        filePath: {
          type: 'string',
          description: 'Absolute path of a local file to attach (max 20 MiB by default).',
        },
        accountId: {
          type: 'string',
          description: 'Weixin account id to send from; defaults to the connected account.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            accountId: { type: 'string', required: true },
            toUserId: { type: 'string', required: true },
            messageIds: {
              type: 'array',
              required: true,
              items: { type: 'string' },
            },
            usedTokenlessFallback: { type: 'boolean', required: true },
            kind: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text:
              `Sent ${value.messageIds.length} ${value.kind === 'media' ? 'media ' : ''}message(s) ` +
              `to ${value.toUserId} via ${value.accountId}.` +
              (value.usedTokenlessFallback ? ' (delivered without a conversation token)' : ''),
          },
        ],
      },
      isConcurrencySafe: () => false,
      async execute(args) {
        const accountId = args.accountId?.trim() || defaultAccountId || service.defaultAccountId();
        if (!accountId) {
          throw new Error(
            'weixin_send: no account available; configure one under the weixin plugin first.',
          );
        }
        const text = args.text?.trim() ?? '';
        const filePath = args.filePath?.trim();

        if (!text && !filePath) {
          throw new Error('weixin_send: pass text, filePath, or both.');
        }

        const result = filePath
          ? await service.sendMedia(accountId, args.toUserId, filePath, text || undefined)
          : await service.sendText(accountId, args.toUserId, text);

        return {
          accountId,
          toUserId: args.toUserId,
          messageIds: result.messageIds.filter((id) => id !== ''),
          usedTokenlessFallback: result.usedTokenlessFallback,
          kind: filePath ? 'media' : 'text',
        };
      },
    }),
  );
}
