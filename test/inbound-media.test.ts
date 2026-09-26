/**
 * Unit tests for media retrieval and upload preparation.
 *
 * The CDN transport is mocked so these tests pin the *shape* of what the plugin
 * asks for and hands back: which key encoding it picks, which upload handshake
 * fields it sends, and how it names cached files.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/protocol/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/protocol/api.js')>();
  return { ...actual, getUploadUrl: vi.fn() };
});

vi.mock('../src/protocol/cdn.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/protocol/cdn.js')>();
  return { ...actual, downloadCdnBuffer: vi.fn(), uploadCdnBuffer: vi.fn() };
});

import { getUploadUrl } from '../src/protocol/api.js';
import { downloadCdnBuffer, uploadCdnBuffer } from '../src/protocol/cdn.js';
import { MessageItemType, UploadMediaType } from '../src/protocol/types.js';
import {
  fetchInboundMedia,
  materializeInboundMedia,
  uploadOutboundMedia,
  writeMediaCache,
} from '../src/media.js';

const mockedDownload = vi.mocked(downloadCdnBuffer);
const mockedUpload = vi.mocked(uploadCdnBuffer);
const mockedGetUploadUrl = vi.mocked(getUploadUrl);

const CDN = 'https://novac2c.cdn.weixin.qq.com/c2c';

/** The options object passed to the most recent downloadCdnBuffer call. */
function lastDownloadOptions(): {
  encryptedQueryParam?: string;
  fullUrl?: string;
  aesKey?: string;
  maxBytes: number;
} {
  const call = mockedDownload.mock.calls.at(-1)?.[0];
  if (!call) throw new Error('downloadCdnBuffer was not called');
  return call as never;
}

beforeEach(() => {
  mockedDownload.mockReset();
  mockedUpload.mockReset();
  mockedGetUploadUrl.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchInboundMedia', () => {
  it('prefers image_item.aeskey over media.aes_key and detects the real type', async () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([1, 2, 3]),
    ]);
    mockedDownload.mockResolvedValue(png);

    const media = await fetchInboundMedia({
      item: {
        type: MessageItemType.IMAGE,
        image_item: {
          aeskey: 'a'.repeat(32),
          media: { encrypt_query_param: 'param', aes_key: 'b'.repeat(24) },
        },
      },
      cdnBaseUrl: CDN,
      maxBytes: 1024,
      label: 'test',
    });

    expect(lastDownloadOptions().aesKey).toBe('a'.repeat(32));
    expect(lastDownloadOptions().encryptedQueryParam).toBe('param');
    expect(media?.kind).toBe('image');
    // The wire claims nothing about the format; the bytes decide.
    expect(media?.mime).toBe('image/png');
  });

  it('falls back to media.aes_key when no raw hex key is present', async () => {
    mockedDownload.mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    const media = await fetchInboundMedia({
      item: {
        type: MessageItemType.IMAGE,
        image_item: { media: { full_url: 'https://cdn.test/x', aes_key: 'base64key' } },
      },
      cdnBaseUrl: CDN,
      maxBytes: 1024,
      label: 'test',
    });

    expect(lastDownloadOptions().aesKey).toBe('base64key');
    expect(lastDownloadOptions().fullUrl).toBe('https://cdn.test/x');
    expect(media?.mime).toBe('image/jpeg');
  });

  it('caches voice as SILK and passes a platform transcript through', async () => {
    mockedDownload.mockResolvedValue(Buffer.from('silk-bytes'));
    const media = await fetchInboundMedia({
      item: {
        type: MessageItemType.VOICE,
        voice_item: { media: { encrypt_query_param: 'p', aes_key: 'k' }, text: '你好' },
      },
      cdnBaseUrl: CDN,
      maxBytes: 1024,
      label: 'test',
    });

    expect(media?.kind).toBe('voice');
    expect(media?.mime).toBe('audio/silk');
    expect(media?.transcript).toBe('你好');
    expect(media?.name).toMatch(/^voice-\d+\.silk$/);
  });

  it('keeps a file name and infers its MIME type', async () => {
    mockedDownload.mockResolvedValue(Buffer.from('%PDF-1.4'));
    const media = await fetchInboundMedia({
      item: {
        type: MessageItemType.FILE,
        file_item: { file_name: '季度报告.pdf', media: { encrypt_query_param: 'p', aes_key: 'k' } },
      },
      cdnBaseUrl: CDN,
      maxBytes: 1024,
      label: 'test',
    });

    expect(media?.kind).toBe('file');
    expect(media?.name).toBe('季度报告.pdf');
    expect(media?.mime).toBe('application/pdf');
  });

  it('labels video as mp4', async () => {
    mockedDownload.mockResolvedValue(Buffer.from('video-bytes'));
    const media = await fetchInboundMedia({
      item: {
        type: MessageItemType.VIDEO,
        video_item: { media: { encrypt_query_param: 'p', aes_key: 'k' } },
      },
      cdnBaseUrl: CDN,
      maxBytes: 1024,
      label: 'test',
    });

    expect(media?.kind).toBe('video');
    expect(media?.mime).toBe('video/mp4');
  });

  it('does not touch the CDN for items without a reference', async () => {
    const media = await fetchInboundMedia({
      item: { type: MessageItemType.TEXT, text_item: { text: 'hi' } },
      cdnBaseUrl: CDN,
      maxBytes: 1024,
      label: 'test',
    });
    expect(media).toBeUndefined();
    expect(mockedDownload).not.toHaveBeenCalled();
  });

  it('honours the byte ceiling it was given', async () => {
    mockedDownload.mockResolvedValue(Buffer.alloc(10));
    await fetchInboundMedia({
      item: { type: MessageItemType.IMAGE, image_item: { media: { encrypt_query_param: 'p' } } },
      cdnBaseUrl: CDN,
      maxBytes: 4096,
      label: 'test',
    });
    expect(lastDownloadOptions().maxBytes).toBe(4096);
  });
});

