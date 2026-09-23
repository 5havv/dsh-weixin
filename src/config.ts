/**
 * Configuration schema for the Weixin service plugin.
 *
 * Every deployment-dependent value is a config field (no hardcoded tunables),
 * so a deployment can change behaviour from `cordis.yml` without editing code.
 *
 * @module @5havv/dsh-weixin/config
 */

import Schema from '@deepseek-ai/schemastery';

/** Resolved configuration for the Weixin service plugin. */
export interface Config {
  /**
   * Directory holding account credentials, the long-poll cursor, and context
   * tokens. Empty means `$DSH_HOME/weixin` (or `~/.dsh/weixin`).
   */
  dataDir?: string;
  /** Account ids to connect on startup; empty connects every stored account. */
  accounts?: string[];
  /** Whether to open the inbound long poll for the configured accounts. */
  autoConnect?: boolean;
  /** Long-poll budget for `getupdates`; the server may lower it at runtime. */
  pollTimeoutMs?: number;
  /** Self-declared agent string sent as `bot_agent` on every request. */
  botAgent?: string;
  /** Register the model-facing `weixin_send` tool. */
  toolEnabled?: boolean;
  /** Per-message character budget when chunking outbound text. */
  maxMessageLength?: number;
}

/** Schemastery schema for {@link Config}. */
export const Config: Schema<Config> = Schema.object({
  dataDir: Schema.string().default(''),
  accounts: Schema.array(Schema.string()).default([]),
  autoConnect: Schema.boolean().default(true),
  pollTimeoutMs: Schema.number().default(35_000),
  botAgent: Schema.string().default('dsh-weixin'),
  toolEnabled: Schema.boolean().default(true),
  maxMessageLength: Schema.number().default(4_000),
});
