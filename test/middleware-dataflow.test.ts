/**
 * Tests for middleware: messageFilter, contentSanitizer,
 * rateLimiter, quoteRef, envelopeFormatter.
 */
import { describe, it, expect, vi } from "vitest";
import { createMiddlewareContext, runMiddlewareChain } from "../src/middleware/types.js";
import { messageFilter } from "../src/middleware/message-filter.js";
import { contentSanitizer } from "../src/middleware/content-sanitizer.js";
import { rateLimiter } from "../src/middleware/rate-limiter.js";
import { quoteRef, MemoryRefIndexStore } from "../src/middleware/quote-ref.js";
import { envelopeFormatter } from "../src/middleware/envelope-formatter.js";
import type { QQBot, QQBotInboundMessage } from "../src/QQBot.js";
import type { Logger } from "../src/protocol/types.js";

const silentLogger: Logger = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} };

function makeMessage(overrides: Partial<QQBotInboundMessage> = {}): QQBotInboundMessage {
  return {
    rawEventType: "C2C_MESSAGE_CREATE",
    kind: "c2c",
    senderId: "u1",
    content: "hello",
    messageId: "m1",
    timestamp: new Date().toISOString(),
    replyTarget: { scope: "c2c", targetId: "u1", msgId: "m1" },
    ...overrides,
  };
}

function makeBot(): QQBot {
  return {
    appId: "10086",
    accountId: "10086",
    sendText: vi.fn(),
  } as unknown as QQBot;
}

function makeCtx(msg: QQBotInboundMessage, bot?: QQBot) {
  return createMiddlewareContext({ bot: bot ?? makeBot(), message: msg, log: silentLogger });
}

// ============ messageFilter ============

describe("messageFilter", () => {
  it("drops messages from bot itself", async () => {
    const mw = messageFilter();
    const msg = makeMessage({ senderIsBot: true });
    const ctx = makeCtx(msg);
    const ok = await runMiddlewareChain([mw], ctx);
    expect(ok).toBe(false);
    expect(ctx.stopReason).toBe("self-echo");
  });

  it("passes non-bot messages", async () => {
    const mw = messageFilter();
    const msg = makeMessage({ senderIsBot: false });
    const ctx = makeCtx(msg);
    const ok = await runMiddlewareChain([mw], ctx);
    expect(ok).toBe(true);
  });

  it("passes messages without senderIsBot field", async () => {
    const mw = messageFilter();
    const msg = makeMessage();
    const ctx = makeCtx(msg);
    const ok = await runMiddlewareChain([mw], ctx);
    expect(ok).toBe(true);
  });

  it("drops duplicate messageId", async () => {
    const mw = messageFilter();
    await runMiddlewareChain([mw], makeCtx(makeMessage({ messageId: "dup1" })));

    const ctx2 = makeCtx(makeMessage({ messageId: "dup1" }));
    const ok = await runMiddlewareChain([mw], ctx2);
    expect(ok).toBe(false);
    expect(ctx2.stopReason).toBe("deduplication");
  });

  it("passes different messageIds", async () => {
    const mw = messageFilter();
    await runMiddlewareChain([mw], makeCtx(makeMessage({ messageId: "a" })));
    const ctx = makeCtx(makeMessage({ messageId: "b" }));
    const ok = await runMiddlewareChain([mw], ctx);
    expect(ok).toBe(true);
  });

  it("can disable self-echo check", async () => {
    const mw = messageFilter({ skipSelfEcho: false });
    const msg = makeMessage({ senderIsBot: true });
    const ctx = makeCtx(msg);
    const ok = await runMiddlewareChain([mw], ctx);
    expect(ok).toBe(true);
  });

  it("can disable dedup", async () => {
    const mw = messageFilter({ dedup: false });
    await runMiddlewareChain([mw], makeCtx(makeMessage({ messageId: "x" })));
    const ctx = makeCtx(makeMessage({ messageId: "x" }));
    const ok = await runMiddlewareChain([mw], ctx);
    expect(ok).toBe(true); // not deduped
  });
});

// ============ contentSanitizer ============

