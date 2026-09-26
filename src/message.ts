/**
 * Message construction and extraction helpers shared by the inbound loop,
 * the outbound sender, and the plugin bridge.
 *
 * @module @5havv/dsh-weixin/message
 */

import crypto from 'node:crypto';

import { MessageItemType, MessageType, type MessageItem, type WeixinMessage } from './protocol/types.js';
import type { UploadedMedia } from './media.js';

/**
 * Shared media envelope fields for a newly built outbound item.
 *
 * The key travels base64-encoded over its ASCII hex form, which is the encoding
 * the backend expects on this direction (inbound keys arrive in either form).
 */
function cdnMediaRef(uploaded: UploadedMedia): {
  encrypt_query_param: string;
  aes_key: string;
  encrypt_type: number;
} {
  return {
    encrypt_query_param: uploaded.downloadEncryptedQueryParam,
    aes_key: Buffer.from(uploaded.aeskeyHex).toString('base64'),
    encrypt_type: 1,
  };
}

/**
 * Build the message item for one uploaded file, classified by its type.
 *
 * @param uploaded - the CDN upload result.
 * @param fileName - display name, used for plain file attachments.
 * @returns the item to place in `item_list`.
 */
export function buildMediaItem(uploaded: UploadedMedia, fileName?: string): MessageItem {
  switch (uploaded.mediaType) {
    case 1:
      return {
        type: MessageItemType.IMAGE,
        image_item: { media: cdnMediaRef(uploaded), mid_size: uploaded.fileSizeCiphertext },
      };
    case 2:
      return {
        type: MessageItemType.VIDEO,
        video_item: { media: cdnMediaRef(uploaded), video_size: uploaded.fileSizeCiphertext },
      };
    default:
      return {
        type: MessageItemType.FILE,
        file_item: {
          media: cdnMediaRef(uploaded),
          ...(fileName ? { file_name: fileName } : {}),
          len: String(uploaded.fileSize),
        },
      };
  }
}

/**
 * Build an outbound message carrying exactly one item.
 *
 * Each media item is sent as its own request so `item_list` always holds a
 * single entry, which is what the backend expects.
 *
 * @param toUserId - target peer id.
 * @param item - the item to send.
 * @param contextToken - conversation token from the inbound message.
 * @returns the message payload for `sendmessage`.
 */
export function buildItemMessage(
  toUserId: string,
  item: MessageItem,
  contextToken?: string,
): WeixinMessage {
  return {
    from_user_id: '',
    to_user_id: toUserId,
    client_id: generateClientId(),
    message_type: MessageType.BOT,
    message_state: 2,
    item_list: [item],
    ...(contextToken ? { context_token: contextToken } : {}),
  };
}

/**
 * Extract the concatenated text of a message's text items.
 *
 * @param itemList - message items from the wire.
 * @returns the joined text (empty string when the message carries none).
 */
export function extractText(itemList: MessageItem[] | undefined): string {
  if (!itemList?.length) return '';
  const parts: string[] = [];
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && typeof item.text_item?.text === 'string') {
      parts.push(item.text_item.text);
    }
  }
  return parts.join('');
}

/** Whether an inbound message was produced by the bot itself rather than a human. */
export function isBotMessage(message: WeixinMessage): boolean {
  return message.message_type === MessageType.BOT;
}

/**
 * Generate a client-side message identity.
 *
 * The backend rejects `sendmessage` without one (`ret=-2 prepare failed`), so
 * every outbound message carries a unique id of the form
 * `{prefix}:{timestamp}-{8 hex chars}`.
 *
 * @returns a fresh client message id.
 */
export function generateClientId(): string {
  return `dsh-weixin:${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Build an outbound text message.
 *
 * @param toUserId - target peer id (the `from_user_id` of the inbound message).
 * @param text - text body to send.
 * @param contextToken - conversation token obtained from the inbound message.
 * @returns the message payload for `sendmessage`.
 */
export function buildTextMessage(toUserId: string, text: string, contextToken?: string): WeixinMessage {
  return {
    from_user_id: '',
    to_user_id: toUserId,
    client_id: generateClientId(),
    message_type: MessageType.BOT,
    // FINISH: the message is complete, not a streaming generation.
    message_state: 2,
    item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
    ...(contextToken ? { context_token: contextToken } : {}),
  };
}

/**
 * Split text into chunks that respect the platform's per-message limit.
 *
 * Splitting prefers paragraph, then line, then whitespace boundaries so that
 * fences and paragraphs stay intact whenever possible.
 *
 * @param text - the full reply text.
 * @param maxLength - maximum characters per chunk.
 * @returns one or more chunks; an empty input yields a single empty chunk.
 */
export function chunkText(text: string, maxLength: number): string[] {
  if (maxLength < 1) throw new Error('weixin: maxLength must be >= 1');
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxLength) {
    const window = rest.slice(0, maxLength);
    const candidates = [window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf(' ')];
    const cut = candidates.find((index) => index > maxLength * 0.5);
    const end = cut ?? maxLength;
    chunks.push(rest.slice(0, end).trimEnd());
    rest = rest.slice(end).trimStart();
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}
