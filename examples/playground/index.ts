/**
 * @tencent-connect/qqbot-nodejs Playground
 *
 * 这个示例演示了 SDK 的核心能力：
 *   1. 连接 QQ 开放平台 WebSocket Gateway，接收 C2C / 群聊消息
 *   2. 文本消息的发送（普通 + Markdown）
 *   3. 文件 / 图片 / 语音 等媒体消息的接收 + 回传
 *   4. C2C 流式消息（mock：把用户输入逐字 2 字/秒发给用户）
 *
 * 使用方法：
 *
 *   export QQBOT_APP_ID="你的 AppID"
 *   export QQBOT_APP_SECRET="你的 AppSecret"
 *   pnpm playground
 *
 * 默认进入 stream 模式：在 C2C 私聊里直接发消息给机器人，机器人会以
 * 流式（2 字/秒）回放你说的话。
 *
 * 你也可以通过命令切换模式：
 *   echo            -> 简单回声
 *   stream          -> 流式回放（默认）
 *   slow            -> 流式 + 自定义速度，如 "slow 5" = 每秒 5 字
 *   md              -> 测试 Markdown 文本
 *   file            -> 收到文件 / 图片时自动回传
 *   help            -> 显示帮助
 */

import { QQBot, MediaFileType, type QQBotInboundMessage } from "../../src/index.js";

// ---------- 1. Read credentials from environment ----------

const rawAppId = process.env.QQBOT_APP_ID?.trim();
const rawAppSecret = process.env.QQBOT_APP_SECRET?.trim();

if (!rawAppId || !rawAppSecret) {
  console.error("\n❌ 缺少 QQBot 凭证。请先设置环境变量：\n");
  console.error("   export QQBOT_APP_ID=\"你的 AppID\"");
  console.error("   export QQBOT_APP_SECRET=\"你的 AppSecret\"\n");
  console.error("然后重新运行：pnpm playground\n");
  process.exit(1);
}

const appId: string = rawAppId;
const appSecret: string = rawAppSecret;

// ---------- 2. Logger that prints to stderr to keep stdout clean ----------

const logger = {
  info: (msg: string) => console.error(`[INFO]  ${msg}`),
  error: (msg: string) => console.error(`[ERROR] ${msg}`),
  warn: (msg: string) => console.error(`[WARN]  ${msg}`),
  debug: (msg: string) => {
    if (process.env.QQBOT_DEBUG === "1") {
      console.error(`[DEBUG] ${msg}`);
    }
  },
};

// ---------- 3. Bot setup ----------

const bot = new QQBot({
  appId,
  appSecret,
  logger,
  // 大多数沙箱机器人没有 markdown 权限，先关掉。
  markdownSupport: process.env.QQBOT_MARKDOWN === "1",
});

// 当前 mode（每个 user 私聊上下文独立）
const userMode = new Map<string, string>();

function getMode(userId: string): string {
  return userMode.get(userId) ?? "stream";
}

function setMode(userId: string, mode: string): void {
  userMode.set(userId, mode);
}

// ---------- 4. Mock streaming output: 2 chars / second ----------

