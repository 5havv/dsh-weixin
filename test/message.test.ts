/**
 * Unit tests for message construction and extraction.
 */

import { describe, expect, it } from 'vitest';

import {
  buildItemMessage,
  buildMediaItem,
  buildTextMessage,
  chunkText,
  extractText,
  generateClientId,
  isBotMessage,
} from '../src/message.js';
import { MessageItemType, MessageType } from '../src/protocol/types.js';

describe('extractText', () => {
  it('concatenates text items and ignores non-text ones', () => {
    expect(
      extractText([
        { type: MessageItemType.TEXT, text_item: { text: 'hello ' } },
        { type: MessageItemType.IMAGE, image_item: {} },
        { type: MessageItemType.TEXT, text_item: { text: 'world' } },
      ]),
    ).toBe('hello world');
  });

  it('returns an empty string for absent or empty item lists', () => {
    expect(extractText(undefined)).toBe('');
    expect(extractText([])).toBe('');
    expect(extractText([{ type: MessageItemType.IMAGE, image_item: {} }])).toBe('');
  });

  it('tolerates text items with a missing body', () => {
    expect(extractText([{ type: MessageItemType.TEXT, text_item: {} }])).toBe('');
  });
});

describe('chunkText', () => {
  it('keeps text within the limit as a single chunk', () => {
    expect(chunkText('short', 100)).toEqual(['short']);
    expect(chunkText('x'.repeat(100), 100)).toEqual(['x'.repeat(100)]);
  });

  it('splits on a paragraph boundary when one exists in the tail half', () => {
    const text = `${'a'.repeat(60)}\n\n${'b'.repeat(60)}`;
    const chunks = chunkText(text, 100);
    expect(chunks).toEqual(['a'.repeat(60), 'b'.repeat(60)]);
  });

  it('never emits a chunk longer than the limit', () => {
    const text = 'word '.repeat(500);
    const chunks = chunkText(text, 40);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(40);
  });

  it('loses no characters when joining chunks back together', () => {
    const text = 'lorem ipsum dolor sit amet\n\nconsectetur adipiscing elit '.repeat(20);
    const joined = chunkText(text, 64).join(' ');
    expect(joined.replace(/\s+/g, ' ').trim()).toBe(text.replace(/\s+/g, ' ').trim());
  });

  it('hard-splits text with no usable boundary', () => {
    const chunks = chunkText('x'.repeat(250), 100);
    expect(chunks).toEqual(['x'.repeat(100), 'x'.repeat(100), 'x'.repeat(50)]);
  });

  it('rejects a non-positive limit', () => {
    expect(() => chunkText('a', 0)).toThrow();
  });
});

describe('generateClientId', () => {
  it('produces a unique, prefixed identifier', () => {
    const first = generateClientId();
    const second = generateClientId();
    expect(first).toMatch(/^dsh-weixin:\d+-[0-9a-f]{8}$/);
    expect(first).not.toBe(second);
  });
});

describe('buildTextMessage', () => {
  it('carries every field the backend requires', () => {
    const message = buildTextMessage('peer@im.wechat', 'hi', 'ctx-token');
    expect(message.from_user_id).toBe('');
    expect(message.to_user_id).toBe('peer@im.wechat');
    expect(message.message_type).toBe(MessageType.BOT);
    expect(message.message_state).toBe(2);
    expect(message.context_token).toBe('ctx-token');
    expect(message.client_id).toMatch(/^dsh-weixin:/);
    expect(message.item_list).toEqual([{ type: MessageItemType.TEXT, text_item: { text: 'hi' } }]);
  });

  it('omits context_token when none is supplied', () => {
    expect(buildTextMessage('peer@im.wechat', 'hi').context_token).toBeUndefined();
  });
});

describe('isBotMessage', () => {
  it('flags messages the bot itself produced', () => {
    expect(isBotMessage({ message_type: MessageType.BOT })).toBe(true);
    expect(isBotMessage({ message_type: MessageType.USER })).toBe(false);
    expect(isBotMessage({})).toBe(false);
  });
});

describe('buildMediaItem', () => {
  const uploaded = {
    mediaType: 1 as const,
    downloadEncryptedQueryParam: 'param-1',
    aeskeyHex: 'a'.repeat(32),
    fileSize: 100,
    fileSizeCiphertext: 112,
  };

  it('builds an image item with the key base64-encoded over its hex form', () => {
    const item = buildMediaItem(uploaded);
    expect(item.type).toBe(MessageItemType.IMAGE);
    expect(item.image_item?.media?.encrypt_query_param).toBe('param-1');
    expect(item.image_item?.media?.aes_key).toBe(Buffer.from('a'.repeat(32)).toString('base64'));
    expect(item.image_item?.media?.encrypt_type).toBe(1);
    expect(item.image_item?.mid_size).toBe(112);
  });

  it('builds a video item sized by the ciphertext', () => {
    const item = buildMediaItem({ ...uploaded, mediaType: 2 });
    expect(item.type).toBe(MessageItemType.VIDEO);
    expect(item.video_item?.video_size).toBe(112);
  });

  it('builds a file item carrying its name and plaintext length', () => {
    const item = buildMediaItem({ ...uploaded, mediaType: 3 }, 'report.pdf');
    expect(item.type).toBe(MessageItemType.FILE);
    expect(item.file_item?.file_name).toBe('report.pdf');
    expect(item.file_item?.len).toBe('100');
    expect(item.file_item?.media?.encrypt_query_param).toBe('param-1');
  });
});

describe('buildItemMessage', () => {
  it('wraps exactly one item with a fresh client id', () => {
    const message = buildItemMessage('peer@im.wechat', { type: MessageItemType.IMAGE }, 'ctx');
    expect(message.to_user_id).toBe('peer@im.wechat');
    expect(message.item_list).toHaveLength(1);
    expect(message.client_id).toMatch(/^dsh-weixin:/);
    expect(message.context_token).toBe('ctx');
  });

  it('omits context_token when none is available', () => {
    expect(buildItemMessage('peer@im.wechat', { type: 1 }).context_token).toBeUndefined();
  });
});
