/**
 * Unit tests for media classification and naming.
 */

import { describe, expect, it } from 'vitest';

import {
  extensionForMime,
  hasMedia,
  isSupportedImageMime,
  mediaCacheName,
  mediaKindOfItem,
  mimeFromFilename,
  sniffImageMime,
  uploadMediaTypeFor,
} from '../src/media.js';
import { MessageItemType, UploadMediaType } from '../src/protocol/types.js';

/** Minimal magic-byte prefixes for each supported image type. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
const GIF = Buffer.from('GIF89a....', 'ascii');
const WEBP = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(4), Buffer.from('WEBP', 'ascii')]);

describe('sniffImageMime', () => {
  it('detects each supported image type from its bytes', () => {
    expect(sniffImageMime(PNG)).toBe('image/png');
    expect(sniffImageMime(JPEG)).toBe('image/jpeg');
    expect(sniffImageMime(GIF)).toBe('image/gif');
    expect(sniffImageMime(WEBP)).toBe('image/webp');
  });

  it('returns undefined for unknown or truncated bytes', () => {
    expect(sniffImageMime(Buffer.from('not an image'))).toBeUndefined();
    expect(sniffImageMime(Buffer.alloc(0))).toBeUndefined();
    expect(sniffImageMime(Buffer.from([0xff, 0xd8]))).toBeUndefined();
  });
});

describe('mimeFromFilename', () => {
  it('maps common extensions', () => {
    expect(mimeFromFilename('a.PNG')).toBe('image/png');
    expect(mimeFromFilename('a.jpeg')).toBe('image/jpeg');
    expect(mimeFromFilename('report.pdf')).toBe('application/pdf');
    expect(mimeFromFilename('clip.mp4')).toBe('video/mp4');
  });

  it('falls back to a generic type', () => {
    expect(mimeFromFilename('archive.unknown')).toBe('application/octet-stream');
    expect(mimeFromFilename('noext')).toBe('application/octet-stream');
  });
});

describe('extensionForMime', () => {
  it('maps the types we produce', () => {
    expect(extensionForMime('image/jpeg')).toBe('.jpg');
    expect(extensionForMime('video/mp4')).toBe('.mp4');
    expect(extensionForMime('application/zip')).toBe('');
  });
});

describe('isSupportedImageMime', () => {
  it('accepts only the types the attachment service stores', () => {
    for (const mime of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
      expect(isSupportedImageMime(mime), mime).toBe(true);
    }
    for (const mime of ['image/bmp', 'image/heic', 'application/pdf', '']) {
      expect(isSupportedImageMime(mime), mime).toBe(false);
    }
  });
});

describe('uploadMediaTypeFor', () => {
  it('classifies by MIME family', () => {
    expect(uploadMediaTypeFor('image/png')).toBe(UploadMediaType.IMAGE);
    expect(uploadMediaTypeFor('video/mp4')).toBe(UploadMediaType.VIDEO);
    expect(uploadMediaTypeFor('application/pdf')).toBe(UploadMediaType.FILE);
    expect(uploadMediaTypeFor('audio/silk')).toBe(UploadMediaType.FILE);
  });
});

describe('mediaCacheName', () => {
  it('keeps a usable name and its extension', () => {
    expect(mediaCacheName('report.pdf', 'application/pdf', '.bin')).toBe('report.pdf');
  });

  it('appends an extension when the name lacks one', () => {
    expect(mediaCacheName('photo', 'image/jpeg', '.jpg')).toBe('photo.jpg');
  });

  it('strips path separators and control characters', () => {
    const name = mediaCacheName('../../etc/passwd', 'text/plain', '.txt');
    expect(name).not.toContain('/');
    expect(name).not.toContain('..');
  });

  it('generates a name when none is supplied', () => {
    expect(mediaCacheName(undefined, 'image/png', '.png')).toMatch(/^media-\d+-[0-9a-f]{8}\.png$/);
    expect(mediaCacheName('   ', 'image/png', '.png')).toMatch(/\.png$/);
  });
});

describe('hasMedia', () => {
  it('is true only when a fetchable CDN reference exists', () => {
    expect(
      hasMedia({ type: MessageItemType.IMAGE, image_item: { media: { encrypt_query_param: 'x' } } }),
    ).toBe(true);
    expect(
      hasMedia({ type: MessageItemType.IMAGE, image_item: { media: { full_url: 'https://x/y' } } }),
    ).toBe(true);
    expect(hasMedia({ type: MessageItemType.IMAGE, image_item: {} })).toBe(false);
    expect(hasMedia({ type: MessageItemType.FILE, file_item: { file_name: 'a.pdf' } })).toBe(false);
    expect(hasMedia({ type: MessageItemType.TEXT, text_item: { text: 'hi' } })).toBe(false);
  });
});

describe('mediaKindOfItem', () => {
  it('maps item types onto attachment kinds', () => {
    expect(mediaKindOfItem({ type: MessageItemType.IMAGE })).toBe('image');
    expect(mediaKindOfItem({ type: MessageItemType.VOICE })).toBe('voice');
    expect(mediaKindOfItem({ type: MessageItemType.VIDEO })).toBe('video');
    expect(mediaKindOfItem({ type: MessageItemType.FILE })).toBe('file');
    expect(mediaKindOfItem({ type: MessageItemType.TEXT })).toBe('file');
  });
});
