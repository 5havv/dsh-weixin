/**
 * Configuration schema for the Weixin↔agent bridge.
 *
 * @module @5havv/dsh-weixin/bridge/config
 */

import Schema from '@deepseek-ai/schemastery';

/** Direct-message access policy for inbound WeChat messages. */
export type DmPolicy = 'open' | 'allowlist' | 'disabled';
/** Group access policy for inbound WeChat messages. */
export type GroupPolicy = 'open' | 'allowlist' | 'disabled';

/** Resolved bridge configuration. */
export interface BridgeConfig {
  /** Enable the bridge. Off by default: the service alone is useful without it. */
  enabled?: boolean;
  /**
   * Conversation isolation. `per-peer` (default) gives every contact its own
   * agent and session; `shared` routes every contact into one conversation.
   */
  sessionMode?: 'per-peer' | 'shared';
  /** Which direct messages may drive an agent. */
  dmPolicy?: DmPolicy;
  /** Peer ids allowed when `dmPolicy` is `allowlist`. */
  allowlist?: string[];
  /** Which group messages may drive an agent. */
  groupPolicy?: GroupPolicy;
  /** Group ids allowed when `groupPolicy` is `allowlist`. */
  groupAllowlist?: string[];
  /** Agent preset applied to bridge-created agents. */
  agentPreset?: string;
  /** Provider route for bridge-created agents; defaults to the deployment default. */
  provider?: string;
  /** Model id for bridge-created agents; defaults to the deployment default. */
  model?: string;
}

/** Schemastery schema for {@link BridgeConfig}. */
export const Config: Schema<BridgeConfig> = Schema.object({
  enabled: Schema.boolean().default(false),
  sessionMode: Schema.union(['per-peer', 'shared']).default('per-peer'),
  dmPolicy: Schema.union(['open', 'allowlist', 'disabled']).default('open'),
  allowlist: Schema.array(Schema.string()).default([]),
  groupPolicy: Schema.union(['open', 'allowlist', 'disabled']).default('disabled'),
  groupAllowlist: Schema.array(Schema.string()).default([]),
  agentPreset: Schema.string().default(''),
  provider: Schema.string().default(''),
  model: Schema.string().default(''),
});
