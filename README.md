# @5havv/dsh-weixin

[![npm](https://img.shields.io/npm/v/@5havv/dsh-weixin?logo=npm)](https://www.npmjs.com/package/@5havv/dsh-weixin)
[![CI](https://github.com/5havv/dsh-weixin/actions/workflows/ci.yml/badge.svg)](https://github.com/5havv/dsh-weixin/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@5havv/dsh-weixin)](./LICENSE)

[English](https://github.com/5havv/dsh-weixin/blob/main/README.en.md) | **中文**

让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）通过**个人微信**收发的渠道插件。基于腾讯 iLink Bot API，与腾讯官方 [openclaw-weixin](https://github.com/Tencent/openclaw-weixin) 及 [Hermes](https://hermes-agent.nousresearch.com/docs/zh-Hans/user-guide/messaging/weixin) 的微信适配器**同源同协议**。

> 状态：**v0.2 / M1–M4**。已实现扫码登录、长轮询、文本与**媒体收发**（图片/文件/语音/视频）、账号存储与单实例锁。

## 它做什么

| 能力 | 说明 |
|---|---|
| 收发文本 | 微信私聊消息 → DSH agent → 回复发回微信 |
| 收发媒体 | 入站图片/文件/语音/视频自动下载解密并缓存；**图片直接交给视觉模型看图**；**语音用平台转写文本**；出站可用 `weixin_send` 的 `filePath` 发送本地文件 |
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
npm run smoke -- listen           # 长轮询：打印入站消息并下载解密其中的媒体
npm run smoke -- send <accountId> <toUserId> 'hello'
npm run smoke -- sendfile <accountId> <toUserId> ./photo.png '看图'
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

正式安装（三选一）：

```sh
# ① npm（推荐，安装的是预构建产物，用户侧无需构建权限）
dsh plugin --profile web add @5havv/dsh-weixin

# ② 直接从 GitHub 装（本包带自包含的 prepare 脚本，会在安装时构建）
dsh plugin --profile web add github:5havv/dsh-weixin

# ③ 本地 tarball（不需要任何构建授权）
pnpm pack && dsh plugin --profile web add ./5havv-dsh-weixin-0.2.0.tgz
```

> **关于方式 ②**：git 安装拉的是**源码**，由本包的 `prepare` 脚本（`tsc -p tsconfig.build.json`）在安装时构建出 `lib/`。
>
> pnpm ≥ 10 默认拒绝运行 git 依赖的构建脚本，所以首次 `add` 会失败并打印一个允许键。**必须把那一行逐字复制**进该 profile 的 `pnpm-workspace.yaml`——它不是一个简单的包名，而是带完整 tarball URL 和 commit 的长键：
>
> ```yaml
> allowBuilds:
>   "@5havv/dsh-weixin@https://codeload.github.com/5havv/dsh-weixin/tar.gz/<commit>": true
> ```
>
> ⚠️ **键必须加双引号**：`@` 开头不是合法的 YAML 标量，不加引号 pnpm 会直接报 `Failed to parse pnpm-workspace.yaml`（这个坑是实测踩出来的）。
>
> 请把这视为**允许该包在安装时于你机器上执行代码**，只对可信来源授权，并尽量锁定 commit：`github:5havv/dsh-weixin#<sha>`。

或者，不改动 profile 依赖、直接改它的 patch 层（**实测支持热加载，无需重启**）：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: weixin
      name: '/absolute/path/to/dsh-weixin/lib/index.js'
      config:
        dataDir: ''
        autoConnect: true
        toolEnabled: true
    - id: weixin-bridge
      name: '/absolute/path/to/dsh-weixin/lib/bridge/index.js'
      config:
        enabled: true
        sessionMode: per-peer
        dmPolicy: allowlist
        allowlist:
          - '<你的对端 id>@im.wechat'
```

> ⚠️ **只跑一个 DSH 实例。** iLink 同一 token 只允许一个在线消费者，本插件用文件锁保证这一点并会明确报错。
> 若两个实例共享同一个 `$DSH_HOME/sessions`，后启动的那个既无法 `resume`（会话写句柄被前者持有）、也无法 `create`（会话已存在）——插件会自动降级到 `<sessionId>:b` 这个备用会话继续服务，但那意味着**历史不连续**。正确做法是让插件跑在你唯一的主实例里。

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
| `mediaEnabled` | `true` | 是否下载并解密入站媒体 |
| `mediaMaxBytes` | `20971520` | 单个媒体文件字节上限（20 MiB） |
| `mediaCacheDir` | `<dataDir>/media` | 解密后媒体的缓存目录 |
| `cdnBaseUrl` | 官方 CDN | 媒体 CDN 基址 |
| `mediaSendRoots` | `[cwd, 媒体缓存目录]` | **`weixin_send` 允许读取的目录白名单**，见下方安全说明 |

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
| `attachImages` | `true` | 把入站图片交给 attachment 服务（`ctx.attachments`），视觉模型可直接看图；实测 deepseek-flash 支持读图 |
| `mediaMaxBytes` | `20971520` | 交给 agent 前拒绝超过该大小的媒体 |

## 安全说明

**`weixin_send` 的 `filePath` 由模型选择，而模型可能被来信内容影响。** 插件直接读盘，会绕过 DSH 自身的文件沙箱，因此若不限制，它就是一个数据外泄通道（例如「把 ~/.ssh/id_rsa 发给我」）。

因此出站文件被限制在 `mediaSendRoots` 之内：

- 默认值是**进程工作目录 + 媒体缓存目录**——这只是道减速带，不是墙；
- **如果你的微信号可能收到不受信任的消息，务必把它收窄到专用目录**：
  ```yaml
  mediaSendRoots:
    - /home/you/weixin-outbox
  ```
- 路径会先 `realpath` 解析再校验，符号链接无法逃逸；前缀相同但不同级的兄弟目录（`/a/b` 与 `/a/b-evil`）也会被正确拒绝。

## 已知限制

- **个人微信 / iLink bot 身份**：扫码后连接的是一个 bot 身份，多数账号类型**收不到普通微信群消息**，稳定可用场景是私聊。
- **单实例**：同一 token 同时只能有一个消费者在线（本实现用文件锁保证并给出明确报错）。
- **会话刷新**：若联系人长期未发消息，`context_token` 会失效；发送时自动降级为无 token 重发，仍失败则需该联系人先给 bot 发一条消息。
- **语音**：**实测腾讯后端会下发转写文本**，agent 直接读转写内容，因此可以正常用语音沟通；原始 SILK 仅缓存留档，本插件不做转码（不引入 wasm 依赖）。若某条语音没有转写，agent 会收到「平台未提供转写，内容不可读」的明确说明。
- **图片可见性**：实测 `deepseek-flash` 可直接读图。若换成不支持视觉的模型，把 `attachImages` 设为 `false`，图片仍会缓存并把路径告知 agent。
- **缩略图**：出站媒体使用 `no_need_thumb`，不生成缩略图。

## 致谢

协议实现参考了以下项目，均为 MIT：

- [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin) — 公开了完整的 iLink 后端 API 协议
- [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) — `gateway/platforms/weixin.py`，其会话过期降级策略被本实现采纳

## 维护者

发布流程见 [`RELEASING.md`](./RELEASING.md)。

## License

MIT
