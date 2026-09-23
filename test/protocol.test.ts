/**
 * Unit tests for the iLink protocol client's pure helpers.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BOT_AGENT,
  SendMessageError,
  buildClientVersion,
  isStaleSessionError,
  parseWeixinApiJson,
  sanitizeBotAgent,
} from '../src/protocol/api.js';

describe('parseWeixinApiJson', () => {
  it('preserves uint64 identifiers that JSON.parse would round', () => {
    const raw = '{"message_id":18446744073709551615,"ret":0}';
    const parsed = parseWeixinApiJson<{ message_id: string; ret: number }>(raw);
    expect(parsed.message_id).toBe('18446744073709551615');
    expect(parsed.ret).toBe(0);
  });

  it('rewrites nested identifier fields inside arrays', () => {
    const raw = '{"msgs":[{"message_id":1234567890123456789,"msg_id":7}]}';
    const parsed = parseWeixinApiJson<{ msgs: { message_id: string; msg_id: string }[] }>(raw);
    expect(parsed.msgs[0]!.message_id).toBe('1234567890123456789');
    expect(parsed.msgs[0]!.msg_id).toBe('7');
  });

  it('leaves digits inside string values untouched', () => {
    const raw = '{"errmsg":"message_id 999 failed","text_item":{"text":"call 110"}}';
    const parsed = parseWeixinApiJson<{ errmsg: string; text_item: { text: string } }>(raw);
    expect(parsed.errmsg).toBe('message_id 999 failed');
    expect(parsed.text_item.text).toBe('call 110');
  });

  it('keeps non-identifier numeric fields numeric', () => {
    const parsed = parseWeixinApiJson<{ seq: number; create_time_ms: number }>(
      '{"seq":3,"create_time_ms":1700000000000}',
    );
    expect(parsed.seq).toBe(3);
    expect(parsed.create_time_ms).toBe(1_700_000_000_000);
  });

  it('handles negative and non-numeric identifier values', () => {
    const parsed = parseWeixinApiJson<{ message_id: string | null }>('{"message_id":-5}');
    expect(parsed.message_id).toBe('-5');
    expect(parseWeixinApiJson<{ message_id: null }>('{"message_id":null}').message_id).toBeNull();
    expect(parseWeixinApiJson<{ message_id: string }>('{"message_id":"abc"}').message_id).toBe('abc');
  });
});

describe('sanitizeBotAgent', () => {
  it('keeps well-formed UA-style tokens', () => {
    expect(sanitizeBotAgent('MyBot/1.2.0')).toBe('MyBot/1.2.0');
    expect(sanitizeBotAgent('MyBot/1.2.0 LangChain/0.3.5')).toBe('MyBot/1.2.0 LangChain/0.3.5');
    expect(sanitizeBotAgent('MyBot/1.2.0 (region=cn;env=prod)')).toBe(
      'MyBot/1.2.0 (region=cn;env=prod)',
    );
  });

  it('falls back to the default for empty or unusable input', () => {
    expect(sanitizeBotAgent(undefined)).toBe(DEFAULT_BOT_AGENT);
    expect(sanitizeBotAgent('')).toBe(DEFAULT_BOT_AGENT);
    expect(sanitizeBotAgent('   ')).toBe(DEFAULT_BOT_AGENT);
    expect(sanitizeBotAgent('no-version-here')).toBe(DEFAULT_BOT_AGENT);
  });

  it('drops malformed tokens but keeps valid neighbours', () => {
    expect(sanitizeBotAgent('!!! MyBot/1.0')).toBe('MyBot/1.0');
  });
});

describe('buildClientVersion', () => {
  it('encodes semver as 0x00MMNNPP', () => {
    expect(buildClientVersion('1.0.11')).toBe(0x0001000b);
    expect(buildClientVersion('2.3.4')).toBe(0x00020304);
    expect(buildClientVersion('0.0.0')).toBe(0);
  });

  it('tolerates short versions', () => {
    expect(buildClientVersion('1')).toBe(0x00010000);
  });
});

describe('isStaleSessionError', () => {
  it('recognizes the stale-session variants of -2', () => {
    expect(isStaleSessionError(new SendMessageError(-2, undefined, 'prepare failed'))).toBe(true);
    expect(isStaleSessionError(new SendMessageError(-2, undefined, 'unknown error'))).toBe(true);
    expect(isStaleSessionError(new SendMessageError(undefined, -2, 'Prepare Failed'))).toBe(true);
  });

  it('recognizes the expired-session code', () => {
    expect(isStaleSessionError(new SendMessageError(-14, undefined, 'session expired'))).toBe(true);
  });

  it('does not mistake other failures for a stale session', () => {
    expect(isStaleSessionError(new SendMessageError(-2, undefined, 'rate limited'))).toBe(false);
    expect(isStaleSessionError(new SendMessageError(-1, undefined, 'prepare failed'))).toBe(false);
    expect(isStaleSessionError(new Error('socket hang up'))).toBe(false);
    expect(isStaleSessionError(undefined)).toBe(false);
  });
});

describe('SendMessageError', () => {
  it('reports every backend code in its message', () => {
    const error = new SendMessageError(-2, -3, 'prepare failed');
    expect(error.name).toBe('SendMessageError');
    expect(error.ret).toBe(-2);
    expect(error.errcode).toBe(-3);
    expect(error.errmsg).toBe('prepare failed');
    expect(error.message).toContain('ret=-2');
    expect(error.message).toContain('errcode=-3');
  });
});