describe("contentSanitizer", () => {
  it("strips bot mention by default", async () => {
    const msg = makeMessage({ content: "<@!10086> hello world" });
    const ctx = makeCtx(msg);
    await runMiddlewareChain([contentSanitizer()], ctx);
    expect(ctx.message.content).toBe("hello world");
  });

  it("strips all mentions when stripAllMentions=true", async () => {
    const msg = makeMessage({ content: "<@!10086> hey <@!99999> hi" });
    const ctx = makeCtx(msg);
    await runMiddlewareChain([contentSanitizer({ stripAllMentions: true })], ctx);
    expect(ctx.message.content).toBe("hey hi");
  });

  it("collapses whitespace", async () => {
    const msg = makeMessage({ content: "  hello   world  \n  " });
    const ctx = makeCtx(msg);
    await runMiddlewareChain([contentSanitizer({ collapseWhitespace: true })], ctx);
    expect(ctx.message.content).toBe("hello world");
  });

  it("strips face tags by default", async () => {
    const msg = makeMessage({ content: "hi [<face,id=100/>] there" });
    const ctx = makeCtx(msg);
    await runMiddlewareChain([contentSanitizer()], ctx);
    expect(ctx.message.content).toBe("hi  there");
  });

  it("parses face tags to emoji when parseFaceTags=true", async () => {
    const msg = makeMessage({ content: "hi [<face,id=100/>]" });
    const ctx = makeCtx(msg);
    await runMiddlewareChain([contentSanitizer({ parseFaceTags: true })], ctx);
    expect(ctx.message.content).toBe("hi 😂");
  });

  it("applies custom transform", async () => {
    const msg = makeMessage({ content: "Hello" });
    const ctx = makeCtx(msg);
    await runMiddlewareChain([contentSanitizer({ transform: (c) => c.toLowerCase() })], ctx);
    expect(ctx.message.content).toBe("hello");
  });
});

// ============ rateLimiter ============

describe("rateLimiter", () => {
  it("allows messages within limit", async () => {
    const mw = rateLimiter({ perSender: { max: 2, windowMs: 1000 } });
    const ok1 = await runMiddlewareChain([mw], makeCtx(makeMessage()));
    const ok2 = await runMiddlewareChain([mw], makeCtx(makeMessage()));
    expect(ok1).toBe(true);
    expect(ok2).toBe(true);
  });

  it("blocks messages exceeding perSender limit", async () => {
    const mw = rateLimiter({ perSender: { max: 1, windowMs: 5000 } });
    await runMiddlewareChain([mw], makeCtx(makeMessage()));
    const ctx = makeCtx(makeMessage());
    const ok = await runMiddlewareChain([mw], ctx);
    expect(ok).toBe(false);
    expect(ctx.stopReason).toBe("rate-limit:perSender");
  });

  it("calls onLimit hook", async () => {
    const onLimit = vi.fn();
    const mw = rateLimiter({ perSender: { max: 1, windowMs: 5000 }, onLimit });
    await runMiddlewareChain([mw], makeCtx(makeMessage()));
    await runMiddlewareChain([mw], makeCtx(makeMessage()));
    expect(onLimit).toHaveBeenCalledWith(expect.anything(), "perSender");
  });

  it("supports global limit", async () => {
    const mw = rateLimiter({ global: { max: 2, windowMs: 5000 } });
    await runMiddlewareChain([mw], makeCtx(makeMessage({ senderId: "a" })));
    await runMiddlewareChain([mw], makeCtx(makeMessage({ senderId: "b" })));
    const ctx = makeCtx(makeMessage({ senderId: "c" }));
    const ok = await runMiddlewareChain([mw], ctx);
    expect(ok).toBe(false);
    expect(ctx.stopReason).toBe("rate-limit:global");
  });
});

// ============ quoteRef ============

