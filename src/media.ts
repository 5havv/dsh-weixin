/**
 * Media handling: MIME classification, inbound retrieval, and outbound upload
 * preparation.
 *
 * The bridge decides what a decrypted blob becomes (an attachment, a cached
 * file, or just a transcript); this module owns the wire mechanics.
 *
 * @module @5havv/dsh-weixin/media
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { aesEcbPaddedSize, downloadCdnBuffer, uploadCdnBuffer } from './protocol/cdn.js';
import { getUploadUrl } from './protocol/api.js';
import { MessageItemType, UploadMediaType, type MessageItem } from './protocol/types.js';

/** Image media types the attachment service accepts. */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

/** What one decrypted inbound blob turned out to be. */
export interface InboundMedia {
  kind: 'image' | 'file' | 'voice' | 'video';
  mime: string;
  /** Suggested display/file name. */
  name?: string;
  /** Decrypted bytes. */
  data: Buffer;
  /** Platform-provided speech-to-text, for voice messages. */
  transcript?: string;
}

/** One decrypted inbound media file, cached on disk for the agent to open. */
export interface WeixinMediaAttachment {
  kind: 'image' | 'file' | 'voice' | 'video';
  mime: string;
  /** Display name of the cached file. */
  name: string;
  /** Absolute path of the cached decrypted file. */
  path: string;
  /** Decrypted size in bytes. */
  size: number;
  /** Platform-provided speech-to-text, for voice messages. */
  transcript?: string;
}

/** A media item that could not be retrieved. */
export interface WeixinMediaFailure {
  kind: 'image' | 'file' | 'voice' | 'video';
  reason: string;
}

/** Result of pushing one local file to the CDN. */
export interface UploadedMedia {
  /** `UploadMediaType` used for this upload. */
  mediaType: (typeof UploadMediaType)[keyof typeof UploadMediaType];
  /** Download-side encrypted query parameter to place in the message item. */
  downloadEncryptedQueryParam: string;
  /** Raw AES key as a hex string. */
  aeskeyHex: string;
  /** Plaintext size in bytes. */
  fileSize: number;
  /** Ciphertext size in bytes. */
  fileSizeCiphertext: number;
}

const IMAGE_MEDIA_TYPES: readonly ImageMediaType[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
];

const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.heic': 'image/heic',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.amr': 'audio/amr',
  '.silk': 'audio/silk',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'audio/wav': '.wav',
  'audio/silk': '.silk',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
};

/**
 * Guess a MIME type from a file name.
 *
 * @param fileName - the name to inspect.
 * @returns the MIME type, or `application/octet-stream`.
 */
export function mimeFromFilename(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();
  return MIME_BY_EXTENSION[extension] ?? 'application/octet-stream';
}

/** @returns a conventional extension for a MIME type, or `""`. */
export function extensionForMime(mime: string): string {
  return EXTENSION_BY_MIME[mime] ?? '';
}

/** @returns true when the attachment service can store this image type. */
export function isSupportedImageMime(mime: string): mime is ImageMediaType {
  return (IMAGE_MEDIA_TYPES as readonly string[]).includes(mime);
}

/**
 * Determine an image's real type from its leading bytes.
 *
 * The attachment service validates the declared media type against the decoded
 * bytes, and WeChat does not always label images accurately, so the bytes are
 * authoritative.
 *
 * @param data - the decrypted image.
 * @returns the detected image media type, or undefined when unrecognised.
 */
export function sniffImageMime(data: Buffer): ImageMediaType | undefined {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg';
  }
  if (data.length >= 6 && data.subarray(0, 6).toString('ascii').startsWith('GIF8')) {
    return 'image/gif';
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString('ascii') === 'RIFF' &&
    data.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return undefined;
}

/** Map a MIME type onto the upload classification the backend expects. */
export function uploadMediaTypeFor(mime: string): (typeof UploadMediaType)[keyof typeof UploadMediaType] {
  if (mime.startsWith('image/')) return UploadMediaType.IMAGE;
  if (mime.startsWith('video/')) return UploadMediaType.VIDEO;
  return UploadMediaType.FILE;
}

/**
 * Classify a message item's media kind.
 *
 * @param item - the wire item.
 * @returns its kind, or `file` for anything unrecognised.
 */
export function mediaKindOfItem(item: MessageItem): InboundMedia['kind'] {
  switch (item.type) {
    case MessageItemType.IMAGE:
      return 'image';
    case MessageItemType.VOICE:
      return 'voice';
    case MessageItemType.VIDEO:
      return 'video';
    default:
      return 'file';
  }
}

/** Whether a message carries anything this module can fetch. */
export function hasMedia(item: MessageItem): boolean {
  switch (item.type) {
    case MessageItemType.IMAGE:
      return Boolean(item.image_item?.media?.encrypt_query_param || item.image_item?.media?.full_url);
    case MessageItemType.VOICE:
      return Boolean(item.voice_item?.media?.encrypt_query_param || item.voice_item?.media?.full_url);
    case MessageItemType.FILE:
      return Boolean(item.file_item?.media?.encrypt_query_param || item.file_item?.media?.full_url);
    case MessageItemType.VIDEO:
      return Boolean(item.video_item?.media?.encrypt_query_param || item.video_item?.media?.full_url);
    default:
      return false;
  }
}

