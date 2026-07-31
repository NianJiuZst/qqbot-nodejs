/**
 * @tencent-connect/qqbot-nodejs · Middleware 完整示例
 *
 * 本示例演示 SDK **完整 Koa-style dataflow pipeline**：
 *
 *   ┌─ 防御层 ───────────────────────────────────────────────────────┐
 *   │ 1. errorHandler       —— 统一错误捕获 + 友好回复              │
 *   │ 2. messageFilter      —— 过滤 bot 回声 + 消息去重             │
 *   │ 3. rateLimiter        —— 三层限流（sender / group / global）  │
 *   │ 4. concurrencyGuard   —— 同用户/群串行处理（防 stream 并发）  │
 *   └───────────────────────────────────────────────────────────────┘
 *   ┌─ 网关层 ───────────────────────────────────────────────────────┐
 *   │ 5. accessPolicy       —— 黑白名单                             │
 *   │ 6. contentSanitizer   —— 去 @marker / face tags / 空白清洗   │
 *   │ 7. mentionGate        —— 群聊 @bot 判定                       │
 *   └───────────────────────────────────────────────────────────────┘
 *   ┌─ 协议层 ───────────────────────────────────────────────────────┐
 *   │ 8. quoteRef           —— 记录消息索引 + 解析引用消息          │
 *   │ 9. historyBuffer      —— 群历史缓冲                           │
 *   │10. envelopeFormatter  —— 组装 LLM prompt 上下文               │
 *   └───────────────────────────────────────────────────────────────┘
 *   ┌─ UX 层 ────────────────────────────────────────────────────────┐
 *   │12. typingIndicator    —— C2C 自动 typing                      │
 *   │13. slashCommand       —— /cmd 命令框架                         │
 *   └───────────────────────────────────────────────────────────────┘
 *   ┌─ 业务层（Koa downstream）────────────────────────────────────────┐
 *   │14. bot.on("message")  —— 兜底处理（接 LLM / echo）            │
 *   │    ↑ 作为 middleware chain 的尾部 downstream 执行              │
 *   │    ↑ middleware 的 await next() 后代码可做后置处理             │
 *   └───────────────────────────────────────────────────────────────┘
 *
 * Koa-style 设计：
 *   - bot.on("message") 是 chain 的最内层（downstream），不再是 chain 之外
 *   - 每个 middleware 通过 await next() 进入下游，next() 返回后可做后置逻辑
 *   - ctx.stop() 短路整个 chain（包括 downstream emit）
 *   - ctx 始终作为 bot.on("message") 的第一个参数传入
 *
 * 运行：
 *   export QQBOT_APP_ID="你的 AppID"
 *   export QQBOT_APP_SECRET="你的 AppSecret"
 *   pnpm example:middleware
 *
 * 可选环境变量：
 *   QQBOT_DATA_DIR="./.qqbot-data"      # session 持久化目录
 *   QQBOT_ALLOW_SENDERS="uid1,uid2"     # 白名单（留空=所有人可用）
 *   QQBOT_RATE_LIMIT=1                  # 启用限流
 *   QQBOT_MARKDOWN=0                    # 关闭 markdown（默认启用）
 *   QQBOT_DEBUG=1                       # debug 日志
 */

import * as path from "node:path";
import {
  QQBot,
  // ── 防御层 ──
  errorHandler,
  messageFilter,
  rateLimiter,
  concurrencyGuard,
  // ── 网关层 ──
  accessPolicy,
  contentSanitizer,
  mentionGate,
  // ── 协议层 ──
  quoteRef,
  historyBuffer,
  MemoryHistoryStore,
  envelopeFormatter,
  // ── UX 层 ──
  typingIndicator,
  slashCommand,
  // ── 存储 ──
  FileKVStore,
  kvSessionPersistence,
  // Types
  type Middleware,
} from "../../src/index.js";

// ═══════════════════════════════════════════════════════════════════
// 1. 凭证 & Logger
// ═══════════════════════════════════════════════════════════════════

const rawAppId = process.env.QQBOT_APP_ID?.trim();
const rawAppSecret = process.env.QQBOT_APP_SECRET?.trim();

if (!rawAppId || !rawAppSecret) {
  console.error("\n❌ 缺少凭证。请先：\n");
  console.error('   export QQBOT_APP_ID="你的 AppID"');
  console.error('   export QQBOT_APP_SECRET="你的 AppSecret"\n');
  process.exit(1);
}

const appId: string = rawAppId;
const appSecret: string = rawAppSecret;

