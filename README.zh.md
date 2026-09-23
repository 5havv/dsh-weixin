# @5havv/dsh-weixin

让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）通过**个人微信**收发的渠道插件。基于腾讯 iLink Bot API，与腾讯官方 [openclaw-weixin](https://github.com/Tencent/openclaw-weixin) 及 [Hermes](https://hermes-agent.nousresearch.com/docs/zh-Hans/user-guide/messaging/weixin) 的微信适配器**同源同协议**。

> 状态：**v0.1 / M1–M3**。已实现扫码登录、长轮询收消息、文本回复、账号存储与单实例锁；媒体收发（M4）计划在 v0.2。

## 它做什么

| 能力 | 说明 |
|---|---|
| 收发文本 | 微信私聊消息 → DSH agent → 回复发回微信 |
| 每联系人独立会话 | 默认 `per-peer`，每个联系人一个 agent/session，记忆互不串味 |
| 模型可调用工具 | 注册 `weixin_send`，让 agent 主动给联系人发消息 |
| 扫码登录 | 终端二维码，无需公网地址、webhook 或 WebSocket |
| 凭证复用 | 可从 Hermes 导入同号凭证，免重新扫码 |

## 架构

一个 npm 包，两个可独立启用的 Cordis 插件：

```
@5havv/dsh-weixin           插件①：渠道服务（ctx.weixin + weixin_send 工具）
@5havv/dsh-weixin/bridge    插件②：桥接（微信消息 → agent → 回复微信）
```

- **插件①** 独占协议细节：iLink HTTP 客户端、扫码登录、长轮询、context_token、加密 CDN（v0.2）、账号与单实例锁。对外只暴露 `ctx.weixin` 服务与 `weixin/*` 事件。
- **插件②** 只做编排：策略过滤 → 会话映射 → `agent.send()` → 观察 `session/event` → `ctx.weixin.sendText()`。

## 快速开始

```sh
npm install
npm run typecheck     # 类型检查
npm run verify        # 离线集成验证（服务挂载 + 桥接接线）
npm run smoke -- list # 冒烟 CLI
```

### 登录 / 导入凭证

```sh
# 扫码登录并保存账号
npm run smoke -- login

# 或从 Hermes 导入同号凭证（免重新扫码）
npm run smoke -- import a1b2c3d4e5f6@im.bot

# 查看账号
npm run smoke -- list
```

### 收发测试（不经过 DSH）

```sh
npm run smoke -- listen           # 长轮询打印入站消息
npm run smoke -- send <accountId> <toUserId> 'hello'
```

> 注意：iLink 允许**同一 token 只有一个在线实例**。若 Hermes gateway 正在运行，请先 `systemctl --user stop hermes-gateway`，否则游标会互相抢占。

### 装进 DSH

开发期用绝对路径覆盖层（不改动已安装的 profile）：

```sh
npm run build                                                       # 必须先构建，见下方说明
dsh --profile web --patch ./examples/cordis.dev.yml --dump-config   # 只看组装结果
dsh --profile web --patch ./examples/cordis.dev.yml                 # 实际启动
```

> ⚠️ **开发覆盖层要指向 `lib/`，不能指向 `src/*.ts`。**
> DSH 的 loader 用 Node ESM 直接解析插件入口，**不做 TypeScript 转译**；而本仓库源码使用
> NodeNext 风格的 `./service.js` 说明符（对编译产物正确），直读 `.ts` 会在启动时报
> `ERR_MODULE_NOT_FOUND: Cannot find module '.../src/service.js'`。
> 注意 `--dump-config` 只组装配置、**不导入入口模块**，所以它不会暴露这个问题——改完路径务必真正启动一次。
> 每次改动源码后先 `npm run build`。

正式安装：

```sh
dsh plugin --profile web add @5havv/dsh-weixin
```

## 配置

### 渠道服务（`weixin`）

| 键 | 默认 | 说明 |
|---|---|---|
| `dataDir` | `$DSH_HOME/weixin` | 账号、游标、context_token 的落盘目录 |
| `accounts` | `[]` | 要连接的账号 id；空 = 连接所有已存账号 |
| `autoConnect` | `true` | 是否随插件启动长轮询 |
| `pollTimeoutMs` | `35000` | `getupdates` 长轮询预算 |
| `botAgent` | `dsh-weixin` | 请求里的 `bot_agent` 自声明 |
| `toolEnabled` | `true` | 是否注册 `weixin_send` 工具 |
| `maxMessageLength` | `4000` | 单条消息字符上限，超出按逻辑边界分块 |

### 桥接（`weixin-bridge`）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 是否启用自动回复 |
| `sessionMode` | `per-peer` | `per-peer` 每人独立会话 / `shared` 共用会话 |
| `dmPolicy` | `open` | `open` / `allowlist` / `disabled` |
| `allowlist` | `[]` | `dmPolicy=allowlist` 时生效 |
| `groupPolicy` | `disabled` | 群消息策略（iLink bot 通常收不到群消息） |
| `groupAllowlist` | `[]` | `groupPolicy=allowlist` 时生效 |
| `agentPreset` / `provider` / `model` | 空 | 透传给桥接创建的 agent |

## 已知限制

- **个人微信 / iLink bot 身份**：扫码后连接的是一个 bot 身份，多数账号类型**收不到普通微信群消息**，稳定可用场景是私聊。
- **单实例**：同一 token 同时只能有一个消费者在线（本实现用文件锁保证并给出明确报错）。
- **会话刷新**：若联系人长期未发消息，`context_token` 会失效；发送时自动降级为无 token 重发，仍失败则需该联系人先给 bot 发一条消息。
- **v0.1 仅文本**：图片/文件/语音/视频尚未处理。

## 致谢

协议实现参考了以下项目，均为 MIT：

- [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin) — 公开了完整的 iLink 后端 API 协议
- [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) — `gateway/platforms/weixin.py`，其会话过期降级策略被本实现采纳

## License

MIT
