/**
 * iLink Bot API protocol types (personal WeChat).
 *
 * Wire format: JSON over HTTP. `bytes` fields are base64 strings in JSON;
 * uint64 identifiers are carried as strings to avoid precision loss.
 *
 * Derived from the documented iLink backend protocol published by Tencent's
 * `openclaw-weixin` channel (MIT). Field names and semantics are kept identical
 * so both implementations can talk to the same backend.
 *
 * @module @5havv/dsh-weixin/protocol/types
 */

/** Common request metadata attached to every API request. */
export interface BaseInfo {
  channel_version?: string;
  /**
   * Self-declared upstream app identity, analogous to HTTP `User-Agent`.
   * Observability only — never used for auth or routing.
   */
  bot_agent?: string;
}

/** Upload media classification (`proto: UploadMediaType`). */
export const UploadMediaType = {
  IMAGE: 1,
  VIDEO: 2,
  FILE: 3,
  VOICE: 4,
} as const;

export interface GetUploadUrlReq {
  filekey?: string;
  media_type?: number;
  to_user_id?: string;
  /** Plaintext size of the original file. */
  rawsize?: number;
  /** Plaintext MD5 of the original file. */
  rawfilemd5?: string;
  /** Ciphertext size after AES-128-ECB encryption. */
  filesize?: number;
  /** Plaintext size of the thumbnail (required for IMAGE/VIDEO). */
  thumb_rawsize?: number;
  thumb_rawfilemd5?: string;
  thumb_filesize?: number;
  /** Skip thumbnail upload URL; defaults to false. */
  no_need_thumb?: boolean;
  aeskey?: string;
}

export interface GetUploadUrlResp {
  upload_param?: string;
  thumb_upload_param?: string;
  /** Fully-formed upload URL returned by the server (no client-side joining). */
  upload_full_url?: string;
}

/** `proto: MessageType`. */
export const MessageType = {
  NONE: 0,
  USER: 1,
  BOT: 2,
} as const;

/** `proto: MessageItemType`. */
export const MessageItemType = {
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
  TOOL_CALL_START: 11,
  TOOL_CALL_RESULT: 12,
} as const;

/** `proto: MessageState`. */
export const MessageState = {
  NEW: 0,
  GENERATING: 1,
  FINISH: 2,
} as const;

export interface TextItem {
  text?: string;
}

/** CDN media reference; `aes_key` is base64-encoded bytes in JSON. */
export interface CDNMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  /** 0 = encrypt fileid only, 1 = pack thumbnail/mid-size metadata. */
  encrypt_type?: number;
  /** Fully-formed download URL returned by the server. */
  full_url?: string;
}

export interface ImageItem {
  media?: CDNMedia;
  thumb_media?: CDNMedia;
  /** Raw AES-128 key as a hex string (16 bytes); preferred for inbound decryption. */
  aeskey?: string;
  url?: string;
  mid_size?: number;
  thumb_size?: number;
  thumb_height?: number;
  thumb_width?: number;
  hd_size?: number;
}

export interface VoiceItem {
  media?: CDNMedia;
  /** 1=pcm 2=adpcm 3=feature 4=speex 5=amr 6=silk 7=mp3 8=ogg-speex */
  encode_type?: number;
  bits_per_sample?: number;
  sample_rate?: number;
  /** Voice duration in milliseconds. */
  playtime?: number;
  /** Platform-provided speech-to-text, when available. */
  text?: string;
}

export interface FileItem {
  media?: CDNMedia;
  file_name?: string;
  md5?: string;
  len?: string;
}

export interface VideoItem {
  media?: CDNMedia;
  video_size?: number;
  play_length?: number;
  video_md5?: string;
  thumb_media?: CDNMedia;
  thumb_size?: number;
  thumb_height?: number;
  thumb_width?: number;
}

export interface RefMessage {
  message_item?: MessageItem;
  /** Quoted-message digest. */
  title?: string;
  /** Server message id, used when newer clients omit the quoted content. */
  svr_id?: string;
  partial_text?: PartialText;
}

export interface PartialText {
  start: string;
  end: string;
  startindex: number;
  endindex: number;
  quotemd5: string;
}

export interface ToolCallStartItem {
  tool_name?: string;
  tool_call_id?: string;
}

export interface ToolCallResultItem {
  tool_name?: string;
  tool_call_id?: string;
  status?: string;
}

export interface MessageItem {
  type?: number;
  create_time_ms?: number;
  update_time_ms?: number;
  is_completed?: boolean;
  msg_id?: string;
  ref_msg?: RefMessage;
  text_item?: TextItem;
  image_item?: ImageItem;
  voice_item?: VoiceItem;
  file_item?: FileItem;
  video_item?: VideoItem;
  tool_call_start_item?: ToolCallStartItem;
  tool_call_result_item?: ToolCallResultItem;
}

/** Unified inbound/outbound message (`proto: WeixinMessage`). */
export interface WeixinMessage {
  seq?: number;
  /** uint64 on the wire; parsed losslessly as a string. */
  message_id?: string;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  update_time_ms?: number;
  delete_time_ms?: number;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
  run_id?: string;
}

/** `getUpdates` request. */
export interface GetUpdatesReq {
  /** @deprecated compatibility only. */
  sync_buf?: string;
  /** Full context buf cached locally; send "" when none. */
  get_updates_buf?: string;
}

/** `getUpdates` response. */
export interface GetUpdatesResp {
  ret?: number;
  /** e.g. -14 = session timeout. */
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  /** @deprecated compatibility only. */
  sync_buf?: string;
  /** Full context buf to cache locally and send on the next request. */
  get_updates_buf?: string;
  /** Server-suggested timeout (ms) for the next long poll. */
  longpolling_timeout_ms?: number;
}

export interface SendMessageReq {
  msg?: WeixinMessage;
}

export interface SendMessageResp {
  /** uint64 on the wire; parsed losslessly as a string. */
  message_id?: string;
  ret?: number;
  errcode?: number;
  errmsg?: string;
}

/** Typing status: 1 = typing, 2 = cancel typing. */
export const TypingStatus = {
  TYPING: 1,
  CANCEL: 2,
} as const;

export interface SendTypingReq {
  ilink_user_id?: string;
  typing_ticket?: string;
  /** 1 = typing (default), 2 = cancel typing. */
  status?: number;
}

export interface SendTypingResp {
  ret?: number;
  errmsg?: string;
}

export interface GetConfigResp {
  ret?: number;
  errmsg?: string;
  /** Base64-encoded typing ticket for sendTyping. */
  typing_ticket?: string;
}

export interface NotifyStartResp {
  ret?: number;
  errmsg?: string;
}

export interface NotifyStopResp {
  ret?: number;
  errmsg?: string;
}

/** QR login status values returned by `get_qrcode_status`. */
export type QrLoginStatus =
  | 'wait'
  | 'scaned'
  | 'confirmed'
  | 'expired'
  | 'scaned_but_redirect'
  | 'need_verifycode'
  | 'verify_code_blocked'
  | 'binded_redirect';

export interface QrCodeResponse {
  qrcode: string;
  /** QR content URL; render it as a QR image for the user to scan. */
  qrcode_img_content: string;
}

export interface QrStatusResponse {
  status: QrLoginStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  /** User id of the person who scanned the QR code. */
  ilink_user_id?: string;
  /** New host to poll when status is `scaned_but_redirect`. */
  redirect_host?: string;
}