const logger = {
  info: (msg: string) => console.error(`[INFO]  ${msg}`),
  error: (msg: string) => console.error(`[ERROR] ${msg}`),
  warn: (msg: string) => console.error(`[WARN]  ${msg}`),
  debug: (msg: string) => {
    if (process.env.QQBOT_DEBUG === "1") console.error(`[DEBUG] ${msg}`);
  },
};

// ═══════════════════════════════════════════════════════════════════
// 2. 持久化
// ═══════════════════════════════════════════════════════════════════

const dataDir = process.env.QQBOT_DATA_DIR?.trim() || path.resolve(".qqbot-data");

const kvStore = new FileKVStore({ dir: dataDir, fileName: "session.json", saveThrottleMs: 200 });
const sessionPersistence = kvSessionPersistence({ store: kvStore, accountId: appId });

logger.info(`持久化: ${dataDir}`);

// ═══════════════════════════════════════════════════════════════════
// 3. Bot 实例
// ═══════════════════════════════════════════════════════════════════

const bot = new QQBot({
  appId,
  appSecret,
  logger,
  sessionPersistence,
  markdownSupport: process.env.QQBOT_MARKDOWN !== "0",
});

// ═══════════════════════════════════════════════════════════════════
// 4. 自定义中间件：请求计时（Koa-style: next() 包含下游全部处理）
// ═══════════════════════════════════════════════════════════════════

function requestTiming(): Middleware {
  return async (ctx, next) => {
    const start = Date.now();
    await next(); // 包含下游 middleware + bot.on("message") handler
    const elapsed = Date.now() - start;
    ctx.log.debug?.(`[timing] ${ctx.message.kind} ${ctx.message.senderId.slice(0, 8)} total=${elapsed}ms stopped=${ctx.stopped}`);
  };
}

// ═══════════════════════════════════════════════════════════════════
// 5. Slash Commands 注册
// ═══════════════════════════════════════════════════════════════════

const slash = slashCommand({ prefixes: ["/", "!"], autoHelp: true });

slash.register({
  name: "ping",
  description: "连通性检查",
  handler: () => "pong!",
});

slash.register({
  name: ["history", "h"],
  description: "显示最近群历史",
  handler: (ctx) => {
    const history = ctx.state.history;
    if (!history || history.length === 0) return "（无缓冲历史）";
    return history
      .slice(-5)
      .map((h, i) => `${i + 1}. [${h.senderId.slice(0, 6)}] ${h.content.slice(0, 40)}`)
      .join("\n");
  },
});

slash.register({
  name: "quote",
  description: "查看当前引用的消息",
  handler: (ctx) => {
    const q = ctx.state.quote;
    if (!q) return "（当前消息未引用任何消息）";
    if (!q.entry) return `引用 refKey=${q.refKey}，但已过期/不在索引`;
    return `引用消息:\n  发送者: ${q.entry.senderId}\n  内容: ${q.entry.content}`;
  },
});

slash.register({
  name: "envelope",
  description: "查看 envelopeFormatter 生成的上下文",
  handler: (ctx) => {
    const env = ctx.state.envelope;
    return env ? `Envelope:\n${env}` : "（未生成 envelope）";
  },
});

slash.register({
  name: "echo",
  description: "回显文本",
  usage: "/echo <text>",
  handler: (ctx) => ctx.command.raw || "(请跟文本)",
});

slash.register({
  name: "whoami",
  description: "发送者信息",
  handler: (ctx) => [
    `scope: ${ctx.replyTarget.scope}`,
    `sender: ${ctx.message.senderId}`,
    `mention: ${JSON.stringify(ctx.state.mention ?? null)}`,
    `quote: ${ctx.state.quote ? "有" : "无"}`,
  ].join("\n"),
});

// ═══════════════════════════════════════════════════════════════════
// 7. 装载完整 Middleware Chain（14 层）
// ═══════════════════════════════════════════════════════════════════

// ── 防御层 ──
bot.use(errorHandler());
bot.use(requestTiming());
bot.use(messageFilter({ skipSelfEcho: true, dedup: { windowMs: 5000 } }));

if (process.env.QQBOT_RATE_LIMIT === "1") {
  bot.use(rateLimiter({
    perSender: { max: 3, windowMs: 10_000 },
    global: { max: 50, windowMs: 60_000 },
    onLimit: async (ctx, tier) => {
      await ctx.bot.sendText(ctx.replyTarget, `限流触发 (${tier})，请稍后再试`);
    },
  }));
  logger.info("限流已启用: 3次/10s per-sender, 50次/min global");
}