async function streamReply(
  msg: QQBotInboundMessage,
  text: string,
  charsPerSecond = 2,
): Promise<void> {
  const target = msg.replyTarget;
  if (target.scope !== "c2c") {
    await bot.sendText(target, "[流式输出仅在 C2C 私聊支持。请直接私聊机器人测试。]");
    return;
  }

  console.error(`\n→ 准备流式回放 ${text.length} 字符（${charsPerSecond} 字/秒）`);

  // Throttle 至少 300ms，所以一次最多 1~2 字。
  // 我们让节流间隔 = 1000 / charsPerSecond，但不低于 SDK 内置最小值。
  const intervalMs = Math.max(Math.floor(1000 / Math.max(1, charsPerSecond)), 300);
  const stream = bot.openStream({ target, throttleMs: intervalMs });

  try {
    let buffer = "";
    for (let i = 0; i < text.length; i++) {
      buffer += text[i];
      await stream.update(buffer);
      // 每一步等 1/charsPerSecond 秒，模拟真实"打字"体感。
      await sleep(Math.floor(1000 / charsPerSecond));
    }
    const result = await stream.complete();
    console.error(`✓ 流式完成，msgId=${result?.id ?? "unknown"}`);
  } catch (err) {
    console.error(`✗ 流式失败：${err instanceof Error ? err.message : String(err)}`);
    stream.cancel();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- 5. File handling: download attachments and echo back ----------

async function handleFile(msg: QQBotInboundMessage): Promise<void> {
  if (!msg.attachments || msg.attachments.length === 0) {
    await bot.sendText(msg.replyTarget, "[本条消息没有附件]");
    return;
  }

  const att = msg.attachments[0];
  console.error(`\n→ 收到附件：${att.filename ?? "(unnamed)"} type=${att.content_type}`);

  // Determine file type from content-type.
  const fileType = inferFileType(att.content_type);

  // For demo: just acknowledge what we received and re-upload by URL.
  await bot.sendText(
    msg.replyTarget,
    `收到附件: ${att.filename ?? "untitled"} (${att.content_type})\n` +
      `URL: ${att.url}\n` +
      `准备回传...`,
  );

  try {
    // 注意：QQ 的 upload-by-url 通道允许某些受信白名单 host。
    // 此 playground 仅做最小演示。生产中你应该自己下载、再以 buffer 上传。
    const result = await bot.sendMedia({
      target: msg.replyTarget,
      fileType,
      url: att.url,
      content: "↑ 已回传你的文件",
    });
    console.error(`✓ 回传成功 file_uuid=${result.upload.file_uuid}`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`✗ 回传失败：${errMsg}`);
    await bot.sendText(msg.replyTarget, `回传失败：${errMsg}`);
  }
}

function inferFileType(contentType: string): MediaFileType {
  const lower = contentType.toLowerCase();
  if (lower.startsWith("image/")) return MediaFileType.IMAGE;
  if (lower.startsWith("video/")) return MediaFileType.VIDEO;
  if (lower.startsWith("audio/")) return MediaFileType.VOICE;
  return MediaFileType.FILE;
}

// ---------- 6. Built-in commands ----------

const HELP_TEXT = [
  "可用命令：",
  "  /help          显示本帮助",
  "  /mode          查看当前模式",
  "  /echo          切换：简单回声",
  "  /stream        切换：流式回放（默认 2 字/秒）",
  "  /slow N        切换：流式 + N 字/秒（默认 2）",
  "  /md            发送一条 Markdown 测试",
  "  /file <url>    主动给当前会话发一张图片",
  "  /info          显示机器人状态",
  "",
  "提示：发送 /stream 后，下次输入的任何文本都会被以流式逐字回放。",
].join("\n");

async function handleCommand(msg: QQBotInboundMessage, content: string): Promise<boolean> {
  const trimmed = content.trim();
  if (!trimmed.startsWith("/")) {
    return false;
  }
  const [command, ...rest] = trimmed.slice(1).split(/\s+/);
  const arg = rest.join(" ");
  const userId = msg.replyTarget.targetId;

  switch (command) {
    case "help": {
      await bot.sendText(msg.replyTarget, HELP_TEXT);
      return true;
    }
    case "mode": {
      await bot.sendText(msg.replyTarget, `当前模式: ${getMode(userId)}`);
      return true;
    }
    case "echo": {
      setMode(userId, "echo");
      await bot.sendText(msg.replyTarget, "已切换到 echo（简单回声）模式");
      return true;
    }
    case "stream": {
      setMode(userId, "stream");
      await bot.sendText(msg.replyTarget, "已切换到 stream（流式 2 字/秒）模式。请发送任意文本测试。");
      return true;
    }
    case "slow": {
      const n = Number(arg) || 2;
      setMode(userId, `slow:${n}`);
      await bot.sendText(msg.replyTarget, `已切换到 slow（流式 ${n} 字/秒）模式。请发送任意文本测试。`);
      return true;
    }
    case "md": {
      const md = `# Markdown 测试\n\n- **加粗**\n- *斜体*\n- \`inline code\`\n\n> 这是引用\n\n[链接示例](https://bot.q.qq.com)`;
      await bot.sendText(msg.replyTarget, md);
      return true;
    }
    case "file": {
      const url = arg.trim();
      if (!url) {
        await bot.sendText(msg.replyTarget, "用法：/file <url>");
        return true;
      }
      try {
        const result = await bot.sendImage(msg.replyTarget, { url });
        await bot.sendText(msg.replyTarget, `图片已发送：file_uuid=${result.upload.file_uuid}`);
      } catch (err) {
        await bot.sendText(
          msg.replyTarget,
          `发送失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return true;
    }
    case "info": {
      const tokenStatus = bot.tokenManager.getStatus(appId);
      const lines = [
        `appId: ${appId}`,
        `accountId: ${appId}`,
        `markdown: ${process.env.QQBOT_MARKDOWN === "1" ? "ON" : "OFF"}`,
        `mode: ${getMode(userId)}`,
        `token: ${tokenStatus.status}`,
      ];
      await bot.sendText(msg.replyTarget, lines.join("\n"));
      return true;
    }
    default:
      await bot.sendText(msg.replyTarget, `未知命令：/${command}\n输入 /help 查看可用命令。`);
      return true;
  }
}

// ---------- 7. Main message handler ----------

bot.on("ready", () => {
  console.error("\n🟢 Bot online. 等待 QQ 平台 push 消息...\n");
});

bot.on("resumed", () => {
  console.error("🟢 Bot resumed.");
});

bot.on("error", (err) => {
  console.error(`🔴 Bot error: ${err.message}`);
});

bot.on("message", async (ctx, msg) => {
  console.error(
    `\n[${new Date().toISOString()}] 收到 ${msg.kind} 消息 from ${msg.senderId}: ${JSON.stringify(msg.content)}`,
  );

  // 1) attachments?
  if (msg.attachments && msg.attachments.length > 0) {
    if (getMode(msg.replyTarget.targetId) === "file" || msg.attachments[0].content_type) {
      await handleFile(msg);
      return;
    }
  }

  const trimmed = (msg.content ?? "").trim();
  if (!trimmed) {
    return;
  }

  // 2) commands?
  if (await handleCommand(msg, trimmed)) {
    return;
  }

  // 3) follow current mode.
  const mode = getMode(msg.replyTarget.targetId);

  if (mode === "echo") {
    await bot.sendText(msg.replyTarget, `Echo: ${trimmed}`);
    return;
  }

  if (mode === "stream") {
    await streamReply(msg, trimmed, 2);
    return;
  }

  if (mode.startsWith("slow:")) {
    const n = Number(mode.slice(5)) || 2;
    await streamReply(msg, trimmed, n);
    return;
  }

  // Default fallback.
  await bot.sendText(msg.replyTarget, `未识别的模式：${mode}。输入 /help。`);
});

// ---------- 8. Start ----------

const ac = new AbortController();
process.on("SIGINT", () => {
  console.error("\n收到 SIGINT，停止 bot...");
  ac.abort();
});
process.on("SIGTERM", () => {
  console.error("\n收到 SIGTERM，停止 bot...");
  ac.abort();
});

console.error(`🚀 启动 QQBot playground (appId=${appId})`);
console.error("提示：");
console.error("   1. 仅 C2C 私聊支持流式 stream_messages。");
console.error("   2. 群聊里发消息会走普通发送（QQ 协议限制）。");
console.error("   3. 发送 /help 查看完整命令。\n");

try {
  await bot.start(ac.signal);
  console.error("\nBot 已停止。");
} catch (err) {
  console.error(`\n💥 Bot 启动失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