describe('uploadOutboundMedia', () => {
  let dir: string;
  let filePath: string;
  const contents = Buffer.from('binary-payload');

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-upload-'));
    filePath = path.join(dir, 'photo.png');
    fs.writeFileSync(filePath, contents);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('performs the documented upload handshake and returns the CDN reference', async () => {
    mockedGetUploadUrl.mockResolvedValue({ upload_full_url: 'https://cdn.test/upload' });
    mockedUpload.mockResolvedValue({ downloadParam: 'download-param' });

    const result = await uploadOutboundMedia({
      filePath,
      toUserId: 'peer@im.wechat',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      token: 'tok',
      cdnBaseUrl: CDN,
    });

    const request = mockedGetUploadUrl.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(request.media_type).toBe(UploadMediaType.IMAGE);
    expect(request.to_user_id).toBe('peer@im.wechat');
    expect(request.rawsize).toBe(contents.length);
    expect(request.rawfilemd5).toBe(crypto.createHash('md5').update(contents).digest('hex'));
    // PKCS#7 always adds a full block for an exact multiple of 16.
    expect(request.filesize).toBe(Math.ceil((contents.length + 1) / 16) * 16);
    expect(request.no_need_thumb).toBe(true);
    // The key is sent as hex and later embedded base64-over-hex in the message.
    expect(request.aeskey).toMatch(/^[0-9a-f]{32}$/);

    expect(result.downloadEncryptedQueryParam).toBe('download-param');
    expect(result.aeskeyHex).toMatch(/^[0-9a-f]{32}$/);
    expect(result.fileSize).toBe(contents.length);
    expect(result.mediaType).toBe(UploadMediaType.IMAGE);
  });

  it('classifies a non-image by MIME family', async () => {
    const docPath = path.join(dir, 'notes.pdf');
    fs.writeFileSync(docPath, contents);
    mockedGetUploadUrl.mockResolvedValue({ upload_param: 'p' });
    mockedUpload.mockResolvedValue({ downloadParam: 'd' });

    const result = await uploadOutboundMedia({
      filePath: docPath,
      toUserId: 'peer@im.wechat',
      baseUrl: 'https://x',
      cdnBaseUrl: CDN,
    });

    expect(result.mediaType).toBe(UploadMediaType.FILE);
    expect((mockedGetUploadUrl.mock.calls[0]?.[0] as unknown as Record<string, unknown>).media_type).toBe(
      UploadMediaType.FILE,
    );
  });

  it('fails loudly when the backend returns no upload target', async () => {
    mockedGetUploadUrl.mockResolvedValue({});
    await expect(
      uploadOutboundMedia({
        filePath,
        toUserId: 'peer@im.wechat',
        baseUrl: 'https://x',
        cdnBaseUrl: CDN,
      }),
    ).rejects.toThrow(/no upload target/);
  });
});