// 并发控制：同一用户/群串行处理，避免 stream 并发冲突
bot.use(concurrencyGuard({ strategy: "queue", maxQueue: 3 }));

// ── 网关层 ──
const allowSenders = process.env.QQBOT_ALLOW_SENDERS?.split(",").map((s) => s.trim()).filter(Boolean);
if (allowSenders && allowSenders.length > 0) {
  bot.use(accessPolicy({
    c2c: { mode: "allowlist", allow: allowSenders },
    group: { mode: "allowlist", allow: allowSenders },
    onBlock: (ctx, reason) => logger.warn(`blocked: ${ctx.message.senderId} (${reason})`),
  }));
  logger.info(`白名单: ${allowSenders.join(", ")}`);
}

bot.use(contentSanitizer({
  stripBotMention: true,
  collapseWhitespace: true,
}));

bot.use(mentionGate({
  requireMentionInGroup: true,
  alwaysAnswerC2C: true,
  passthrough: false,
  onSkip: (ctx, d) => ctx.log.debug?.(`[mention-gate] skip: ${d.reason}`),
}));

// ── 协议层 ──
bot.use(quoteRef());  // 一个中间件同时记录消息索引 + 解析引用
bot.use(historyBuffer({
  limit: 20,
  recordOnSkip: true,
  store: new MemoryHistoryStore(),
}));
bot.use(envelopeFormatter({ historyLimit: 5, includeQuote: true, includeSender: true }));

// ── UX 层 ──
bot.use(typingIndicator({
  durationSec: 15,
  predicate: (ctx) => (ctx.message.content ?? "").length >= 5,
}));

bot.use(slash.middleware);

// ═══════════════════════════════════════════════════════════════════
// 8. 兜底 message handler（作为 middleware chain 的 downstream 执行）
// ═══════════════════════════════════════════════════════════════════

bot.on("ready", () => {
  logger.info("🟢 Bot online");
  logger.info(`   中间件: ${bot.getMiddlewares().length} 层`);
  logger.info("   /help 查看命令");
});

bot.on("resumed", () => logger.info("🟢 Bot resumed"));
bot.on("error", (err) => logger.error(`🔴 ${err.message}`));

bot.on("message", async (ctx, msg) => {
  const content = (msg.content ?? "").trim();
  const hasAttachments = msg.attachments && msg.attachments.length > 0;

  // 无内容且无附件才跳过
  if (!content && !hasAttachments) return;

  logger.info(`[handler] ${msg.kind} ${msg.senderId.slice(0, 8)}: ${content || "[attachment]"}`);

  // ctx 始终可用（Koa-style downstream），直接访问 middleware 注入的数据
  const envelope = ctx.state.envelope as string | undefined;

  // 真实项目这里接 LLM，用 envelope 作为 user prompt
  // const response = await llm.chat([
  //   { role: "system", content: "你是一个 QQ 机器人助手。" },
  //   { role: "user", content: envelope },
  // ]);

  await bot.sendText(msg.replyTarget, envelope || `echo: ${content || "[attachment]"}`);
});

// ═══════════════════════════════════════════════════════════════════
// 8b. Interaction 事件处理（按钮回调）
// ═══════════════════════════════════════════════════════════════════

bot.on("interaction", async (ctx, event) => {
  const { button_id, button_data, user_id } = event.data.resolved;
  logger.info(`[interaction] button_id=${button_id} button_data=${button_data} user=${user_id ?? event.user_openid ?? "unknown"}`);

  // 根据 button_id 分发不同的业务逻辑
  switch (button_id) {
    case "confirm":
      logger.info("[interaction] 用户确认操作");
      break;
    case "cancel":
      logger.info("[interaction] 用户取消操作");
      break;
    default:
      logger.debug(`[interaction] 未注册的 button_id: ${button_id}`);
      break;
  }

  // QQ 平台要求 5 秒内 ACK，code: 0=成功, 1=失败, 2=频繁, 3=重复, 4=无权限, 5=仅管理员
  await ctx.bot.acknowledgeInteraction(event.id, 0);
});

// ═══════════════════════════════════════════════════════════════════
// 9. 启动
// ═══════════════════════════════════════════════════════════════════

const ac = new AbortController();
process.on("SIGINT", () => { logger.info("SIGINT"); ac.abort(); });
process.on("SIGTERM", () => { logger.info("SIGTERM"); ac.abort(); });

logger.info(`🚀 启动 (appId=${appId})`);

try {
  await bot.start(ac.signal);
  logger.info("Bot 已停止。");
  kvStore.flush();
  process.exit(0);
} catch (err) {
  logger.error(`启动失败: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
