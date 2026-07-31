/**
 * Built-in middleware unit tests.
 */

import { describe, expect, it, vi } from "vitest";
import { accessPolicy } from "../src/middleware/access-policy.js";
import { historyBuffer, MemoryHistoryStore } from "../src/middleware/history-buffer.js";
import { mentionGate } from "../src/middleware/mention-gate.js";
import { slashCommand } from "../src/middleware/slash-command.js";
import { typingIndicator } from "../src/middleware/typing-indicator.js";
import { errorHandler } from "../src/middleware/error-handler.js";
import { createMiddlewareContext, runMiddlewareChain } from "../src/middleware/types.js";
import type { QQBot, QQBotInboundMessage } from "../src/QQBot.js";
import type { Logger } from "../src/protocol/types.js";

const silentLogger: Logger = {
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
};

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

function makeBot(overrides: Partial<QQBot> = {}): QQBot {
  return {
    appId: "10086",
    accountId: "10086",
    sendText: vi.fn(async () => ({ id: "x", timestamp: 0 })),
    sendTyping: vi.fn(async () => ({ refIdx: undefined })),
    ...overrides,
  } as unknown as QQBot;
}

function makeCtx(msg = makeMessage(), bot = makeBot()) {
  return createMiddlewareContext({ bot, message: msg, log: silentLogger });
}

// ============ accessPolicy ============

describe("accessPolicy", () => {
  it("allows everything by default (open mode)", async () => {
    const ctx = makeCtx();
    const ok = await runMiddlewareChain([accessPolicy()], ctx);
    expect(ok).toBe(true);
  });

  it("blocks group not in allowlist", async () => {
    const msg = makeMessage({ kind: "group", groupOpenid: "g-bad" });
    const ctx = makeCtx(msg);
    const onBlock = vi.fn();
    const ok = await runMiddlewareChain(
      [
        accessPolicy({
          group: { mode: "allowlist", allow: ["g-good"] },
          onBlock,
        }),
      ],
      ctx,
    );
    expect(ok).toBe(false);
    expect(ctx.stopReason).toMatch(/access:not in allowlist/);
    expect(onBlock).toHaveBeenCalledOnce();
  });

  it("allows group in allowlist with regex", async () => {
    const msg = makeMessage({ kind: "group", groupOpenid: "official-1" });
    const ctx = makeCtx(msg);
    const ok = await runMiddlewareChain(
      [accessPolicy({ group: { mode: "allowlist", allow: [/^official-/] } })],
      ctx,
    );
    expect(ok).toBe(true);
  });

  it("blocks via deny list", async () => {
    const ctx = makeCtx(makeMessage({ senderId: "spammer" }));
    const ok = await runMiddlewareChain(
      [accessPolicy({ c2c: { mode: "open", deny: ["spammer"] } })],
      ctx,
    );
    expect(ok).toBe(false);
  });
});

// ============ mentionGate ============

describe("mentionGate", () => {
  it("passes C2C messages through", async () => {
    const ctx = makeCtx(makeMessage({ kind: "c2c" }));
    const ok = await runMiddlewareChain([mentionGate()], ctx);
    expect(ok).toBe(true);
  });

  it("blocks non-mentioned group messages by default", async () => {
    const msg = makeMessage({ kind: "group", groupOpenid: "g1", content: "hi everyone" });
    const ctx = makeCtx(msg);
    const ok = await runMiddlewareChain([mentionGate()], ctx);
    expect(ok).toBe(false);
    expect(ctx.state.mention?.shouldAnswer).toBe(false);
  });

  it("allows group message with @bot in content", async () => {
    const msg = makeMessage({
      kind: "group",
      groupOpenid: "g1",
      content: "<@!10086> hello",
    });
    const ctx = makeCtx(msg);
    const ok = await runMiddlewareChain([mentionGate()], ctx);
    expect(ok).toBe(true);
    expect(ctx.state.mention?.wasMentioned).toBe(true);
  });

  it("allows group message with mentions[].is_you=true", async () => {
    const msg = makeMessage({
      kind: "group",
      groupOpenid: "g1",
      content: "hi",
      mentions: [{ is_you: true }],
    });
    const ctx = makeCtx(msg);
    const ok = await runMiddlewareChain([mentionGate()], ctx);
    expect(ok).toBe(true);
  });

  it("respects implicit-mention probe", async () => {
    const msg = makeMessage({ kind: "group", groupOpenid: "g1", content: "yes" });
    const ctx = makeCtx(msg);
    const ok = await runMiddlewareChain(
      [mentionGate({ isImplicitMention: () => true })],
      ctx,
    );
    expect(ok).toBe(true);
    expect(ctx.state.mention?.implicit).toBe(true);
  });

  it("passthrough mode does not stop chain even on no-mention", async () => {
    const msg = makeMessage({ kind: "group", groupOpenid: "g1", content: "hi" });
    const ctx = makeCtx(msg);
    const ok = await runMiddlewareChain([mentionGate({ passthrough: true })], ctx);
    expect(ok).toBe(true);
    expect(ctx.state.mention?.shouldAnswer).toBe(false);
  });

  it("treats GROUP_AT_MESSAGE_CREATE as implicit mention (QQ public-domain signal)", async () => {
    // Public-domain bots only receive GROUP_AT_MESSAGE_CREATE for group chats,
    // so the event itself is authoritative — even if `mentions` is empty
    // and the content carries no `<@!appId>` marker.
    const msg = makeMessage({
      rawEventType: "GROUP_AT_MESSAGE_CREATE",
      kind: "group",
      groupOpenid: "g1",
      content: "hello without explicit marker",
      // no mentions array, no content marker
    });
    const ctx = makeCtx(msg);
    const ok = await runMiddlewareChain([mentionGate()], ctx);
    expect(ok).toBe(true);
    expect(ctx.state.mention?.wasMentioned).toBe(true);
  });

  it("GROUP_MESSAGE_CREATE (private-domain) still requires explicit mention", async () => {
    // Private-domain bots receive GROUP_MESSAGE_CREATE for every group message,
    // so we must fall back to the content / mentions signal.
    const msg = makeMessage({
      rawEventType: "GROUP_MESSAGE_CREATE",
      kind: "group",
      groupOpenid: "g1",
      content: "random chatter",
    });
    const ctx = makeCtx(msg);
    const ok = await runMiddlewareChain([mentionGate()], ctx);
    expect(ok).toBe(false);
    expect(ctx.state.mention?.wasMentioned).toBe(false);
  });
});

