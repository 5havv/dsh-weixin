# @5havv/dsh-weixin

A **personal WeChat** channel plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH), built on Tencent's iLink Bot API — the same protocol used by Tencent's own [openclaw-weixin](https://github.com/Tencent/openclaw-weixin) channel and by [Hermes](https://hermes-agent.nousresearch.com/docs/zh-Hans/user-guide/messaging/weixin).

> Status: **v0.2 / milestones M1–M4**. QR login, long-poll receive, text and **media** (images, files, voice, video) in both directions, account storage, and the single-instance token lock.

See [`README.zh.md`](./README.zh.md) for the full documentation (Chinese).

## What it does

- Inbound WeChat direct messages drive a DSH agent; the agent's reply is sent back to the same conversation.
- `per-peer` session routing by default: every contact gets an independent agent and session.
- Registers a model-facing `weixin_send` tool for proactive sends, optionally with a local file attached.
- Inbound media is downloaded, AES-decrypted, and cached; images are handed to the attachment service so a vision model can see them.
- QR-code login — no public endpoint, webhook, or WebSocket required.
- Can import existing Hermes credentials instead of scanning again.

## Architecture

One npm package, two independently enableable Cordis plugins:

| Entry | Role |
|---|---|
| `@5havv/dsh-weixin` | Channel service: owns `ctx.weixin`, the iLink protocol, and the `weixin_send` tool. |
| `@5havv/dsh-weixin/bridge` | Relay: WeChat message → agent → reply. |

## Quick start

```sh
npm install
npm run verify                      # offline integration checks
npm run smoke -- login              # QR login
npm run smoke -- import <accountId> # or reuse Hermes credentials
npm run smoke -- listen             # print inbound messages
```

Load it into DSH from a working tree:

```sh
npm run build                        # required: DSH does not transpile TS entries
dsh --profile web --patch ./examples/cordis.dev.yml --dump-config
dsh --profile web --patch ./examples/cordis.dev.yml
```

> The overlay points at `lib/`, not `src/*.ts`: DSH resolves plugin entries with
> Node's ESM loader and does not transpile TypeScript, so a `src/index.ts` entry
> fails at boot with `ERR_MODULE_NOT_FOUND` on its `./x.js` specifiers.
> `--dump-config` only composes config and never imports the entry, so it will
> not surface this — always boot once after changing those paths.

> The iLink backend allows only **one live consumer per token**. Stop any other
> gateway using the same account first.

## Limitations

- Personal WeChat via an iLink bot identity: normal group chats usually receive
  no events, so direct messages are the reliable surface.
- One live consumer per token.
- Voice notes are cached as raw SILK (no transcoder is bundled); a platform transcript is passed through when present.

## Credits

Protocol reference: [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin) and
[NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) (both MIT).

## License

MIT