describe('writeMediaCache', () => {
  it('creates the directory and writes the bytes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-cache-'));
    const target = path.join(dir, 'nested', 'a.bin');
    const written = writeMediaCache({ cacheDir: path.join(dir, 'nested'), name: 'a.bin', data: Buffer.from('xy') });
    expect(written).toBe(target);
    expect(fs.readFileSync(target, 'utf-8')).toBe('xy');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('materializeInboundMedia', () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-materialize-'));
  });

  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it('downloads, names, caches, and describes each attachment', async () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('image-bytes'),
    ]);
    mockedDownload.mockResolvedValueOnce(png).mockResolvedValueOnce(Buffer.from('%PDF-1.4'));

    const { media, failures } = await materializeInboundMedia({
      itemList: [
        { type: MessageItemType.IMAGE, image_item: { media: { encrypt_query_param: 'p1' } } },
        {
          type: MessageItemType.FILE,
          file_item: { file_name: 'doc.pdf', media: { encrypt_query_param: 'p2', aes_key: 'k' } },
        },
        { type: MessageItemType.TEXT, text_item: { text: 'ignore me' } },
      ],
      cdnBaseUrl: CDN,
      maxBytes: 4096,
      cacheDir,
      label: 'test',
    });

    expect(failures).toEqual([]);
    expect(media).toHaveLength(2);
    expect(media[0]?.kind).toBe('image');
    expect(media[0]?.mime).toBe('image/png');
    expect(fs.existsSync(media[0]!.path)).toBe(true);
    expect(fs.readFileSync(media[0]!.path).equals(png)).toBe(true);
    expect(media[1]?.name).toBe('doc.pdf');
    expect(media[1]?.size).toBe(8);
    // The text item is not media and must not reach the CDN.
    expect(mockedDownload).toHaveBeenCalledTimes(2);
  });

  it('reports a failed item without discarding the others', async () => {
    mockedDownload
      .mockRejectedValueOnce(new Error('CDN download HTTP 403'))
      .mockResolvedValueOnce(Buffer.from([0xff, 0xd8, 0xff]));

    const { media, failures } = await materializeInboundMedia({
      itemList: [
        { type: MessageItemType.FILE, file_item: { media: { encrypt_query_param: 'bad' } } },
        { type: MessageItemType.IMAGE, image_item: { media: { encrypt_query_param: 'ok' } } },
      ],
      cdnBaseUrl: CDN,
      maxBytes: 4096,
      cacheDir,
      label: 'test',
    });

    expect(media).toHaveLength(1);
    expect(media[0]?.kind).toBe('image');
    expect(failures).toHaveLength(1);
    expect(failures[0]?.kind).toBe('file');
    expect(failures[0]?.reason).toContain('403');
  });

  it('does nothing for a text-only message', async () => {
    const { media, failures } = await materializeInboundMedia({
      itemList: [{ type: MessageItemType.TEXT, text_item: { text: 'hi' } }],
      cdnBaseUrl: CDN,
      maxBytes: 4096,
      cacheDir,
      label: 'test',
    });
    expect(media).toEqual([]);
    expect(failures).toEqual([]);
    expect(mockedDownload).not.toHaveBeenCalled();
  });
});
