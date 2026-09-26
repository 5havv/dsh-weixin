/**
 * Weixin CDN transport: AES-128-ECB crypto, URL construction, and the
 * encrypted download/upload round trip.
 *
 * Media never travels as plaintext. Every blob is encrypted with a per-file
 * AES-128 key that the API layer hands out separately from the URL, so both
 * halves are required to read a file.
 *
 * @module @5havv/dsh-weixin/protocol/cdn
 */

import { createCipheriv, createDecipheriv } from 'node:crypto';

/** Default media CDN base URL. */
export const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';

/** Retries applied to transient CDN upload failures. */
const UPLOAD_MAX_RETRIES = 3;

/** Encrypt a buffer with AES-128-ECB (PKCS#7 padding is Node's default). */
export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/** Decrypt a buffer with AES-128-ECB (PKCS#7 padding). */
export function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Ciphertext size for a plaintext of `plaintextSize` bytes.
 *
 * PKCS#7 always appends at least one byte, so an exact multiple of 16 grows by
 * a whole block. The backend asks for this value up front, so it must match the
 * encryptor exactly.
 *
 * @param plaintextSize - plaintext length in bytes.
 * @returns the encrypted length in bytes.
 */
export function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

/**
 * Recover the raw 16-byte AES key from its wire encoding.
 *
 * Three encodings appear in the wild:
 *   - base64(16 raw bytes)            — images
 *   - base64(32 ASCII hex chars)      — files, voice, video
 *   - 32 ASCII hex chars              — `image_item.aeskey`
 *
 * @param encoded - the key as carried by the message.
 * @param label - context for error messages.
 * @returns the 16-byte key.
 * @throws when the value decodes to neither shape.
 */
export function parseAesKey(encoded: string, label: string): Buffer {
  const value = encoded.trim();
  if (/^[0-9a-fA-F]{32}$/.test(value)) return Buffer.from(value, 'hex');

  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex');
  }
  throw new Error(
    `${label}: aes_key must decode to 16 raw bytes or a 32-char hex string, got ${decoded.length} bytes`,
  );
}

/** Build a CDN download URL from an encrypted query parameter. */
export function buildCdnDownloadUrl(encryptedQueryParam: string, cdnBaseUrl: string): string {
  return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

/** Build a CDN upload URL from an upload parameter and file key. */
export function buildCdnUploadUrl(params: {
  cdnBaseUrl: string;
  uploadParam: string;
  filekey: string;
}): string {
  return (
    `${params.cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(params.uploadParam)}` +
    `&filekey=${encodeURIComponent(params.filekey)}`
  );
}

/** Hosts that must never be contacted, so a hostile URL cannot reach the LAN. */
const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^0\./,
  /^\[?::1\]?$/,
  /\.local$/i,
  /\.internal$/i,
];

/**
 * Reject a media URL that could reach a private service.
 *
 * Media URLs arrive inside messages, so a crafted one must not turn the bot
 * into an SSRF proxy for the local network.
 *
 * @param rawUrl - the URL to check.
 * @param label - context for error messages.
 * @throws when the URL is not https or targets a private host.
 */
export function assertSafeMediaUrl(rawUrl: string, label: string): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`${label}: invalid media URL`);
  }
  if (url.protocol !== 'https:') throw new Error(`${label}: media URL must use https`);
  const host = url.hostname.toLowerCase();
  if (PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(host))) {
    throw new Error(`${label}: refusing to fetch media from private host ${host}`);
  }
}

/**
 * Download a blob from the CDN, decrypting it when a key is supplied.
 *
 * @param params - CDN location, optional key, and limits.
 * @returns the plaintext (keyed) or raw (unkeyed) bytes.
 */
export async function downloadCdnBuffer(params: {
  encryptedQueryParam?: string;
  fullUrl?: string;
  cdnBaseUrl: string;
  /** Wire-encoded AES key; omit for an unencrypted blob. */
  aesKey?: string;
  maxBytes: number;
  label: string;
}): Promise<Buffer> {
  const url =
    params.fullUrl?.trim() ||
    (params.encryptedQueryParam
      ? buildCdnDownloadUrl(params.encryptedQueryParam, params.cdnBaseUrl)
      : '');
  if (!url) throw new Error(`${params.label}: no CDN download URL`);
  assertSafeMediaUrl(url, params.label);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${params.label}: CDN download HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > params.maxBytes) {
    throw new Error(
      `${params.label}: media is ${bytes.length} bytes, over the ${params.maxBytes}-byte limit`,
    );
  }
  if (!params.aesKey) return bytes;

  const key = parseAesKey(params.aesKey, params.label);
  const plaintext = decryptAesEcb(bytes, key);
  if (plaintext.length > params.maxBytes) {
    throw new Error(
      `${params.label}: decrypted media is ${plaintext.length} bytes, over the ${params.maxBytes}-byte limit`,
    );
  }
  return plaintext;
}

/**
 * Encrypt a buffer and upload it to the CDN.
 *
 * @param params - plaintext, upload target, and key.
 * @returns the download-side encrypted query parameter for the sent message.
 */
export async function uploadCdnBuffer(params: {
  buf: Buffer;
  uploadFullUrl?: string;
  uploadParam?: string;
  filekey: string;
  cdnBaseUrl: string;
  aeskey: Buffer;
  label: string;
}): Promise<{ downloadParam: string }> {
  const ciphertext = encryptAesEcb(params.buf, params.aeskey);
  const full = params.uploadFullUrl?.trim();
  const url = full
    ? full
    : params.uploadParam
      ? buildCdnUploadUrl({
          cdnBaseUrl: params.cdnBaseUrl,
          uploadParam: params.uploadParam,
          filekey: params.filekey,
        })
      : '';
  if (!url) throw new Error(`${params.label}: no CDN upload URL`);
  assertSafeMediaUrl(url, params.label);

  let lastError: unknown;
  for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(ciphertext),
      });
      if (response.status >= 400 && response.status < 500) {
        const detail = response.headers.get('x-error-message') ?? (await response.text());
        throw new Error(`${params.label}: CDN upload rejected (${response.status}): ${detail}`);
      }
      if (response.status !== 200) {
        throw new Error(`${params.label}: CDN upload HTTP ${response.status}`);
      }
      const downloadParam = response.headers.get('x-encrypted-param');
      if (!downloadParam) {
        throw new Error(`${params.label}: CDN upload response had no x-encrypted-param header`);
      }
      return { downloadParam };
    } catch (error) {
      lastError = error;
      // A 4xx is deterministic: retrying cannot help.
      if (error instanceof Error && error.message.includes('rejected')) throw error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`${params.label}: CDN upload failed after ${UPLOAD_MAX_RETRIES} attempts`);
}