describe("quoteRef", () => {
  it("records message and resolves quote (cache hit)", async () => {
    const store = new MemoryRefIndexStore();
    const mw = quoteRef({ store });

    // First message (will be referenced later)
    const msg1 = makeMessage({ messageId: "m-first", msgIdx: "idx-1", content: "original" });
    await runMiddlewareChain([mw], makeCtx(msg1));

    // Second message references the first
    const msg2 = makeMessage({ messageId: "m-second", refMsgIdx: "idx-1", content: "reply" });
    const ctx2 = makeCtx(msg2);
    await runMiddlewareChain([mw], ctx2);

    expect(ctx2.state.quote).toBeDefined();
    const quote = ctx2.state.quote as { source: string; entry: { content: string }; text: string };
    expect(quote.source).toBe("store");
    expect(quote.entry.content).toBe("original");
    expect(quote.text).toBe("original");
  });

  it("falls back to msg_elements[0] on cache miss", async () => {
    const mw = quoteRef();

    const msg = makeMessage({
      refMsgIdx: "nonexistent",
      msgElements: [
        { msg_idx: "nonexistent", content: "quoted text from event", attachments: [] },
      ],
    } as Partial<QQBotInboundMessage>);
    const ctx = makeCtx(msg);
    await runMiddlewareChain([mw], ctx);

    const quote = ctx.state.quote as { source: string; rawContent: string; text: string };
    expect(quote.source).toBe("msg_elements");
    expect(quote.rawContent).toBe("quoted text from event");
    expect(quote.text).toBe("quoted text from event");
  });

  it("handles voice attachment with ASR text in msg_elements fallback", async () => {
    const mw = quoteRef();

    const msg = makeMessage({
      refMsgIdx: "voice-ref",
      msgElements: [
        {
          msg_idx: "voice-ref",
          content: "",
          attachments: [
            { content_type: "audio/silk", url: "http://...", asr_refer_text: "你好世界" },
          ],
        },
      ],
    } as Partial<QQBotInboundMessage>);
    const ctx = makeCtx(msg);
    await runMiddlewareChain([mw], ctx);

    const quote = ctx.state.quote as { source: string; text: string; attachments: Array<{ asrText: string }> };
    expect(quote.source).toBe("msg_elements");
    expect(quote.text).toContain("voice: 你好世界");
    expect(quote.attachments[0].asrText).toBe("你好世界");
  });

  it("handles image attachment in msg_elements fallback", async () => {
    const mw = quoteRef();

    const msg = makeMessage({
      refMsgIdx: "img-ref",
      msgElements: [
        {
          msg_idx: "img-ref",
          content: "看这张图",
          attachments: [
            { content_type: "image/png", url: "http://img.qq.com/1.png" },
          ],
        },
      ],
    } as Partial<QQBotInboundMessage>);
    const ctx = makeCtx(msg);
    await runMiddlewareChain([mw], ctx);

    const quote = ctx.state.quote as { text: string };
    expect(quote.text).toContain("看这张图");
    expect(quote.text).toContain("[image]");
  });

  it("returns source=none when neither store nor msg_elements available", async () => {
    const mw = quoteRef();

    const msg = makeMessage({ refMsgIdx: "gone" });
    const ctx = makeCtx(msg);
    await runMiddlewareChain([mw], ctx);

    const quote = ctx.state.quote as { source: string; text: string };
    expect(quote.source).toBe("none");
    expect(quote.text).toBe("");
  });

  it("respects LRU eviction", async () => {
    const store = new MemoryRefIndexStore(2);
    const mw = quoteRef({ store });

    await runMiddlewareChain([mw], makeCtx(makeMessage({ msgIdx: "a", content: "1" })));
    await runMiddlewareChain([mw], makeCtx(makeMessage({ msgIdx: "b", content: "2" })));
    await runMiddlewareChain([mw], makeCtx(makeMessage({ msgIdx: "c", content: "3" })));

    expect(await store.get("a")).toBeUndefined();
    expect(await store.get("b")).toBeDefined();
    expect(await store.get("c")).toBeDefined();
  });
});

// ============ envelopeFormatter ============

describe("envelopeFormatter", () => {
  it("generates envelope with sender info", async () => {
    const msg = makeMessage({ senderName: "Alice", kind: "c2c" });
    const ctx = makeCtx(msg);
    await runMiddlewareChain([envelopeFormatter()], ctx);
    const env = ctx.state.envelope as string;
    expect(env).toContain("Alice");
    expect(env).toContain("c2c");
  });

  it("includes history when available", async () => {
    const msg = makeMessage();
    const ctx = makeCtx(msg);
    ctx.state.history = [
      { senderId: "u2", content: "prev msg", timestamp: Date.now(), messageId: "old" },
    ];
    await runMiddlewareChain([envelopeFormatter()], ctx);
    const env = ctx.state.envelope as string;
    expect(env).toContain("prev msg");
  });

  it("includes quote when available", async () => {
    const msg = makeMessage();
    const ctx = makeCtx(msg);
    ctx.state.quote = { refKey: "x", source: "store", entry: { messageId: "q", senderId: "u3", content: "quoted text", timestamp: "" }, text: "quoted text" };
    await runMiddlewareChain([envelopeFormatter()], ctx);
    const env = ctx.state.envelope as string;
    expect(env).toContain("quoted text");
  });

  it("uses custom format function", async () => {
    const msg = makeMessage();
    const ctx = makeCtx(msg);
    await runMiddlewareChain([envelopeFormatter({ format: () => "CUSTOM" })], ctx);
    expect(ctx.state.envelope).toBe("CUSTOM");
  });
});