/**
 * A stable, filesystem-safe name for a cached inbound blob.
 *
 * @param name - suggested name from the wire, when any.
 * @param mime - resolved MIME type, used to append an extension.
 * @param fallbackExt - extension of last resort.
 * @returns a safe file name (never a path).
 */
export function mediaCacheName(name: string | undefined, mime: string, fallbackExt: string): string {
  const base = (name ?? '')
    // Path separators and control characters first, then any surviving `..`
    // run, so the result is a single, obviously-safe path component.
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120)
    .trim();
  const stem = base.length > 0 ? base : `media-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  if (path.extname(stem)) return stem;
  return `${stem}${extensionForMime(mime) || fallbackExt}`;
}

/**
 * Download and decrypt one inbound media item.
 *
 * Images may carry their key in `image_item.aeskey` (hex) rather than in
 * `media.aes_key`; both encodings are accepted.
 *
 * @param params - the item, CDN base URL, and byte limit.
 * @returns the decrypted blob, or undefined when the item is not fetchable.
 * @throws when a fetch fails; callers decide whether that is fatal.
 */
export async function fetchInboundMedia(params: {
  item: MessageItem;
  cdnBaseUrl: string;
  maxBytes: number;
  label: string;
}): Promise<InboundMedia | undefined> {
  const { item, cdnBaseUrl, maxBytes, label } = params;
  if (!hasMedia(item)) return undefined;

  switch (item.type) {
    case MessageItemType.IMAGE: {
      // Verified against the live CDN: `full_url` is the authoritative download
      // target. The URL the client would construct from `encrypt_query_param`
      // answers HTTP 400 for a parameter produced by our own upload (that
      // parameter targets the WeChat client), so the constructed form is only a
      // fallback for messages that omit `full_url`.
      const image = item.image_item!;
      const data = await downloadCdnBuffer({
        ...(image.media?.encrypt_query_param
          ? { encryptedQueryParam: image.media.encrypt_query_param }
          : {}),
        ...(image.media?.full_url ? { fullUrl: image.media.full_url } : {}),
        cdnBaseUrl,
        ...(image.aeskey ?? image.media?.aes_key
          ? { aesKey: image.aeskey ?? image.media?.aes_key ?? '' }
          : {}),
        maxBytes,
        label: `${label} image`,
      });
      return { kind: 'image', mime: sniffImageMime(data) ?? 'image/jpeg', data };
    }

    case MessageItemType.VOICE: {
      const voice = item.voice_item!;
      const data = await downloadCdnBuffer({
        ...(voice.media?.encrypt_query_param
          ? { encryptedQueryParam: voice.media.encrypt_query_param }
          : {}),
        ...(voice.media?.full_url ? { fullUrl: voice.media.full_url } : {}),
        cdnBaseUrl,
        ...(voice.media?.aes_key ? { aesKey: voice.media.aes_key } : {}),
        maxBytes,
        label: `${label} voice`,
      });
      return {
        kind: 'voice',
        // WeChat voice is SILK; no transcoder is bundled, so it is cached as-is.
        mime: 'audio/silk',
        name: `voice-${Date.now()}.silk`,
        data,
        ...(voice.text ? { transcript: voice.text } : {}),
      };
    }

    case MessageItemType.FILE: {
      const file = item.file_item!;
      const data = await downloadCdnBuffer({
        ...(file.media?.encrypt_query_param
          ? { encryptedQueryParam: file.media.encrypt_query_param }
          : {}),
        ...(file.media?.full_url ? { fullUrl: file.media.full_url } : {}),
        cdnBaseUrl,
        ...(file.media?.aes_key ? { aesKey: file.media.aes_key } : {}),
        maxBytes,
        label: `${label} file`,
      });
      const name = mediaCacheName(file.file_name, mimeFromFilename(file.file_name ?? ''), '.bin');
      return {
        kind: 'file',
        mime: mimeFromFilename(name),
        name,
        data,
      };
    }

    case MessageItemType.VIDEO: {
      const video = item.video_item!;
      const data = await downloadCdnBuffer({
        ...(video.media?.encrypt_query_param
          ? { encryptedQueryParam: video.media.encrypt_query_param }
          : {}),
        ...(video.media?.full_url ? { fullUrl: video.media.full_url } : {}),
        cdnBaseUrl,
        ...(video.media?.aes_key ? { aesKey: video.media.aes_key } : {}),
        maxBytes,
        label: `${label} video`,
      });
      return { kind: 'video', mime: 'video/mp4', name: `video-${Date.now()}.mp4`, data };
    }

    default:
      return undefined;
  }
}

/**
 * Persist a decrypted blob under the media cache directory.
 *
 * @param params - cache directory, file name, and bytes.
 * @returns the absolute path written.
 */
export function writeMediaCache(params: {
  cacheDir: string;
  name: string;
  data: Buffer;
}): string {
  fs.mkdirSync(params.cacheDir, { recursive: true });
  const target = path.join(params.cacheDir, params.name);
  fs.writeFileSync(target, params.data);
  return target;
}

/**
 * Resolve an outbound file path and confirm it lies inside an allowed root.
 *
 * The model chooses this path, and on a chat channel the model's instructions
 * can be influenced by whoever is messaging the bot. Reading an arbitrary path
 * would therefore turn `weixin_send` into a file-exfiltration primitive that
 * bypasses the harness's own filesystem sandbox, so the path is confined to
 * operator-approved roots and symlinks are resolved before the check.
 *
 * @param filePath - caller-supplied path.
 * @param roots - absolute directories the file must live under.
 * @returns the canonical path to read.
 * @throws when the path is outside every root or does not exist.
 */
export function resolveSendablePath(filePath: string, roots: readonly string[]): string {
  const resolved = path.resolve(filePath);
  let canonical: string;
  try {
    canonical = fs.realpathSync(resolved);
  } catch {
    throw new Error(`weixin: cannot read ${resolved}`);
  }
  const normalizedRoots = roots.map((root) => path.resolve(root));
  const allowed = normalizedRoots.some(
    (root) => canonical === root || canonical.startsWith(root + path.sep),
  );
  if (!allowed) {
    throw new Error(
      `weixin: refusing to send ${canonical} — outside the allowed roots ` +
        `(${normalizedRoots.join(', ')}). Widen mediaSendRoots to allow it.`,
    );
  }
  return canonical;
}

/**
 * Encrypt and upload one local file, ready to be referenced by a message item.
 *
 * @param params - file, recipient, and API credentials.
 * @returns the upload result to embed in the outbound item.
 */
export async function uploadOutboundMedia(params: {
  filePath: string;
  toUserId: string;
  baseUrl: string;
  token?: string;
  botAgent?: string;
  cdnBaseUrl: string;
}): Promise<UploadedMedia> {
  const plaintext = fs.readFileSync(params.filePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash('md5').update(plaintext).digest('hex');
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString('hex');
  const aeskey = crypto.randomBytes(16);
  const mediaType = uploadMediaTypeFor(mimeFromFilename(params.filePath));

  const upload = await getUploadUrl({
    baseUrl: params.baseUrl,
    ...(params.token ? { token: params.token } : {}),
    ...(params.botAgent ? { botAgent: params.botAgent } : {}),
    filekey,
    media_type: mediaType,
    to_user_id: params.toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    // The bot never needs a thumbnail round trip; the backend accepts the file alone.
    no_need_thumb: true,
    aeskey: aeskey.toString('hex'),
  });

  if (!upload.upload_full_url?.trim() && !upload.upload_param) {
    throw new Error('uploadOutboundMedia: getUploadUrl returned no upload target');
  }

  const { downloadParam } = await uploadCdnBuffer({
    buf: plaintext,
    ...(upload.upload_full_url?.trim() ? { uploadFullUrl: upload.upload_full_url } : {}),
    ...(upload.upload_param ? { uploadParam: upload.upload_param } : {}),
    filekey,
    cdnBaseUrl: params.cdnBaseUrl,
    aeskey,
    label: `uploadOutboundMedia[${path.basename(params.filePath)}]`,
  });

  return {
    mediaType,
    downloadEncryptedQueryParam: downloadParam,
    aeskeyHex: aeskey.toString('hex'),
    fileSize: rawsize,
    fileSizeCiphertext: filesize,
  };
}

/**
 * Download, decrypt, and cache every media item in one inbound message.
 *
 * A failure on one item never discards the message: it is reported through
 * `failures` so the consumer can tell the contact what went wrong.
 *
 * @param params - the items, CDN base URL, limits, and where to cache.
 * @returns the cached attachments and the failures, in item order.
 */
export async function materializeInboundMedia(params: {
  itemList: readonly MessageItem[];
  cdnBaseUrl: string;
  maxBytes: number;
  /** Directory the decrypted files are written under. */
  cacheDir: string;
  /** Label used in error messages. */
  label: string;
}): Promise<{ media: WeixinMediaAttachment[]; failures: WeixinMediaFailure[] }> {
  const media: WeixinMediaAttachment[] = [];
  const failures: WeixinMediaFailure[] = [];

  for (const item of params.itemList) {
    if (!hasMedia(item)) continue;
    try {
      const fetched = await fetchInboundMedia({
        item,
        cdnBaseUrl: params.cdnBaseUrl,
        maxBytes: params.maxBytes,
        label: params.label,
      });
      if (!fetched) continue;
      const name = mediaCacheName(fetched.name, fetched.mime, `.${fetched.kind}`);
      const filePath = writeMediaCache({ cacheDir: params.cacheDir, name, data: fetched.data });
      media.push({
        kind: fetched.kind,
        mime: fetched.mime,
        name,
        path: filePath,
        size: fetched.data.length,
        ...(fetched.transcript ? { transcript: fetched.transcript } : {}),
      });
    } catch (error) {
      failures.push({
        kind: mediaKindOfItem(item),
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { media, failures };
}
