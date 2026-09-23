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
} from './service.js';
export { Config } from './config.js';
export { sendTextToPeer, SessionNotReadyError, type SendTextResult } from './outbound.js';
export {
  listAccountIds,
  loadAccount,
  resolveDataDir,
  importAccountFromHermes,
  type WeixinAccountData,
} from './auth/accounts.js';
export { startLogin, waitForLogin, type LoginResult, type LoginSession } from './auth/qr-login.js';
