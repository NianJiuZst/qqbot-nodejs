/**
 * 对照实验：发送同样的 100 字内容，但走普通 C2C 文本 API（不走 stream_messages）。
 *
 * 用途：验证「该消息类型暂不支持查看」是 stream_messages 的 markdown content_type
 * 渲染权限问题，而非协议层 bug。等用户发任意一条消息触发，机器人会以普通文本
 * 一次性回复 100 字，看 QQ 客户端是否能正确显示。
 */

import { QQBot, type QQBotInboundMessage } from "../../src/index.js";

const TARGET_OPENID = process.env.QQBOT_TARGET_OPENID ?? "E3D7DA87EE3F90D3B689A91B62E9D1CA";

const PAYLOAD =
  "这是一条由 @tencent-connect/qqbot-nodejs SDK 发送的 100 字普通文本演示消息。" +
  "对照前一次 stream_messages 的渲染失败，本次走 v2 messages 普通通道，验证机器人协议链路是否正常。";

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

async function reply(msg: QQBotInboundMessage): Promise<void> {
  console.error(`\n→ 触发消息收到，向 ${msg.senderId} 发送普通文本 ${TEXT.length} 字`);
  console.error(`→ 文本：${TEXT}`);
  try {
    const result = await bot.sendText(msg.replyTarget, TEXT);
    console.error(`✓ 发送完成，msgId=${result.id ?? "(none)"}`);
    delivered = true;
  } catch (err) {
    console.error(`✗ 发送失败：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    setTimeout(() => ac.abort(), 500);
  }
}

bot.on("ready", () =>
  console.error(`\n🟢 Bot online. 等待 ${TARGET_OPENID} 发送任意触发消息...`),
);
bot.on("message", async (ctx, msg) => {
  if (delivered || msg.senderId !== TARGET_OPENID) {
    return;
  }
  delivered = true;
  await reply(msg);
});
bot.on("error", (err) => console.error(`🔴 ${err.message}`));

process.on("SIGINT", () => ac.abort());
process.on("SIGTERM", () => ac.abort());

console.error(`🚀 准备就绪 (appId=${appId})。请用 ${TARGET_OPENID} 私聊机器人发任意一句话触发。`);

try {
  await bot.start(ac.signal);
  console.error("Bot 已停止。");
} catch (err) {
  console.error(`💥 ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