// ============ slashCommand ============

describe("slashCommand", () => {
  it("dispatches command and short-circuits", async () => {
    const slash = slashCommand({ autoHelp: false });
    const handler = vi.fn(() => "pong");
    slash.register({ name: "ping", handler });
    const bot = makeBot();
    const ctx = makeCtx(makeMessage({ content: "/ping" }), bot);

    const ok = await runMiddlewareChain([slash.middleware], ctx);
    expect(ok).toBe(false);
    expect(ctx.stopReason).toMatch(/^command:matched:ping/);
    expect(handler).toHaveBeenCalledOnce();
    expect(bot.sendText).toHaveBeenCalledWith(ctx.replyTarget, "pong");
  });

  it("supports aliases", async () => {
    const slash = slashCommand({ autoHelp: false });
    const handler = vi.fn(() => "ok");
    slash.register({ name: ["whoami", "me"], handler });
    const ctx = makeCtx(makeMessage({ content: "/me" }));

    await runMiddlewareChain([slash.middleware], ctx);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("falls through to next middleware when no command matches", async () => {
    const slash = slashCommand({ autoHelp: false });
    slash.register({ name: "ping", handler: () => "pong" });
    const tail = vi.fn(async () => {});
    const ctx = makeCtx(makeMessage({ content: "hello" }));

    await runMiddlewareChain([slash.middleware, tail], ctx);
    expect(tail).toHaveBeenCalledOnce();
  });

  it("strips @bot mentions before matching", async () => {
    const slash = slashCommand({ autoHelp: false });
    const handler = vi.fn(() => "pong");
    slash.register({ name: "ping", handler });
    const ctx = makeCtx(makeMessage({ content: "<@!10086> /ping" }));

    await runMiddlewareChain([slash.middleware], ctx);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("auto-/help lists commands", async () => {
    const slash = slashCommand({});
    slash.register({ name: "ping", description: "test", handler: () => "pong" });
    const bot = makeBot();
    const ctx = makeCtx(makeMessage({ content: "/help" }), bot);

    await runMiddlewareChain([slash.middleware], ctx);
    expect(bot.sendText).toHaveBeenCalled();
    const arg = (bot.sendText as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string;
    expect(arg).toContain("/ping");
  });

  it("catches handler errors and sends error reply", async () => {
    const slash = slashCommand({ autoHelp: false });
    slash.register({
      name: "boom",
      handler: () => {
        throw new Error("oops");
      },
    });
    const bot = makeBot();
    const ctx = makeCtx(makeMessage({ content: "/boom" }), bot);

    await runMiddlewareChain([slash.middleware], ctx);
    const arg = (bot.sendText as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string;
    expect(arg).toMatch(/Error: oops/);
  });

  it("dispatches in group with GROUP_AT_MESSAGE_CREATE (no mentions)", async () => {
    const slash = slashCommand({ autoHelp: false });
    const handler = vi.fn(() => "pong");
    slash.register({ name: "ping", handler });
    const bot = makeBot();
    const ctx = makeCtx(makeMessage({
      kind: "group", groupOpenid: "g1",
      rawEventType: "GROUP_AT_MESSAGE_CREATE",
      content: "/ping", mentions: undefined,
    }), bot);

    const ok = await runMiddlewareChain([slash.middleware], ctx);
    expect(ok).toBe(false);
    expect(ctx.stopReason).toMatch(/^command:matched:ping/);
  });

  it("dispatches in group with GROUP_AT_MESSAGE_CREATE (is_you: false)", async () => {
    const slash = slashCommand({ autoHelp: false });
    const handler = vi.fn(() => "pong");
    slash.register({ name: "ping", handler });
    const bot = makeBot();
    const ctx = makeCtx(makeMessage({
      kind: "group", groupOpenid: "g1",
      rawEventType: "GROUP_AT_MESSAGE_CREATE",
      content: "/ping", mentions: [{ is_you: false }] as any,
    }), bot);

    const ok = await runMiddlewareChain([slash.middleware], ctx);
    expect(ok).toBe(false);
    expect(ctx.stopReason).toMatch(/^command:matched:ping/);
  });

  it("falls through in group with GROUP_MESSAGE_CREATE (no mentions)", async () => {
    const slash = slashCommand({ autoHelp: false });
    slash.register({ name: "ping", handler: () => "pong" });
    const tail = vi.fn(async () => {});
    const ctx = makeCtx(makeMessage({
      kind: "group", groupOpenid: "g1",
      rawEventType: "GROUP_MESSAGE_CREATE",
      content: "/ping", mentions: undefined,
    }));

    await runMiddlewareChain([slash.middleware, tail], ctx);
    expect(tail).toHaveBeenCalledOnce();
  });
});

// ============ historyBuffer ============

describe("historyBuffer", () => {
  it("records and exposes group history", async () => {
    const store = new MemoryHistoryStore();
    const mw = historyBuffer({ limit: 3, store });

    const m1 = makeMessage({
      kind: "group",
      groupOpenid: "g1",
      messageId: "1",
      content: "first",
      senderName: "alice",
    });
    const m2 = makeMessage({
      kind: "group",
      groupOpenid: "g1",
      messageId: "2",
      content: "second",
      senderName: "bob",
    });

    const ctx1 = makeCtx(m1);
    await runMiddlewareChain([mw], ctx1);
    // first message — buffer was empty
    expect(ctx1.state.history).toEqual([]);

    const ctx2 = makeCtx(m2);
    await runMiddlewareChain([mw], ctx2);
    expect(ctx2.state.history).toHaveLength(1);
    expect(ctx2.state.history?.[0]?.content).toBe("first");
  });

  it("respects limit (ring buffer)", async () => {
    const store = new MemoryHistoryStore();
    const mw = historyBuffer({ limit: 2, store });

    for (let i = 0; i < 5; i++) {
      const ctx = makeCtx(
        makeMessage({
          kind: "group",
          groupOpenid: "g1",
          messageId: `m${i}`,
          content: `msg ${i}`,
        }),
      );
      await runMiddlewareChain([mw], ctx);
    }

    const list = store.list("g1", 10);
    expect(list).toHaveLength(2);
    expect(list[1]?.messageId).toBe("m4");
  });

  it("ignores non-group messages", async () => {
    const store = new MemoryHistoryStore();
    const mw = historyBuffer({ limit: 5, store });
    const ctx = makeCtx(makeMessage({ kind: "c2c" }));

    await runMiddlewareChain([mw], ctx);
    expect(store.size()).toBe(0);
  });

  it("dedups by messageId", async () => {
    const store = new MemoryHistoryStore();
    const mw = historyBuffer({ limit: 5, store });
    const m = makeMessage({ kind: "group", groupOpenid: "g1", messageId: "dup" });

    await runMiddlewareChain([mw], makeCtx(m));
    await runMiddlewareChain([mw], makeCtx(m));
    expect(store.list("g1", 10)).toHaveLength(1);
  });
});

// ============ typingIndicator ============

describe("typingIndicator", () => {
  it("sends typing for c2c messages", async () => {
    const bot = makeBot();
    const ctx = makeCtx(makeMessage({ kind: "c2c" }), bot);
    await runMiddlewareChain([typingIndicator({ awaitTyping: true })], ctx);
    expect(bot.sendTyping).toHaveBeenCalledWith(ctx.replyTarget, 60);
  });

  it("skips typing for group messages", async () => {
    const bot = makeBot();
    const ctx = makeCtx(makeMessage({ kind: "group", groupOpenid: "g1" }), bot);
    await runMiddlewareChain([typingIndicator()], ctx);
    expect(bot.sendTyping).not.toHaveBeenCalled();
  });
});

// ============ errorHandler ============

describe("errorHandler", () => {
  it("catches downstream errors and sends reply", async () => {
    const bot = makeBot();
    const ctx = makeCtx(makeMessage(), bot);
    const failing = async () => {
      throw new Error("boom");
    };
    await runMiddlewareChain([errorHandler(), failing], ctx);
    expect(bot.sendText).toHaveBeenCalled();
    const arg = (bot.sendText as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string;
    expect(arg).toContain("boom");
  });

  it("rethrow=true bubbles error up", async () => {
    const bot = makeBot();
    const ctx = makeCtx(makeMessage(), bot);
    const failing = async () => {
      throw new Error("x");
    };
    await expect(
      runMiddlewareChain([errorHandler({ rethrow: true }), failing], ctx),
    ).rejects.toThrow("x");
  });
});
