/**
 * Unit tests for outbound sending, in particular the stale-session fallback
 * that the iLink backend requires when a peer's context token has expired.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/protocol/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/protocol/api.js')>();
  return { ...actual, sendMessage: vi.fn() };
});

import { SendMessageError, sendMessage } from '../src/protocol/api.js';
import { getContextToken, setContextToken } from '../src/auth/accounts.js';
import { SessionNotReadyError, sendTextToPeer } from '../src/outbound.js';

const ACCOUNT = 'acct@im.bot';
const PEER = 'peer@im.wechat';
const mockedSend = vi.mocked(sendMessage);

interface SendParams {
  baseUrl: string;
  token?: string;
  body: { msg?: { context_token?: string; item_list?: { text_item?: { text?: string } }[] } };
}

/** The `msg` payload of the nth recorded sendMessage call. */
function sentMessage(index: number): NonNullable<SendParams['body']['msg']> {
  const call = mockedSend.mock.calls[index]?.[0] as SendParams | undefined;
  if (!call?.body?.msg) throw new Error(`no message recorded at index ${index}`);
  return call.body.msg;
}

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-outbound-'));
  mockedSend.mockReset();
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const base = (): Parameters<typeof sendTextToPeer>[0] => ({
  dataDir,
  accountId: ACCOUNT,
  baseUrl: 'https://ilinkai.weixin.qq.com',
  token: 'tok',
  toUserId: PEER,
  text: 'hello',
});

describe('sendTextToPeer', () => {
  it('sends with the stored context token and returns the message id', async () => {
    setContextToken(dataDir, ACCOUNT, PEER, 'ctx-1');
    mockedSend.mockResolvedValue({ message_id: 'm-1', ret: 0 });

    const result = await sendTextToPeer(base());

    expect(mockedSend).toHaveBeenCalledTimes(1);
    expect(sentMessage(0).context_token).toBe('ctx-1');
    expect(sentMessage(0).item_list?.[0]?.text_item?.text).toBe('hello');
    expect(result.messageIds).toEqual(['m-1']);
    expect(result.usedTokenlessFallback).toBe(false);
    expect(getContextToken(dataDir, ACCOUNT, PEER)).toBe('ctx-1');
  });

  it('retries without the token when the backend reports a stale session', async () => {
    setContextToken(dataDir, ACCOUNT, PEER, 'stale-ctx');
    mockedSend
      .mockRejectedValueOnce(new SendMessageError(-2, undefined, 'prepare failed'))
      .mockResolvedValueOnce({ message_id: 'm-2', ret: 0 });

    const stalePeers: string[] = [];
    const result = await sendTextToPeer({ ...base(), onStaleSession: (peer) => stalePeers.push(peer) });

    expect(mockedSend).toHaveBeenCalledTimes(2);
    expect(sentMessage(0).context_token).toBe('stale-ctx');
    expect(sentMessage(1).context_token).toBeUndefined();
    expect(result.usedTokenlessFallback).toBe(true);
    expect(stalePeers).toEqual([PEER]);
    // The dead token must not be reused by later sends.
    expect(getContextToken(dataDir, ACCOUNT, PEER)).toBeUndefined();
  });

  it('raises SessionNotReadyError when the tokenless resend also fails', async () => {
    setContextToken(dataDir, ACCOUNT, PEER, 'stale-ctx');
    mockedSend.mockRejectedValue(new SendMessageError(-2, undefined, 'prepare failed'));

    await expect(sendTextToPeer(base())).rejects.toBeInstanceOf(SessionNotReadyError);
    expect(mockedSend).toHaveBeenCalledTimes(2);
  });

  it('does not retry when there was no stored token to drop', async () => {
    mockedSend.mockRejectedValue(new SendMessageError(-2, undefined, 'prepare failed'));

    await expect(sendTextToPeer(base())).rejects.toBeInstanceOf(SessionNotReadyError);
    expect(mockedSend).toHaveBeenCalledTimes(1);
  });

  it('propagates unrelated backend failures unchanged', async () => {
    setContextToken(dataDir, ACCOUNT, PEER, 'ctx-1');
    const failure = new SendMessageError(-1, undefined, 'bad request');
    mockedSend.mockRejectedValue(failure);

    await expect(sendTextToPeer(base())).rejects.toBe(failure);
    expect(mockedSend).toHaveBeenCalledTimes(1);
  });

  it('chunks long text into several sends', async () => {
    mockedSend.mockResolvedValue({ message_id: 'm', ret: 0 });
    const text = `${'a'.repeat(50)}\n\n${'b'.repeat(50)}`;

    const result = await sendTextToPeer({ ...base(), text, maxChunkLength: 60 });

    expect(mockedSend).toHaveBeenCalledTimes(2);
    expect(result.messageIds).toEqual(['m', 'm']);
  });

  it('reports an empty message id when the backend omits one', async () => {
    mockedSend.mockResolvedValue({ ret: 0 });
    const result = await sendTextToPeer(base());
    expect(result.messageIds).toEqual(['']);
  });
});
