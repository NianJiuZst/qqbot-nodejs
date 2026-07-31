# middleware 示例

> 完整演示 @tencent-connect/qqbot-nodejs 的 **Koa-style Middleware Chain** —— 对照 dataflow 设计的完整 14 层 pipeline。
>
> **Koa-style 设计**：`bot.on("message")` handler 作为 chain 的最内层 downstream 执行，middleware 的 `await next()` 之后可做后置处理（如计时、日志）。`ctx.stop()` 短路整个 chain，包括 downstream emit。

## 这个例子展示了什么

```
防御层 → 网关层 → 协议层 → UX 层 → 业务层
```

| # | 中间件 | 类别 | 作用 |
|---|---|---|---|
| 1 | `errorHandler` | 防御 | 统一错误捕获，失败时友好回复 |
| 2 | `requestTiming` | **自定义** | 记录每条消息处理耗时（含 downstream） |
| 3 | `messageFilter` | 防御 | 过滤 bot 回声 + 消息去重（5s 滑动窗口）|
| 4 | `rateLimiter` | 防御（可选）| 三层限流：per-sender / per-group / global |
| 5 | `concurrencyGuard` | 防御 | 同用户/群串行处理（防 stream 并发冲突） |
| 6 | `accessPolicy` | 网关（可选）| 白名单 |
| 7 | `contentSanitizer` | 网关 | 去 `<@!bot>` marker + 空白折叠 |
| 8 | `mentionGate` | 网关 | 群聊未 @bot 时短路 |
| 9 | `quoteRef` | 协议 | 记录消息索引 + 解析引用 → `ctx.state.quote` |
| 10 | `historyBuffer` | 协议 | 群消息历史缓冲 → `ctx.state.history` |
| 11 | `envelopeFormatter` | 协议 | 组装 LLM prompt 上下文 → `ctx.state.envelope` |
| 12 | `typingIndicator` | UX | C2C 自动 typing |
| 13 | `slashCommand` | UX | `/ping` `/help` `/quote` `/envelope` 等 |
| — | `bot.on("message")` | 业务 | Koa downstream（chain 尾部执行） |
| — | `bot.on("interaction")` | 业务 | 按钮回调 ACK + 分发 |

## 运行

```bash
export QQBOT_APP_ID="你的 AppID"
export QQBOT_APP_SECRET="你的 AppSecret"

# 可选
export QQBOT_DATA_DIR="./.qqbot-data"
export QQBOT_ALLOW_SENDERS="uid1,uid2"
export QQBOT_RATE_LIMIT=1
export QQBOT_MARKDOWN=0
export QQBOT_DEBUG=1

pnpm example:middleware
```

## 交互演示

```
你 → /help
bot → Available commands:
      /ping — 连通性检查
      /history, h — 显示最近群历史
      /quote — 查看当前引用的消息
      /envelope — 查看 envelopeFormatter 生成的上下文
      /echo — 回显文本 — /echo <text>
      /whoami — 发送者信息

你 → /ping
bot → pong!

你 → (引用某条消息) /quote
bot → 引用消息:
        发送者: xxx
        内容: 被引用的原文...

你 → /envelope
bot → Envelope:
      [发送者: Alice | 场景: c2c]
      [近期消息]
        Bob: 之前说的话...
```

## Dataflow Pipeline 可视化

```
QQ WebSocket Event
       │
       ▼
 errorHandler ─── 捕获所有下游异常
       │
 requestTiming ─── 记录处理耗时（自定义，包含 downstream）
       │
 messageFilter ─── bot 回声 / 重复消息? → 丢弃
       │
 rateLimiter ─── 超限? → 丢弃 + 提示
       │
 concurrencyGuard ─── 同用户/群串行处理
       │
 accessPolicy ─── 不在白名单? → 静默丢弃
       │
 contentSanitizer ─── 去 <@!bot> / 折叠空白
       │
 mentionGate ─── 群里未 @? → 短路
       │
 quoteRef ─── 记录 msg 索引 + 解析引用 → ctx.state.quote
       │
 historyBuffer ─── 写入群历史 → ctx.state.history
       │
 envelopeFormatter ─── history + quote + sender → ctx.state.envelope
       │
 typingIndicator ─── 发 typing API
       │
 slashCommand ─── 匹配 /cmd? → 执行 + 短路
       │
       ▼
 bot.on("message") ─── 业务逻辑（Koa downstream，在 chain 内部执行）
       │
       ▲ (next() 返回后，上游 middleware 可做后置处理)

────────────── interaction 独立通道 ──────────────

 INTERACTION_CREATE Event
       │
       ▼
 bot.on("interaction") ─── 按钮回调分发 + ACK
```

## ctx.state 数据流

```ts
// 各中间件写入 ctx.state 的 well-known keys：
ctx.state.mention   // mentionGate 写入：{ wasMentioned, shouldAnswer, ... }
ctx.state.quote     // quoteResolver 写入：{ refKey, entry: { senderId, content } }
ctx.state.history   // historyBuffer 写入：HistoryEntry[]
ctx.state.envelope  // envelopeFormatter 写入：组装好的 prompt 字符串
ctx.state.command   // slashCommand 写入：{ name, args, raw }
```

## 自定义中间件写法

```ts
import type { Middleware } from "@tencent-connect/qqbot-nodejs";

const myMiddleware: Middleware = async (ctx, next) => {
  // before（前处理）
  console.log("收到:", ctx.message.content);
  const t0 = Date.now();

  await next();  // 进入下游（包含后续 middleware + bot.on("message") handler）

  // after（后处理 — Koa-style）
  // 此时 downstream 已执行完毕，可做耗时统计、响应日志等
  console.log(`处理完毕, elapsed=${Date.now() - t0}ms, stopped=${ctx.stopped}`);
};

bot.use(myMiddleware);
```

常见模式：
- **日志/追踪** — `next()` 前后记录（Koa-style 洋葱模型）
- **短路** — 不调 `next()`，直接 `ctx.stop("reason")`
- **注入数据** — `ctx.state.myKey = xxx` 供下游消费
- **错误边界** — `try { await next() } catch { ... }`
- **修改消息** — `ctx.message.content = sanitized`（会传播到下游）
- **后置清理** — `next()` 之后释放资源、发送日志等

## 替换存储后端

```ts
// Redis 示例
const store: KVStore = {
  async get(key) { return JSON.parse(await redis.get(key) ?? "null") ?? undefined; },
  async set(key, val, ttlMs) { await redis.set(key, JSON.stringify(val), { PX: ttlMs }); },
  async delete(key) { return (await redis.del(key)) > 0; },
  async keys(prefix) { return []; },
};
```

## 相关文档

- [SDK README](../../README.md)
- [USAGE](../../USAGE.md)
- [CHANGELOG](../../CHANGELOG.md)
