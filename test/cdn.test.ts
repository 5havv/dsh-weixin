/**
 * Unit tests for the CDN crypto and transport helpers.
 */

import crypto from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  aesEcbPaddedSize,
  assertSafeMediaUrl,
  buildCdnDownloadUrl,
  buildCdnUploadUrl,
  decryptAesEcb,
  encryptAesEcb,
  parseAesKey,
} from '../src/protocol/cdn.js';

describe('AES-128-ECB', () => {
  it('round-trips a payload', () => {
    const key = crypto.randomBytes(16);
    const plaintext = Buffer.from('hello 微信 media', 'utf-8');
    const ciphertext = encryptAesEcb(plaintext, key);
    expect(ciphertext.equals(plaintext)).toBe(false);
    expect(decryptAesEcb(ciphertext, key).toString('utf-8')).toBe('hello 微信 media');
  });

  it('pads to the documented ciphertext size', () => {
    const key = crypto.randomBytes(16);
    for (const size of [0, 1, 15, 16, 17, 31, 32, 1000]) {
      const ciphertext = encryptAesEcb(Buffer.alloc(size), key);
      expect(ciphertext.length).toBe(aesEcbPaddedSize(size));
    }
  });

  it('rejects a wrong key rather than returning garbage', () => {
    const ciphertext = encryptAesEcb(Buffer.from('secret'), crypto.randomBytes(16));
    // A wrong key almost always fails the padding check.
    expect(() => decryptAesEcb(ciphertext, crypto.randomBytes(16))).toThrow();
  });
});

describe('aesEcbPaddedSize', () => {
  it('always adds at least one padding byte', () => {
    expect(aesEcbPaddedSize(0)).toBe(16);
    expect(aesEcbPaddedSize(15)).toBe(16);
    expect(aesEcbPaddedSize(16)).toBe(32);
    expect(aesEcbPaddedSize(17)).toBe(32);
  });
});

describe('parseAesKey', () => {
  const key = crypto.randomBytes(16);

  it('accepts base64 of the 16 raw bytes', () => {
    expect(parseAesKey(key.toString('base64'), 'test').equals(key)).toBe(true);
  });

  it('accepts base64 of the 32-char hex form', () => {
    const asHexBase64 = Buffer.from(key.toString('hex')).toString('base64');
    expect(parseAesKey(asHexBase64, 'test').equals(key)).toBe(true);
  });

  it('accepts a bare 32-char hex string', () => {
    expect(parseAesKey(key.toString('hex'), 'test').equals(key)).toBe(true);
  });

  it('rejects an unusable key instead of guessing', () => {
    expect(() => parseAesKey(Buffer.from('too short').toString('base64'), 'test')).toThrow(
      /aes_key/,
    );
  });
});

describe('CDN URLs', () => {
  it('builds a download URL with the parameter encoded', () => {
    expect(buildCdnDownloadUrl('a b&c', 'https://cdn.test/c2c')).toBe(
      'https://cdn.test/c2c/download?encrypted_query_param=a%20b%26c',
    );
  });

  it('builds an upload URL with both parameters encoded', () => {
    expect(buildCdnUploadUrl({ cdnBaseUrl: 'https://cdn.test/c2c', uploadParam: 'p&1', filekey: 'k/2' })).toBe(
      'https://cdn.test/c2c/upload?encrypted_query_param=p%261&filekey=k%2F2',
    );
  });
});

describe('assertSafeMediaUrl', () => {
  it('accepts a normal https media URL', () => {
    expect(() =>
      assertSafeMediaUrl('https://novac2c.cdn.weixin.qq.com/c2c/download?x=1', 'test'),
    ).not.toThrow();
  });

  it('refuses plain http', () => {
    expect(() => assertSafeMediaUrl('http://cdn.weixin.qq.com/x', 'test')).toThrow(/https/);
  });

  it('refuses loopback, private, and link-local hosts', () => {
    for (const url of [
      'https://localhost/x',
      'https://127.0.0.1/x',
      'https://10.1.2.3/x',
      'https://192.168.1.1/x',
      'https://172.16.0.9/x',
      'https://169.254.169.254/latest/meta-data',
      'https://metadata.internal/x',
    ]) {
      expect(() => assertSafeMediaUrl(url, 'test'), url).toThrow(/private host/);
    }
  });

  it('refuses a malformed URL', () => {
    expect(() => assertSafeMediaUrl('not a url', 'test')).toThrow(/invalid/);
  });
});
