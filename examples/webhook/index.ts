/**
 * @tencent-connect/qqbot-nodejs · Webhook 传输模式示例
 *
 * 本示例演示如何使用 Webhook（HTTP 回调）替代 WebSocket 接收消息。
 *
 * Webhook 模式适用于：
 *   - 无法维持长连接的环境（Serverless / Cloud Function）
 *   - 已有 HTTP 服务并希望复用的场景
 *   - 需要水平扩展的生产部署
 *
 * 工作原理：
 *   1. SDK 启动 HTTP 服务监听指定端口
 *   2. QQ 开放平台向你的回调地址 POST 事件
 *   3. SDK 自动完成 Ed25519 签名验证
 *   4. SDK 处理回调地址验证（op:13）
 *   5. 事件分发后返回 ACK（op:12）
 *
 * 配置步骤：
 *   1. 在 QQ 开放平台后台 → 开发设置 → 消息接收方式，选择 "HTTP 回调"
 *   2. 填写你的回调 URL（如 https://your-domain.com/callback）
 *   3. 平台会发送 op:13 验证请求，SDK 自动处理
 *
 * 运行：
 *   export QQBOT_APP_ID="你的 AppID"
 *   export QQBOT_APP_SECRET="你的 AppSecret"
 *   pnpm example:webhook
 *
 * 可选环境变量：
 *   QQBOT_WEBHOOK_PORT=8080      # 监听端口（默认 8080）
 *   QQBOT_WEBHOOK_PATH=/callback # 监听路径（默认 /callback）
 *   QQBOT_MARKDOWN=0             # 关闭 markdown（默认启用）
 *   QQBOT_DEBUG=1                # debug 日志
 */

import {
  QQBot,
  contentSanitizer,
  mentionGate,
  errorHandler,
  messageFilter,
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
// 2. Webhook 配置
// ═══════════════════════════════════════════════════════════════════

const webhookPort = Number(process.env.QQBOT_WEBHOOK_PORT) || 8080;
const webhookPath = process.env.QQBOT_WEBHOOK_PATH?.trim() || "/callback";

// ═══════════════════════════════════════════════════════════════════
// 3. Bot 实例 — transport: "webhook"
// ═══════════════════════════════════════════════════════════════════

const bot = new QQBot({
  appId,
  appSecret,
  logger,
  markdownSupport: process.env.QQBOT_MARKDOWN !== "0",

  // 关键配置：使用 webhook 传输
  transport: "webhook",
  webhook: {
    port: webhookPort,
    path: webhookPath,
  },
});

// ═══════════════════════════════════════════════════════════════════
// 4. Middleware（与 WebSocket 模式完全一致）
// ═══════════════════════════════════════════════════════════════════

bot.use(errorHandler());
bot.use(messageFilter({ skipSelfEcho: true, dedup: { windowMs: 5000 } }));
bot.use(contentSanitizer({ stripBotMention: true, collapseWhitespace: true }));
bot.use(mentionGate({
  requireMentionInGroup: true,
  alwaysAnswerC2C: true,
  passthrough: false,
}));

// ═══════════════════════════════════════════════════════════════════
// 5. 事件处理
// ═══════════════════════════════════════════════════════════════════

bot.on("ready", (data) => {
  logger.info("🟢 Webhook server ready");
  logger.info(`   ${JSON.stringify(data)}`);
});

bot.on("error", (err) => {
  logger.error(`🔴 ${err.message}`);
});

bot.on("message", async (ctx, msg) => {
  const content = (msg.content ?? "").trim();
  const hasAttachments = msg.attachments && msg.attachments.length > 0;

  if (!content && !hasAttachments) return;

  logger.info(`[handler] ${msg.kind} ${msg.senderId.slice(0, 8)}: ${content || "[attachment]"}`);

  // 简单 echo 回复 — 替换为你的业务逻辑
  await bot.sendText(msg.replyTarget, `echo: ${content || "[attachment]"}`);
});

// ═══════════════════════════════════════════════════════════════════
// 6. 启动
// ═══════════════════════════════════════════════════════════════════

const ac = new AbortController();
process.on("SIGINT", () => { logger.info("SIGINT"); ac.abort(); });
process.on("SIGTERM", () => { logger.info("SIGTERM"); ac.abort(); });

logger.info(`🚀 启动 Webhook 模式 (appId=${appId})`);
logger.info(`   监听: http://0.0.0.0:${webhookPort}${webhookPath}`);
logger.info("   请确保 QQ 开放平台后台已配置回调 URL 指向此地址");

try {
  await bot.start(ac.signal);
  logger.info("Bot 已停止。");
  process.exit(0);
} catch (err) {
  logger.error(`启动失败: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
