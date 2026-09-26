#!/usr/bin/env node
/**
 * M1 smoke CLI — exercises the iLink protocol layer without any DSH runtime.
 *
 * Usage:
 *   npm run smoke -- list
 *   npm run smoke -- import a1b2c3d4e5f6@im.bot [--from ~/.hermes/weixin/accounts]
 *   npm run smoke -- login
 *   npm run smoke -- listen [accountId]
 *   npm run smoke -- send <accountId> <toUserId> <text…>
 *
 * @module @5havv/dsh-weixin/smoke
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';

import {
  DEFAULT_BASE_URL,
  listAccountIds,
  loadAccount,
  loadContextTokens,
  maskToken,
  resolveDataDir,
  importAccountFromHermes,
  defaultHermesDir,
} from './auth/accounts.js';
import { startLogin, waitForLogin } from './auth/qr-login.js';
import { runMonitor } from './inbound.js';
import { extractText } from './message.js';
import { materializeInboundMedia } from './media.js';
import {
  DEFAULT_MAX_MEDIA_BYTES,
  sendMediaToPeer,
  sendTextToPeer,
} from './outbound.js';
import { CDN_BASE_URL } from './protocol/cdn.js';

async function displayQr(url: string): Promise<void> {
  try {
    const mod = (await import('qrcode-terminal')) as unknown as {
      default?: { generate(text: string, opts?: object): void };
      generate?: (text: string, opts?: object) => void;
    };
    const generator = mod.default ?? mod;
    generator.generate?.(url, { small: true });
  } catch {
    // Terminal rendering is optional; the URL below still works.
  }
  process.stdout.write(`二维码链接（无法扫码时可在微信中打开）：\n${url}\n\n`);
}

/** Where this CLI caches decrypted inbound media (mirrors the service default). */
function mediaRoot(dataDir: string): string {
  return path.join(dataDir, 'media');
}

