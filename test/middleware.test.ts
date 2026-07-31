/**
 * Middleware chain unit tests.
 */

import { describe, expect, it, vi } from "vitest";
import {
  createMiddlewareContext,
  runMiddlewareChain,
  type Middleware,
  type MiddlewareContext,
} from "../src/middleware/types.js";
import type { QQBot, QQBotInboundMessage, ReplyTarget } from "../src/QQBot.js";
import type { Logger } from "../src/protocol/types.js";

// ============ Test fixtures ============

function makeStubMessage(overrides: Partial<QQBotInboundMessage> = {}): QQBotInboundMessage {
  const replyTarget: ReplyTarget = { scope: "c2c", targetId: "u1", msgId: "m1" };
  return {
    rawEventType: "C2C_MESSAGE_CREATE",
    kind: "c2c",
    senderId: "u1",
    content: "hello",
    messageId: "m1",
    timestamp: new Date().toISOString(),
    replyTarget,
    ...overrides,
  };
}

function makeStubBot(overrides: Partial<QQBot> = {}): QQBot {
  return {
    appId: "100000",
    accountId: "100000",
    sendText: vi.fn(async () => ({ id: "x", timestamp: 0 })),
    sendTyping: vi.fn(async () => ({ refIdx: undefined })),
    ...overrides,
  } as unknown as QQBot;
}

const silentLogger: Logger = {
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
};

function makeCtx(opts: { bot?: QQBot; message?: QQBotInboundMessage } = {}): MiddlewareContext {
  return createMiddlewareContext({
    bot: opts.bot ?? makeStubBot(),
    message: opts.message ?? makeStubMessage(),
    log: silentLogger,
  });
}

// ============ Tests ============

describe("middleware chain", () => {
  it("runs middlewares in order", async () => {
    const trace: string[] = [];
    const m1: Middleware = async (_ctx, next) => {
      trace.push("m1-pre");
      await next();
      trace.push("m1-post");
    };
    const m2: Middleware = async (_ctx, next) => {
      trace.push("m2-pre");
      await next();
      trace.push("m2-post");
    };

    const ok = await runMiddlewareChain([m1, m2], makeCtx());
    expect(ok).toBe(true);
    expect(trace).toEqual(["m1-pre", "m2-pre", "m2-post", "m1-post"]);
  });

  it("ctx.stop() short-circuits the chain", async () => {
    const trace: string[] = [];
    const m1: Middleware = async (ctx, next) => {
      trace.push("m1-pre");
      ctx.stop("early-out");
      await next();
      trace.push("m1-post");
    };
    const m2: Middleware = async (_ctx, next) => {
      trace.push("m2");
      await next();
    };
    const ctx = makeCtx();

    const ok = await runMiddlewareChain([m1, m2], ctx);
    expect(ok).toBe(false);
    expect(ctx.stopReason).toBe("early-out");
    expect(trace).toEqual(["m1-pre", "m1-post"]);
  });

  it("not calling next() short-circuits the chain", async () => {
    const trace: string[] = [];
    const m1: Middleware = async () => {
      trace.push("m1");
      // no await next()
    };
    const m2: Middleware = async () => {
      trace.push("m2");
    };

    const ok = await runMiddlewareChain([m1, m2], makeCtx());
    // Chain ran to completion as far as the runner is concerned (no stop()).
    expect(ok).toBe(true);
    expect(trace).toEqual(["m1"]);
  });

  it("throws when next() is called twice", async () => {
    const m: Middleware = async (_ctx, next) => {
      await next();
      await next();
    };
    await expect(runMiddlewareChain([m], makeCtx())).rejects.toThrow("next() called multiple times");
  });

  it("propagates state mutations across middleware", async () => {
    const m1: Middleware = async (ctx, next) => {
      ctx.state.foo = 1;
      await next();
    };
    const m2: Middleware = async (ctx, next) => {
      expect(ctx.state.foo).toBe(1);
      ctx.state.bar = "baz";
      await next();
    };
    const ctx = makeCtx();

    await runMiddlewareChain([m1, m2], ctx);
    expect(ctx.state).toEqual({ foo: 1, bar: "baz" });
  });

  it("propagates errors", async () => {
    const m: Middleware = async () => {
      throw new Error("boom");
    };
    await expect(runMiddlewareChain([m], makeCtx())).rejects.toThrow("boom");
  });
});
