/**
 * 主动向指定用户发送一段 100 字的流式消息（演示用）。
 *
 * QQ Open Platform 限制：`stream_messages` 必须基于一次用户的近期消息
 * （5 分钟有效的被动回复窗口）。这个脚本会等待目标用户向机器人发任意一条
 * 消息触发，然后立即以流式（≈2 字/秒）回放预设的 100 字内容，发完即退出。
 */

import { QQBot, type QQBotInboundMessage } from "../../src/index.js";

const TARGET_OPENID = process.env.QQBOT_TARGET_OPENID ?? "E3D7DA87EE3F90D3B689A91B62E9D1CA";
const CHARS_PER_SECOND = 2;

const PAYLOAD =
  "这是一条由 @tencent-connect/qqbot-nodejs SDK 发送的 100 字流式演示消息。" +
  "我会以约每秒 2 个字的速度，把这段话逐步推送给你，用来验证 stream_messages 调用链是否畅通完整。";

const TEXT = Array.from(PAYLOAD).slice(0, 100).join("");

const appId = process.env.QQBOT_APP_ID?.trim();
const appSecret = process.env.QQBOT_APP_SECRET?.trim();
if (!appId || !appSecret) {
  console.error("❌ 缺少 QQBOT_APP_ID / QQBOT_APP_SECRET 环境变量");
  process.exit(1);
}

const logger = {
  info: (msg: string) => console.error(`[INFO]  ${msg}`),
  error: (msg: string) => console.error(`[ERROR] ${msg}`),
  warn: (msg: string) => console.error(`[WARN]  ${msg}`),
  debug: (_: string) => {},
};

const bot = new QQBot({ appId, appSecret, logger });

const ac = new AbortController();
let delivered = false;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function streamReply(msg: QQBotInboundMessage): Promise<void> {
  if (msg.replyTarget.scope !== "c2c") {
    console.error(`⚠️  该用户当前不是 C2C 私聊上下文，跳过`);
    return;
  }
  console.error(`\n→ 触发消息收到，开始向 ${msg.senderId} 流式发送 ${TEXT.length} 个字符（${CHARS_PER_SECOND} 字/秒）`);
  console.error(`→ 文本：${TEXT}`);

  const intervalMs = Math.max(Math.floor(1000 / CHARS_PER_SECOND), 300);
  const stream = bot.openStream({ target: msg.replyTarget, throttleMs: intervalMs });

  try {
    let buffer = "";
    const chars = Array.from(TEXT);
    for (let i = 0; i < chars.length; i++) {
      buffer += chars[i];
      await stream.update(buffer);
      await sleep(Math.floor(1000 / CHARS_PER_SECOND));
    }
    const result = await stream.complete();
    console.error(`\n✓ 流式发送完成，msgId=${result?.id ?? "(none)"}`);
    delivered = true;
  } catch (err) {
    console.error(`✗ 发送失败：${err instanceof Error ? err.message : String(err)}`);
    stream.cancel();
  } finally {
    setTimeout(() => ac.abort(), 500);
  }
}

bot.on("ready", () => {
  console.error(`\n🟢 Bot online. 等待 ${TARGET_OPENID} 发送任意触发消息...`);
});

bot.on("message", async (ctx, msg) => {
  if (delivered) {
    return;
  }
  if (msg.senderId !== TARGET_OPENID) {
    console.error(`(忽略非目标用户的消息：${msg.senderId})`);
    return;
  }
  delivered = true;
  await streamReply(msg);
});

bot.on("error", (err) => console.error(`🔴 ${err.message}`));

process.on("SIGINT", () => ac.abort());
process.on("SIGTERM", () => ac.abort());

console.error(`🚀 准备就绪 (appId=${appId})。请用账号 ${TARGET_OPENID} 私聊机器人发任意一句话触发流式发送。`);

try {
  await bot.start(ac.signal);
  console.error("Bot 已停止。");
} catch (err) {
  console.error(`💥 ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