function ask(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function resolveAccount(dataDir: string, requested?: string): { accountId: string; token?: string; baseUrl: string } {
  const ids = listAccountIds(dataDir);
  const accountId = requested?.trim() || ids.at(-1);
  if (!accountId) throw new Error(`没有已登录的账号，请先运行 login。（数据目录：${dataDir}）`);
  const data = loadAccount(dataDir, accountId);
  if (!data) throw new Error(`账号 ${accountId} 不存在于 ${dataDir}`);
  return {
    accountId,
    ...(data.token ? { token: data.token } : {}),
    baseUrl: data.base_url?.trim() || DEFAULT_BASE_URL,
  };
}

async function cmdList(dataDir: string): Promise<void> {
  const ids = listAccountIds(dataDir);
  process.stdout.write(`数据目录：${dataDir}\n`);
  if (ids.length === 0) {
    process.stdout.write('（暂无账号）\n');
    return;
  }
  for (const id of ids) {
    const data = loadAccount(dataDir, id);
    const peers = Object.keys(loadContextTokens(dataDir, id));
    process.stdout.write(
      `- ${id}  token=${maskToken(data?.token)}  base=${data?.base_url ?? DEFAULT_BASE_URL}  peers=${peers.length}\n`,
    );
  }
}

async function cmdImport(dataDir: string, accountId: string | undefined, from: string | undefined): Promise<void> {
  const sourceDir = from?.trim() || defaultHermesDir();
  const ids = accountId?.trim() ? [accountId.trim()] : listHermesAccountIds(sourceDir);
  if (ids.length === 0) throw new Error(`未在 ${sourceDir} 找到任何账号文件`);
  for (const id of ids) {
    const data = importAccountFromHermes(dataDir, id, sourceDir);
    process.stdout.write(
      `已导入 ${id} → ${dataDir}  token=${maskToken(data.token)}  base=${data.base_url}  peer=${data.user_id ?? '(unknown)'}\n`,
    );
  }
}

/** Account ids found in a Hermes/OpenClaw-style accounts directory. */
function listHermesAccountIds(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter(
        (name) =>
          name.endsWith('.json') &&
          !name.includes('.sync.') &&
          !name.includes('.context-tokens.'),
      )
      .map((name) => name.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}

async function cmdLogin(dataDir: string): Promise<void> {
  const session = await startLogin({ dataDir });
  process.stdout.write('请用手机微信扫描下方二维码完成登录：\n\n');
  await displayQr(session.qrcodeUrl);

  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());

  const result = await waitForLogin({
    sessionKey: session.sessionKey,
    dataDir,
    signal: controller.signal,
    onProgress: (progress) => process.stdout.write(`[${progress.status}] ${progress.message}\n`),
    requestVerifyCode: (retry) => ask(retry ? '验证码不正确，请重新输入：' : '请输入手机微信上显示的数字：'),
  });

  process.stdout.write(`${result.ok ? '✅' : '❌'} ${result.message}\n`);
  if (result.accountId) process.stdout.write(`accountId=${result.accountId}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

async function cmdListen(dataDir: string, requested?: string): Promise<void> {
  const { accountId, token, baseUrl } = resolveAccount(dataDir, requested);
  process.stdout.write(`开始监听 ${accountId}（${baseUrl}），Ctrl-C 退出。\n`);

  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());

  await runMonitor({
    accountId,
    baseUrl,
    ...(token ? { token } : {}),
    dataDir,
    signal: controller.signal,
    onEvent: async (event) => {
      switch (event.type) {
        case 'started':
          process.stdout.write('已连接，等待消息…\n');
          break;
        case 'message': {
          const message = event.message;
          const text = extractText(message.item_list);
          const types = message.item_list?.map((item) => item.type).join(',') ?? 'none';
          process.stdout.write(
            `\n← from=${message.from_user_id} msgId=${message.message_id ?? '?'} types=[${types}]\n` +
              `  text=${JSON.stringify(text)}\n` +
              `  context_token=${message.context_token ? 'yes' : 'no'}\n`,
          );
          // Retrieve and cache any media so the whole inbound path is exercised
          // here too, without needing a DSH instance in the loop.
          const { media, failures } = await materializeInboundMedia({
            itemList: message.item_list ?? [],
            cdnBaseUrl: CDN_BASE_URL,
            maxBytes: DEFAULT_MAX_MEDIA_BYTES,
            cacheDir: path.join(mediaRoot(dataDir), accountId.replace(/[^\w.@-]/g, '_')),
            label: `smoke[${accountId}]`,
          });
          for (const item of media) {
            process.stdout.write(
              `  media[${item.kind}] ${item.mime} ${item.size}B -> ${item.path}` +
                `${item.transcript ? ` transcript=${JSON.stringify(item.transcript)}` : ''}\n`,
            );
          }
          for (const failure of failures) {
            process.stdout.write(`  media[${failure.kind}] FAILED: ${failure.reason}\n`);
          }
          break;
        }
        case 'stale-token':
          process.stdout.write('⚠️ token 已失效（errcode=-14），需要重新登录。\n');
          break;
        case 'error':
          process.stdout.write(`⚠️ ${String(event.error)}\n`);
          break;
        case 'stopped':
          process.stdout.write('监听已停止。\n');
          break;
        default:
          break;
      }
    },
  });
}

/**
 * Echo mode: reply to every inbound message in the same conversation.
 *
 * Verifies the full receive→reply loop against the live backend without DSH or
 * an LLM in the path.
 */
async function cmdEcho(dataDir: string, requested?: string): Promise<void> {
  const { accountId, token, baseUrl } = resolveAccount(dataDir, requested);
  process.stdout.write(`回声模式已启动（${accountId}）。收到消息会自动回复，Ctrl-C 退出。\n`);

  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());

  const base = { dataDir, accountId, baseUrl, ...(token ? { token } : {}) };

  await runMonitor({
    ...base,
    signal: controller.signal,
    onEvent: (event) => {
      switch (event.type) {
        case 'started':
          process.stdout.write('已连接，等待消息…\n');
          break;
        case 'message': {
          const from = event.message.from_user_id;
          if (!from) break;
          const text = extractText(event.message.item_list).trim();
          process.stdout.write(`← ${from}: ${JSON.stringify(text)}\n`);
          const reply = text
            ? `DSH weixin 已收到：${text}`
            : 'DSH weixin 已收到你的消息（v0.1 暂不支持媒体）。';
          void sendTextToPeer({ ...base, toUserId: from, text: reply })
            .then((result) => process.stdout.write(`→ 已回复 ${result.messageIds.length} 条\n`))
            .catch((error: unknown) =>
              process.stdout.write(
                `→ 回复失败：${error instanceof Error ? error.message : String(error)}\n`,
              ),
            );
          break;
        }
        case 'stale-token':
          process.stdout.write('⚠️ token 已失效（-14），需要重新登录。\n');
          break;
        case 'error':
          process.stdout.write(`⚠️ ${String(event.error)}\n`);
          break;
        case 'stopped':
          process.stdout.write('已停止。\n');
          break;
        default:
          break;
      }
    },
  });
}

async function cmdSend(dataDir: string, accountId: string, toUserId: string, text: string): Promise<void> {  const account = resolveAccount(dataDir, accountId);
  const result = await sendTextToPeer({
    dataDir,
    accountId: account.accountId,
    baseUrl: account.baseUrl,
    ...(account.token ? { token: account.token } : {}),
    toUserId,
    text,
    onStaleSession: (peerId) =>
      process.stdout.write(`⚠️ ${peerId} 的 context_token 已失效，改为无 token 重发。\n`),
  });
  process.stdout.write(
    `已发送 ${result.messageIds.length} 条 message_id=${result.messageIds.join(', ')}` +
      `${result.usedTokenlessFallback ? '（含无 token 降级发送）' : ''}\n`,
  );
}

/** Upload a local file and send it to one peer. */
async function cmdSendFile(
  dataDir: string,
  accountId: string,
  toUserId: string,
  filePath: string,
  caption?: string,
): Promise<void> {
  const account = resolveAccount(dataDir, accountId);
  const result = await sendMediaToPeer({
    dataDir,
    accountId: account.accountId,
    baseUrl: account.baseUrl,
    ...(account.token ? { token: account.token } : {}),
    toUserId,
    filePath,
    ...(caption ? { caption } : {}),
    onStaleSession: (peerId) =>
      process.stdout.write(`⚠️ ${peerId} 的 context_token 已失效，改为无 token 重发。\n`),
  });
  process.stdout.write(
    `已发送 ${result.messageIds.length} 条（含媒体）message_id=${result.messageIds.join(', ')}\n`,
  );
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      'data-dir': { type: 'string' },
      from: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  const dataDir = resolveDataDir(values['data-dir']);
  const command = positionals[0];

  switch (command) {
    case 'list':
      await cmdList(dataDir);
      break;
    case 'import':
      await cmdImport(dataDir, positionals[1], values.from);
      break;
    case 'login':
      await cmdLogin(dataDir);
      break;
    case 'listen':
      await cmdListen(dataDir, positionals[1]);
      break;
    case 'echo':
      await cmdEcho(dataDir, positionals[1]);
      break;
    case 'send': {
      const [, accountId, toUserId, ...rest] = positionals;
      if (!accountId || !toUserId || rest.length === 0) {
        throw new Error('用法：send <accountId> <toUserId> <text…>');
      }
      await cmdSend(dataDir, accountId, toUserId, rest.join(' '));
      break;
    }
    case 'sendfile': {
      const [, accountId, toUserId, filePath, ...rest] = positionals;
      if (!accountId || !toUserId || !filePath) {
        throw new Error('用法：sendfile <accountId> <toUserId> <filePath> [caption…]');
      }
      await cmdSendFile(dataDir, accountId, toUserId, filePath, rest.join(' ') || undefined);
      break;
    }
    default:
      process.stdout.write(
        [
          'DSH Weixin 冒烟 CLI',
          '',
          '  list                                          列出已导入/登录的账号',
          `  import [accountId] [--from <dir>]             从 Hermes 导入凭证（默认 ${defaultHermesDir()}）`,
          '  login                                         扫码登录并保存新账号',
          '  listen [accountId]                            长轮询打印入站消息',
          '  echo [accountId]                              回声模式：收到即回复（自检收发闭环）',
          '  send <accountId> <toUserId> <text…>           发送文本消息',
          '  sendfile <accountId> <toUserId> <file> [文字]  上传并发送文件/图片/视频',
          '',
          `当前数据目录：${dataDir}（可用 --data-dir 覆盖）`,
          '',
        ].join('\n'),
      );
      break;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`错误：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
