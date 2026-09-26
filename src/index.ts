/**
 * Plugin entry: the Weixin channel service.
 *
 * Mounted by Cordis as a Service-class plugin; it occupies `ctx.weixin` and
 * exposes account management, outbound sending, inbound events, and the
 * model-facing `weixin_send` tool.
 *
 * @module @5havv/dsh-weixin
 */

export const name = 'weixin';

export {
  WeixinService as default,
  WeixinService,
  type WeixinInboundMessage,
  type WeixinAccountStatus,
  type WeixinMediaAttachment,
  type WeixinMediaFailure,
} from './service.js';
export { Config } from './config.js';
export {
  DEFAULT_MAX_MEDIA_BYTES,
  sendMediaToPeer,
  sendTextToPeer,
  SessionNotReadyError,
  type SendMediaOptions,
  type SendTextResult,
} from './outbound.js';
export {
  fetchInboundMedia,
  mimeFromFilename,
  sniffImageMime,
  uploadOutboundMedia,
  writeMediaCache,
  type InboundMedia,
  type UploadedMedia,
} from './media.js';
export {
  CDN_BASE_URL,
  decryptAesEcb,
  encryptAesEcb,
  parseAesKey,
} from './protocol/cdn.js';
export {
  listAccountIds,
  loadAccount,
  resolveDataDir,
  importAccountFromHermes,
  type WeixinAccountData,
} from './auth/accounts.js';
export { startLogin, waitForLogin, type LoginResult, type LoginSession } from './auth/qr-login.js';
