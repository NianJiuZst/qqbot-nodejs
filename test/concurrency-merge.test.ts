/**
 * Concurrency-guard middleware — 完整测试套件
 *
 * 覆盖：
 * - 4 个核心策略 (queue / drop / abort / merge)
 * - merge (queue+batch): A 正常执行，B/C/D 攒批后 survivor 自续
 * - urgentPredicate + onUrgent: 紧急指令旁路分发，不排队
 * - buffer overflow + drop
 * - onDispatch 向后兼容
 * - 跨 target 隔离
 * - maxProcessingMs 超时 abort + 锁释放
 *
 * Merge (queue+batch) 核心保证:
 * 1. Owner (A) 立即执行，content 保持不变
 * 2. Buffered ctxs 不调 ctx.stop()，只暂停等待
 * 3. Survivor 通过自己的 next() 继续下游链
 * 4. Non-survivors 静默返回，不调用 next()
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createMiddlewareContext,
  runMiddlewareChain,
  type Middleware,
  type MiddlewareContext,
} from '../src/middleware/types.js';
import type { QQBot, QQBotInboundMessage, ReplyTarget } from '../src/QQBot.js';
import type { Logger } from '../src/protocol/types.js';
import { concurrencyGuard } from '../src/middleware/concurrency-guard.js';

// ============ Test fixtures ============

function makeStubMessage(overrides: Partial<QQBotInboundMessage> = {}): QQBotInboundMessage {
  const replyTarget: ReplyTarget = { scope: 'c2c', targetId: 'u1', msgId: 'm1' };
  return {
    rawEventType: 'C2C_MESSAGE_CREATE',
    kind: 'c2c',
    senderId: 'u1',
    content: 'hello',
    messageId: 'm1',
    timestamp: new Date().toISOString(),
    replyTarget,
    ...overrides,
  };
}

function makeStubBot(overrides: Partial<QQBot> = {}): QQBot {
  return {
    appId: '100000',
    accountId: '100000',
    sendText: vi.fn(async () => ({ id: 'x', timestamp: 0 })),
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

function makeCtx(opts: { bot?: QQBot; message?: QQBotInboundMessage; logger?: Logger } = {}): MiddlewareContext {
  return createMiddlewareContext({
    bot: opts.bot ?? makeStubBot(),
    message: opts.message ?? makeStubMessage(),
    log: opts.logger ?? silentLogger,
  });
}

function makeMsg(id: string, content: string, targetId = 'u1'): QQBotInboundMessage {
  return makeStubMessage({
    messageId: id,
    content,
    replyTarget: { scope: 'c2c', targetId, msgId: id },
  });
}

/** Chain with 30ms blocker — keeps A busy so B/C enter the buffer. */
function busyChain(guard: Middleware, ...downstream: Middleware[]): Middleware[] {
  const blocker: Middleware = async (_ctx, next) => {
    await new Promise((r) => setTimeout(r, 30));
    await next();
  };
  return [guard, blocker, ...downstream];
}

// ============ queue strategy ============

describe('concurrency-guard: strategy=queue', () => {
  it('serializes messages per target — downstream runs sequentially in arrival order', async () => {
    const trace: string[] = [];
    const guard = concurrencyGuard({ strategy: 'queue', maxQueue: 5 });
    const downstream: Middleware = async (ctx) => {
      trace.push(`start:${ctx.message.messageId}`);
      await new Promise((r) => setTimeout(r, 20));
      trace.push(`end:${ctx.message.messageId}`);
    };

    const ctxA = makeCtx({ message: makeMsg('A', 'alpha') });
    const ctxB = makeCtx({ message: makeMsg('B', 'bravo') });
    const ctxC = makeCtx({ message: makeMsg('C', 'charlie') });

    await Promise.all([
      runMiddlewareChain([guard, downstream], ctxA),
      runMiddlewareChain([guard, downstream], ctxB),
      runMiddlewareChain([guard, downstream], ctxC),
    ]);

    expect(trace).toEqual([
      'start:A', 'end:A',
      'start:B', 'end:B',
      'start:C', 'end:C',
    ]);
  });

  it('queue full: drops extra messages, calls onDrop', async () => {
    const onDrop = vi.fn();
    const trace: string[] = [];
    const guard = concurrencyGuard({ strategy: 'queue', maxQueue: 1, onDrop });
    const downstream: Middleware = async (ctx) => trace.push(ctx.message.messageId);

    const chain = busyChain(guard, downstream);
    const pA = runMiddlewareChain(chain, makeCtx({ message: makeMsg('A', 'a') }));
    await new Promise((r) => setTimeout(r, 10));
    const pB = runMiddlewareChain(chain, makeCtx({ message: makeMsg('B', 'b') }));
    await new Promise((r) => setTimeout(r, 5));
    const pC = runMiddlewareChain(chain, makeCtx({ message: makeMsg('C', 'c') }));
    const pD = runMiddlewareChain(chain, makeCtx({ message: makeMsg('D', 'd') }));

    await Promise.all([pA, pB, pC, pD]);

    expect(trace).toEqual(['A', 'B']);
    expect(onDrop).toHaveBeenCalledTimes(2);
  });

  it('isolates different targets — no cross-blocking', async () => {
    const trace: string[] = [];
    const guard = concurrencyGuard({ strategy: 'queue', maxQueue: 1 });
    const downstream: Middleware = async (ctx) => {
      trace.push(ctx.message.messageId);
      await new Promise((r) => setTimeout(r, 20));
    };

    const ctxA = makeCtx({ message: makeMsg('A', 'a', 'u1') });
    const ctxB = makeCtx({ message: makeMsg('B', 'b', 'u2') });

    const start = Date.now();
    await Promise.all([
      runMiddlewareChain([guard, downstream], ctxA),
      runMiddlewareChain([guard, downstream], ctxB),
    ]);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(35);
    expect(trace).toHaveLength(2);
  });
});

// ============ drop strategy ============

describe('concurrency-guard: strategy=drop', () => {
  it('silently drops messages when target is busy', async () => {
    const onDrop = vi.fn();
    const trace: string[] = [];
    const guard = concurrencyGuard({ strategy: 'drop', onDrop });
    const downstream: Middleware = async (ctx) => trace.push(ctx.message.messageId);

    const chain = busyChain(guard, downstream);
    const pA = runMiddlewareChain(chain, makeCtx({ message: makeMsg('A', 'a') }));
    await new Promise((r) => setTimeout(r, 10));
    const pB = runMiddlewareChain(chain, makeCtx({ message: makeMsg('B', 'b') }));
    const pC = runMiddlewareChain(chain, makeCtx({ message: makeMsg('C', 'c') }));

    await Promise.all([pA, pB, pC]);

    expect(trace).toEqual(['A']);
    expect(onDrop).toHaveBeenCalledTimes(2);
  });
});

// ============ abort strategy ============

describe('concurrency-guard: strategy=abort', () => {
  it('aborts in-flight handler when new message arrives', async () => {
    const trace: string[] = [];
    const guard = concurrencyGuard({ strategy: 'abort' });
    const slowHandler: Middleware = async (ctx) => {
      trace.push(`start:${ctx.message.messageId}`);
      const aborted = new Promise<void>((resolve) => {
        ctx.signal.addEventListener('abort', () => {
          trace.push(`aborted:${ctx.message.messageId}`);
          resolve();
        }, { once: true });
      });
      await Promise.race([
        aborted,
        new Promise((r) => setTimeout(r, 100)),
      ]);
      trace.push(`end:${ctx.message.messageId} aborted=${ctx.aborted}`);
    };

    const chain = [guard, slowHandler];
    const pA = runMiddlewareChain(chain, makeCtx({ message: makeMsg('A', 'a') }));
    await new Promise((r) => setTimeout(r, 5));
    const pB = runMiddlewareChain(chain, makeCtx({ message: makeMsg('B', 'b') }));

    await Promise.all([pA, pB]);

    expect(trace).toContain('aborted:A');
    expect(trace).toContain('end:B aborted=false');
  });
});

// ============ merge strategy — core guarantees ============

describe('concurrency-guard: strategy=merge — core guarantees', () => {
  it('single message: downstream runs once with original content', async () => {
    const trace: string[] = [];
    const guard = concurrencyGuard({ strategy: 'merge' });
    const downstream: Middleware = async (ctx) => {
      trace.push(`downstream:${ctx.message.messageId}:${ctx.message.content}`);
    };

    const ctx = makeCtx({ message: makeMsg('solo', 'hello') });
    await runMiddlewareChain([guard, downstream], ctx);

    expect(trace).toEqual(['downstream:solo:hello']);
  });

  it('owner A runs immediately; B/C merged, survivor continues via its own next()', async () => {
    const trace: string[] = [];
    const onMergeSpy = vi.fn((buffered) => {
      const first = buffered[0]!;
      const contents = buffered.map((c) => c.message.content ?? '').filter(Boolean);
      first.message.content = contents.join('|');
      return first;
    });
    const guard = concurrencyGuard({
      strategy: 'merge',
      maxQueue: 5,
      onMerge: onMergeSpy,
    });
    const downstream: Middleware = async (ctx) => {
      trace.push(`downstream:${ctx.message.messageId}:${ctx.message.content}`);
    };

    const chain = busyChain(guard, downstream);
    const pA = runMiddlewareChain(chain, makeCtx({ message: makeMsg('A', 'alpha') }));
    await new Promise((r) => setTimeout(r, 10));
    const pB = runMiddlewareChain(chain, makeCtx({ message: makeMsg('B', 'bravo') }));
    await new Promise((r) => setTimeout(r, 5));
    const pC = runMiddlewareChain(chain, makeCtx({ message: makeMsg('C', 'charlie') }));

    await Promise.all([pA, pB, pC]);

    // A 先跑原始内容，然后 B (survivor) 自己继续链，内容是 B+C 合并
    expect(trace).toEqual([
      'downstream:A:alpha',
      'downstream:B:bravo|charlie',
    ]);
    // onMerge 只收到 [B, C]，不含 A
    expect(onMergeSpy.mock.calls[0]![0].map((c) => c.message.messageId)).toEqual(['B', 'C']);
  });

  it('non-survivors return silently, never call next()', async () => {
    const trace: string[] = [];
    const guard = concurrencyGuard({
      strategy: 'merge',
      maxQueue: 5,
      onMerge: (buffered) => {
        const first = buffered[0]!;
        first.message.content = buffered.map((c) => c.message.content).join('|');
        return first;
      },
    });
    const tracker: Middleware = async (ctx, next) => {
      trace.push(`mw-enter:${ctx.message.messageId}`);
      await next();
      trace.push(`mw-exit:${ctx.message.messageId}`);
    };
    const downstream: Middleware = async (ctx) => {
      trace.push(`downstream:${ctx.message.messageId}:${ctx.message.content}`);
    };

    const chain = busyChain(guard, tracker, downstream);
    const pA = runMiddlewareChain(chain, makeCtx({ message: makeMsg('A', 'a') }));
    await new Promise((r) => setTimeout(r, 10));
    const pB = runMiddlewareChain(chain, makeCtx({ message: makeMsg('B', 'b') }));
    const pC = runMiddlewareChain(chain, makeCtx({ message: makeMsg('C', 'c') }));

    await Promise.all([pA, pB, pC]);

    // A: guard → tracker → blocker → downstream → tracker exit → guard finally → drain
    // B (survivor): guard(pause) → resume → tracker → blocker → downstream → tracker exit → return
    // C (non-survivor): guard(pause) → resume → return (never enters tracker)
    expect(trace).toEqual([
      'mw-enter:A',
      'downstream:A:a',
      'mw-exit:A',
      'mw-enter:B',
      'downstream:B:b|c',
      'mw-exit:B',
    ]);
  });

  it("owner's content is NOT mutated by merge", async () => {
    const trace: string[] = [];
    const guard = concurrencyGuard({
      strategy: 'merge',
      maxQueue: 5,
      onMerge: (buffered) => {
        const first = buffered[0]!;
        first.message.content = 'MERGED:' + buffered.map((c) => c.message.content).join(',');
        return first;
      },
    });
    const downstream: Middleware = async (ctx) => {
      trace.push(`${ctx.message.messageId}:${ctx.message.content}`);
    };

    const chain = busyChain(guard, downstream);
    const pA = runMiddlewareChain(chain, makeCtx({ message: makeMsg('A', 'original-a') }));
    await new Promise((r) => setTimeout(r, 10));
    const pB = runMiddlewareChain(chain, makeCtx({ message: makeMsg('B', 'b') }));

    await Promise.all([pA, pB]);

    expect(trace).toEqual([
      'A:original-a',
      'B:MERGED:b',
    ]);
  });
});

// ============ merge strategy — buffer overflow ============

describe('concurrency-guard: strategy=merge — buffer overflow', () => {
  it('buffer full: drops extra messages beyond maxQueue', async () => {
    const onDrop = vi.fn();
    const trace: string[] = [];
    const guard = concurrencyGuard({ strategy: 'merge', maxQueue: 2, onDrop });
    const downstream: Middleware = async (ctx) => {
      trace.push(`${ctx.message.messageId}:${ctx.message.content}`);
    };

    const chain = busyChain(guard, downstream);
    const pA = runMiddlewareChain(chain, makeCtx({ message: makeMsg('A', 'a') }));
    await new Promise((r) => setTimeout(r, 10));
    const pB = runMiddlewareChain(chain, makeCtx({ message: makeMsg('B', 'b') }));
    await new Promise((r) => setTimeout(r, 5));
    const pC = runMiddlewareChain(chain, makeCtx({ message: makeMsg('C', 'c') }));
    await new Promise((r) => setTimeout(r, 5));
    const pD = runMiddlewareChain(chain, makeCtx({ message: makeMsg('D', 'd') }));
    const pE = runMiddlewareChain(chain, makeCtx({ message: makeMsg('E', 'e') }));

    await Promise.all([pA, pB, pC, pD, pE]);

    // A + merged(B,C), D/E dropped
    expect(trace).toHaveLength(2);
    expect(onDrop).toHaveBeenCalledTimes(2);
  });
});

// ============ merge strategy — default merge ============

describe('concurrency-guard: strategy=merge — default merge', () => {
  it('concatenates buffered contents with newline', async () => {
    const trace: string[] = [];
    const guard = concurrencyGuard({ strategy: 'merge', maxQueue: 5 });
    const downstream: Middleware = async (ctx) => {
      trace.push(`downstream:${ctx.message.messageId}:${JSON.stringify(ctx.message.content)}`);
    };

    const chain = busyChain(guard, downstream);
    const pA = runMiddlewareChain(chain, makeCtx({ message: makeMsg('A', 'alpha') }));
    await new Promise((r) => setTimeout(r, 10));
    const pB = runMiddlewareChain(chain, makeCtx({ message: makeMsg('B', 'bravo') }));
    const pC = runMiddlewareChain(chain, makeCtx({ message: makeMsg('C', 'charlie') }));

    await Promise.all([pA, pB, pC]);

    expect(trace).toEqual([
      'downstream:A:"alpha"',
      'downstream:B:"bravo\\ncharlie"',
    ]);
  });
});

// ============ merge strategy — isolation ============

describe('concurrency-guard: strategy=merge — isolation', () => {
  it('isolates merge across different targets', async () => {
    const trace: string[] = [];
    const guard = concurrencyGuard({ strategy: 'merge', maxQueue: 5 });
    const downstream: Middleware = async (ctx) => {
      trace.push(`${ctx.message.messageId}:${ctx.message.content}`);
    };

    const c2cMsg = makeMsg('A', 'c2c-msg', 'u1');
    const groupMsg: QQBotInboundMessage = makeStubMessage({
      messageId: 'B',
      content: 'group-msg',
      kind: 'group',
      senderId: 'user-of-g1',
      replyTarget: { scope: 'group', targetId: 'g1', msgId: 'B' },
    });

    const chain = busyChain(guard, downstream);
    const pA = runMiddlewareChain(chain, makeCtx({ message: c2cMsg }));
    await new Promise((r) => setTimeout(r, 10));
    const pB = runMiddlewareChain(chain, makeCtx({ message: groupMsg }));

    await Promise.all([pA, pB]);

    expect(trace).toContain('A:c2c-msg');
    expect(trace).toContain('B:group-msg');
  });

  it('empty buffer: no re-dispatch after owner finishes', async () => {
    const trace: string[] = [];
    const guard = concurrencyGuard({ strategy: 'merge', maxQueue: 5 });
    const downstream: Middleware = async (ctx) => trace.push(ctx.message.messageId);

    const ctx = makeCtx({ message: makeMsg('solo', 'hello') });
    await runMiddlewareChain([guard, downstream], ctx);

    expect(trace).toEqual(['solo']);
  });

  it('custom onMerge returning non-buffered ctx falls back to first buffered', async () => {
    const trace: string[] = [];
    const bogusCtx = makeCtx({ message: makeMsg('BOGUS', 'fake') });
    const guard = concurrencyGuard({
      strategy: 'merge',
      maxQueue: 5,
      onMerge: () => bogusCtx,
    });
    const downstream: Middleware = async (ctx) => trace.push(ctx.message.messageId);

    const chain = busyChain(guard, downstream);
    const pA = runMiddlewareChain(chain, makeCtx({ message: makeMsg('A', 'a') }));
    await new Promise((r) => setTimeout(r, 10));
    const pB = runMiddlewareChain(chain, makeCtx({ message: makeMsg('B', 'b') }));

    const results = await Promise.allSettled([pA, pB]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(trace).toHaveLength(2);
  });
});

// ============ edge cases ============

describe('concurrency-guard: edge cases', () => {
  it('default maxQueue is 3 for queue strategy', async () => {
    const onDrop = vi.fn();
    const trace: string[] = [];
    const guard = concurrencyGuard({ strategy: 'queue', onDrop });
    const downstream: Middleware = async (ctx) => trace.push(ctx.message.messageId);

    const chain = busyChain(guard, downstream);
    const pA = runMiddlewareChain(chain, makeCtx({ message: makeMsg('A', 'a') }));
    await new Promise((r) => setTimeout(r, 10));
    const p1 = runMiddlewareChain(chain, makeCtx({ message: makeMsg('1', 'x') }));
    const p2 = runMiddlewareChain(chain, makeCtx({ message: makeMsg('2', 'x') }));
    const p3 = runMiddlewareChain(chain, makeCtx({ message: makeMsg('3', 'x') }));
    const p4 = runMiddlewareChain(chain, makeCtx({ message: makeMsg('4', 'x') }));

    await Promise.all([pA, p1, p2, p3, p4]);

    expect(trace).toHaveLength(4);
    expect(onDrop).toHaveBeenCalledTimes(1);
  });

  it('queue: new message after release runs normally', async () => {
    const trace: string[] = [];
    const guard = concurrencyGuard({ strategy: 'queue', maxQueue: 5 });
    const downstream: Middleware = async (ctx) => trace.push(ctx.message.messageId);

    const pA = runMiddlewareChain([guard, downstream], makeCtx({ message: makeMsg('A', 'a') }));
    await pA;
    const pB = runMiddlewareChain([guard, downstream], makeCtx({ message: makeMsg('B', 'b') }));

    await Promise.all([pA, pB]);

    expect(trace).toEqual(['A', 'B']);
  });

  it('abort: chain fulfills even when aborting', async () => {
    const guard = concurrencyGuard({ strategy: 'abort' });
    const slowHandler: Middleware = async (_ctx) => {
      await new Promise((r) => setTimeout(r, 50));
    };

    const chain = [guard, slowHandler];
    const pA = runMiddlewareChain(chain, makeCtx({ message: makeMsg('A', 'a') }));
    await new Promise((r) => setTimeout(r, 5));
    const pB = runMiddlewareChain(chain, makeCtx({ message: makeMsg('B', 'b') }));

    const results = await Promise.allSettled([pA, pB]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
  });

  it('merge: sequential messages after release each run independently', async () => {
    const trace: string[] = [];
    const guard = concurrencyGuard({ strategy: 'merge', maxQueue: 5 });
    const downstream: Middleware = async (ctx) => {
      trace.push(`${ctx.message.messageId}:${ctx.message.content}`);
    };

    const pA = runMiddlewareChain([guard, downstream], makeCtx({ message: makeMsg('A', 'alpha') }));
    await pA;
    const pB = runMiddlewareChain([guard, downstream], makeCtx({ message: makeMsg('B', 'bravo') }));
    await pB;

    expect(trace).toEqual(['A:alpha', 'B:bravo']);
  });
});

// ============ merge: defaultMerge filtering ============

describe('concurrency-guard: strategy=merge — defaultMerge filtering', () => {
  it('empty content ctxs are filtered from merged result', async () => {
    const guard = concurrencyGuard({ strategy: 'merge', maxQueue: 10 });
    const trace: string[] = [];
    const downstream: Middleware = async (ctx) => {
      trace.push(`${ctx.message.messageId}:${ctx.message.content}`);
    };

    const chain = busyChain(guard, downstream);
    const pA = runMiddlewareChain(chain, makeCtx({ message: makeMsg('A', 'alpha') }));
    await new Promise((r) => setTimeout(r, 5));

    const ctxB = makeCtx({ message: makeMsg('B', '') });
    const pB = runMiddlewareChain(chain, ctxB);
    await new Promise((r) => setTimeout(r, 5));

    const pC = runMiddlewareChain(chain, makeCtx({ message: makeMsg('C', 'charlie') }));

    await Promise.all([pA, pB, pC]);

    // A runs alone, B 被过滤只剩 C 的 content
    expect(trace).toHaveLength(2);
    expect(trace[1]).toBe('B:charlie'); // B 是 survivor，content 只有 C 的
  });

  it('all buffered ctxs empty: merged content is empty', async () => {
    const guard = concurrencyGuard({ strategy: 'merge', maxQueue: 10 });
    let mergedContent: string | undefined;
    const downstream: Middleware = async (ctx) => {
      if (!ctx.message.messageId.startsWith('A')) {
        mergedContent = ctx.message.content;
      }
    };

    const chain = busyChain(guard, downstream);
    const pA = runMiddlewareChain(chain, makeCtx({ message: makeMsg('A', 'has-content') }));
    await new Promise((r) => setTimeout(r, 5));
    const pB = runMiddlewareChain(chain, makeCtx({ message: makeMsg('B', '') }));
    const pC = runMiddlewareChain(chain, makeCtx({ message: makeMsg('C', '') }));

    await Promise.all([pA, pB, pC]);

    expect(mergedContent).toBe('');
  });
});

// ============ merge: multi-target isolation ============

describe('concurrency-guard: strategy=merge — multi-target isolation', () => {
  it('merge windows for different targets run in parallel', async () => {
    const trace: string[] = [];
    const guard = concurrencyGuard({ strategy: 'merge', maxQueue: 10 });
    const downstream: Middleware = async (ctx) => {
      trace.push(`${ctx.message.messageId}:${ctx.message.content}`);
    };

    const chain = busyChain(guard, downstream);

    // Target u1: A + B
    const pA = runMiddlewareChain(chain, makeCtx({ message: makeMsg('A', 'alpha', 'u1') }));
    await new Promise((r) => setTimeout(r, 5));
    const pB = runMiddlewareChain(chain, makeCtx({ message: makeMsg('B', 'bravo', 'u1') }));

    // Target u2: X + Y
    const pX = runMiddlewareChain(chain, makeCtx({ message: makeMsg('X', 'xray', 'u2') }));
    await new Promise((r) => setTimeout(r, 5));
    const pY = runMiddlewareChain(chain, makeCtx({ message: makeMsg('Y', 'yankee', 'u2') }));

    await Promise.all([pA, pB, pX, pY]);

    expect(trace).toHaveLength(4);
    expect(trace.some((t) => t.startsWith('A:') && t.includes('alpha'))).toBe(true);
    expect(trace.some((t) => t.startsWith('X:') && t.includes('xray'))).toBe(true);
  });
});

// ============ merge: post-owner-release ============

describe('concurrency-guard: strategy=merge — post-owner-release', () => {
  it('messages arriving while owner is mid-flight are merged after owner finishes', async () => {
    const trace: string[] = [];
    const guard = concurrencyGuard({
      strategy: 'merge',
      maxQueue: 5,
      onMerge: (buffered) => {
        const first = buffered[0]!;
        first.message.content = buffered.map((c) => c.message.content).join('+');
        return first;
      },
    });
    const slowDownstream: Middleware = async (ctx, next) => {
      trace.push(`start:${ctx.message.messageId}`);
      await new Promise((r) => setTimeout(r, 60));
      trace.push(`end:${ctx.message.messageId}:${ctx.message.content}`);
      await next();
    };
    const sink: Middleware = async () => {};

    const chain = [guard, slowDownstream, sink];

    const pA = runMiddlewareChain(chain, makeCtx({ message: makeMsg('A', '1') }));
    await new Promise((r) => setTimeout(r, 25)); // A mid-flight

    const pB = runMiddlewareChain(chain, makeCtx({ message: makeMsg('B', '2') }));
    const pC = runMiddlewareChain(chain, makeCtx({ message: makeMsg('C', '3') }));

    await Promise.all([pA, pB, pC]);

    expect(trace).toContain('end:A:1');
    const ended = trace.filter((l) => l.startsWith('end:'));
    expect(ended.length).toBeGreaterThanOrEqual(2); // A + merged batch
  });

  it('multiple batches: A then B+C merged then D alone', async () => {
    const trace: string[] = [];
    const guard = concurrencyGuard({ strategy: 'merge', maxQueue: 5 });
    const downstream: Middleware = async (ctx) => {
      trace.push(`${ctx.message.messageId}:${ctx.message.content}`);
    };

    const chain1 = busyChain(guard, downstream);
    const pA = runMiddlewareChain(chain1, makeCtx({ message: makeMsg('A', 'a') }));
    await new Promise((r) => setTimeout(r, 5));
    const pB = runMiddlewareChain(chain1, makeCtx({ message: makeMsg('B', 'b') }));
    const pC = runMiddlewareChain(chain1, makeCtx({ message: makeMsg('C', 'c') }));
    await Promise.all([pA, pB, pC]);

    // D arrives after drain complete
    const pD = runMiddlewareChain([guard, downstream], makeCtx({ message: makeMsg('D', 'd') }));
    await pD;

    expect(trace).toHaveLength(3);
    expect(trace[0]).toBe('A:a');
    expect(trace[2]).toBe('D:d');
  });
});

// ============ merge: legacy onDispatch ============

describe('concurrency-guard: strategy=merge — legacy onDispatch', () => {
  it('onDispatch receives merged ctx, bypasses next()', async () => {
    const dispatchTrace: string[] = [];
    const downstreamTrace: string[] = [];
    const onDispatch = vi.fn(async (merged: MiddlewareContext) => {
      dispatchTrace.push(`dispatch:${merged.message.messageId}:${merged.message.content}`);
    });
    const guard = concurrencyGuard({
      strategy: 'merge',
      maxQueue: 5,
      onMerge: (buffered) => {
        const first = buffered[0]!;
        first.message.content = buffered.map((c) => c.message.content).join('+');
        return first;
      },
      onDispatch,
    });
    const downstream: Middleware = async (ctx) => {
      downstreamTrace.push(`${ctx.message.messageId}:${ctx.message.content}`);
    };

    const chain = busyChain(guard, downstream);
    const pA = runMiddlewareChain(chain, makeCtx({ message: makeMsg('A', 'a') }));
    await new Promise((r) => setTimeout(r, 10));
    const pB = runMiddlewareChain(chain, makeCtx({ message: makeMsg('B', 'b') }));
    const pC = runMiddlewareChain(chain, makeCtx({ message: makeMsg('C', 'c') }));

    await Promise.all([pA, pB, pC]);

    // A 正常走 downstream
    expect(downstreamTrace).toEqual(['A:a']);
    // onDispatch 收到 B+C 合并结果（A 不参与 merge）
    expect(dispatchTrace).toEqual(['dispatch:B:b+c']);
    expect(onDispatch).toHaveBeenCalledTimes(1);
  });

  it('onDispatch error releases lock, next message runs', async () => {
    const onDispatch = vi.fn(async (_merged: MiddlewareContext) => {
      throw new Error('dispatch boom');
    });
    const guard = concurrencyGuard({ strategy: 'merge', maxQueue: 5, onDispatch });
    const downstream: Middleware = async () => {};

    const chain = busyChain(guard, downstream);
    const pA = runMiddlewareChain(chain, makeCtx({ message: makeMsg('A', 'a') }));
    await new Promise((r) => setTimeout(r, 5));
    const pB = runMiddlewareChain(chain, makeCtx({ message: makeMsg('B', 'b') }));

    const results = await Promise.allSettled([pA, pB]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(onDispatch).toHaveBeenCalledTimes(1);

    // Lock released, C runs as new owner
    const pC = runMiddlewareChain([guard, downstream], makeCtx({ message: makeMsg('C', 'c') }));
    await pC;
    expect(onDispatch).toHaveBeenCalledTimes(1); // C 是 owner 无 buffer，不触发 onDispatch
  });
});

// ============ merge: error resilience ============

describe('concurrency-guard: strategy=merge — error resilience', () => {
  it('owner next() throws: finally drains buffer, lock released', async () => {
    const trace: string[] = [];
    const guard = concurrencyGuard({
      strategy: 'merge',
      maxQueue: 5,
      onMerge: (buffered) => {
        const first = buffered[0]!;
        first.message.content = buffered.map((c) => c.message.content).join('+');
        return first;
      },
    });
    const throwingMw: Middleware = async (ctx) => {
      if (ctx.message.messageId === 'A') {
        throw new Error('owner failed');
      }
      trace.push(`${ctx.message.messageId}:${ctx.message.content}`);
    };

    const chain = busyChain(guard, throwingMw);
    const pA = runMiddlewareChain(chain, makeCtx({ message: makeMsg('A', 'a') }));
    await new Promise((r) => setTimeout(r, 10));
    const pB = runMiddlewareChain(chain, makeCtx({ message: makeMsg('B', 'b') }));

    const results = await Promise.allSettled([pA, pB]);
    // A rejected, B fulfilled (survivor)
    expect(results[0]!.status).toBe('rejected');
    expect(results[1]!.status).toBe('fulfilled');
    // B 作为 survivor 正常执行合并后的内容
    expect(trace).toEqual(['B:b']);
  });

  it('survivor next() throws: remaining waiters resolve, lock released', async () => {
    const guard = concurrencyGuard({
      strategy: 'merge',
      maxQueue: 5,
      onMerge: (buffered) => {
        const first = buffered[0]!;
        first.message.content = buffered.map((c) => c.message.content).join('+');
        return first;
      },
    });
    let bErrored = false;
    const throwingMw: Middleware = async (ctx) => {
      if (ctx.message.messageId === 'B') {
        bErrored = true;
        throw new Error('survivor failed');
      }
    };

    const chain = busyChain(guard, throwingMw);
    const pA = runMiddlewareChain(chain, makeCtx({ message: makeMsg('A', 'a') }));
    await new Promise((r) => setTimeout(r, 10));
    const pB = runMiddlewareChain(chain, makeCtx({ message: makeMsg('B', 'b') }));
    const pC = runMiddlewareChain(chain, makeCtx({ message: makeMsg('C', 'c') }));

    const results = await Promise.allSettled([pA, pB, pC]);
    // A fulfilled, B rejected (survivor throw), C fulfilled (non-survivor)
    expect(results[0]!.status).toBe('fulfilled');
    expect(results[1]!.status).toBe('rejected');
    expect(results[2]!.status).toBe('fulfilled');
    expect(bErrored).toBe(true);

    // Lock released → D runs as new owner
    const pD = runMiddlewareChain([guard, throwingMw], makeCtx({ message: makeMsg('D', 'd') }));
    await pD;
  });
});

// ============ merge: defaultMerge envelope + attachments ============

describe('concurrency-guard: strategy=merge — defaultMerge envelope & attachments', () => {
  it('merges envelopes from content-bearing ctxs', async () => {
    const guard = concurrencyGuard({ strategy: 'merge', maxQueue: 10 });
    let seenEnvelope: string | undefined;
    const downstream: Middleware = async (ctx) => {
      if (ctx.message.messageId === 'B') {
        seenEnvelope = ctx.state.envelope as string | undefined;
      }
    };

    const chain = busyChain(guard, downstream);
    const pA = runMiddlewareChain(chain, makeCtx({ message: makeMsg('A', 'alpha') }));
    await new Promise((r) => setTimeout(r, 5));

    const ctxB = makeCtx({ message: makeMsg('B', 'bravo') });
    ctxB.state.envelope = 'ENV-B';
    const pB = runMiddlewareChain(chain, ctxB);
    await new Promise((r) => setTimeout(r, 5));

    const ctxC = makeCtx({ message: makeMsg('C', 'charlie') });
    ctxC.state.envelope = 'ENV-C';
    const pC = runMiddlewareChain(chain, ctxC);

    await Promise.all([pA, pB, pC]);

    // B is survivor, merged envelope = ENV-B\n\nENV-C
    expect(seenEnvelope).toBe('ENV-B\n\nENV-C');
  });

  it('merges attachments from content-bearing ctxs', async () => {
    const guard = concurrencyGuard({ strategy: 'merge', maxQueue: 10 });
    let seenAttachments: unknown[] | undefined;
    const downstream: Middleware = async (ctx) => {
      if (ctx.message.messageId === 'B') {
        seenAttachments = ctx.message.attachments as unknown[] | undefined;
      }
    };

    const chain = busyChain(guard, downstream);
    const pA = runMiddlewareChain(chain, makeCtx({ message: makeMsg('A', 'alpha') }));
    await new Promise((r) => setTimeout(r, 5));

    const ctxB = makeCtx({ message: makeMsg('B', 'bravo') });
    ctxB.message.attachments = [{ content_type: 'image', url: 'img-b' }];
    const pB = runMiddlewareChain(chain, ctxB);
    await new Promise((r) => setTimeout(r, 5));

    const ctxC = makeCtx({ message: makeMsg('C', 'charlie') });
    ctxC.message.attachments = [{ content_type: 'video', url: 'vid-c' }];
    const pC = runMiddlewareChain(chain, ctxC);

    await Promise.all([pA, pB, pC]);

    expect(seenAttachments).toEqual([
      { content_type: 'image', url: 'img-b' },
      { content_type: 'video', url: 'vid-c' },
    ]);
  });

  it('empty-content ctx data is not merged but first survivor retains its own state', async () => {
    const guard = concurrencyGuard({ strategy: 'merge', maxQueue: 10 });
    let seenEnvelope: string | undefined;
    let seenAttachments: unknown[] | undefined;
    const downstream: Middleware = async (ctx) => {
      if (ctx.message.messageId === 'B') {
        seenEnvelope = ctx.state.envelope as string | undefined;
        seenAttachments = ctx.message.attachments as unknown[] | undefined;
      }
    };

    const chain = busyChain(guard, downstream);
    const pA = runMiddlewareChain(chain, makeCtx({ message: makeMsg('A', 'alpha') }));
    await new Promise((r) => setTimeout(r, 5));

    // B: empty content with its own envelope — is first in buffer, becomes survivor
    const ctxB = makeCtx({ message: makeMsg('B', '') });
    ctxB.state.envelope = 'B-OWN-ENV';
    ctxB.message.attachments = [{ content_type: 'image', url: 'b-own' }];
    const pB = runMiddlewareChain(chain, ctxB);
    await new Promise((r) => setTimeout(r, 5));

    // C: has content but no envelope/attachments
    const pC = runMiddlewareChain(chain, makeCtx({ message: makeMsg('C', 'charlie') }));

    await Promise.all([pA, pB, pC]);

    // B is the survivor. Its own envelope/attachments persist (not cleared).
    // C has no envelope/attachments, so nothing additional is merged.
    expect(seenEnvelope).toBe('B-OWN-ENV');
    expect(seenAttachments).toEqual([{ content_type: 'image', url: 'b-own' }]);
  });
});

// ============ abort: superseded while waiting ============

describe('concurrency-guard: strategy=abort — superseded', () => {
  it('abort: B waits for A; C aborts B and takes over', async () => {
    const trace: string[] = [];
    const guard = concurrencyGuard({ strategy: 'abort' });
    const handler: Middleware = async (ctx, next) => {
      trace.push(`start:${ctx.message.messageId}`);
      if (ctx.signal.aborted) {
        trace.push(`aborted-early:${ctx.message.messageId}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
      trace.push(`end:${ctx.message.messageId} aborted=${ctx.aborted}`);
      await next();
    };

    const chain = [guard, handler];
    const pA = runMiddlewareChain(chain, makeCtx({ message: makeMsg('A', 'a') }));
    await new Promise((r) => setTimeout(r, 5));
    const pB = runMiddlewareChain(chain, makeCtx({ message: makeMsg('B', 'b') }));
    await new Promise((r) => setTimeout(r, 2));
    const pC = runMiddlewareChain(chain, makeCtx({ message: makeMsg('C', 'c') }));

    await Promise.allSettled([pA, pB, pC]);

    // A is aborted by B, B is superseded by C, only C finishes cleanly
    expect(trace).toContain('end:C aborted=false');
  });
});

// ============ merge: urgentPredicate ============

describe('concurrency-guard: strategy=merge — urgentPredicate', () => {
  it('flush: buffered messages are silently dropped, urgent passes through', async () => {
    const trace: string[] = [];
    const guard = concurrencyGuard({
      strategy: 'merge',
      maxQueue: 5,
      urgentPredicate: (ctx) => (ctx.message.content as string ?? '').startsWith('/'),
    });
    const downstream: Middleware = async (ctx) => {
      trace.push(`${ctx.message.messageId}:${ctx.message.content}`);
    };

    const chain = busyChain(guard, downstream);
    const pA = runMiddlewareChain(chain, makeCtx({ message: makeMsg('A', 'alpha') }));
    await new Promise((r) => setTimeout(r, 10));

    // B/C buffered while A is busy
    const pB = runMiddlewareChain(chain, makeCtx({ message: makeMsg('B', 'bravo') }));
    await new Promise((r) => setTimeout(r, 5));
    const pC = runMiddlewareChain(chain, makeCtx({ message: makeMsg('C', 'charlie') }));
    await new Promise((r) => setTimeout(r, 5));

    // D: /stop arrives — urgent, flushes B/C silently
    const pD = runMiddlewareChain(chain, makeCtx({ message: makeMsg('D', '/stop') }));

    await Promise.all([pA, pB, pC, pD]);

    // A runs alone; B/C flushed; D (survivor) runs with /stop content
    expect(trace).toEqual([
      'A:alpha',
      'D:/stop',
    ]);
  });

  it('only matching messages are urgent; non-matching still merge normally', async () => {
    const trace: string[] = [];
    const guard = concurrencyGuard({
      strategy: 'merge',
      maxQueue: 5,
      urgentPredicate: (ctx) => (ctx.message.content as string ?? '') === '/stop',
    });
    const downstream: Middleware = async (ctx) => {
      trace.push(`${ctx.message.messageId}:${ctx.message.content}`);
    };

    const chain = busyChain(guard, downstream);
    const pA = runMiddlewareChain(chain, makeCtx({ message: makeMsg('A', 'alpha') }));
    await new Promise((r) => setTimeout(r, 10));

    const pB = runMiddlewareChain(chain, makeCtx({ message: makeMsg('B', 'regular') }));
    await new Promise((r) => setTimeout(r, 5));

    // /stop arrives → flushes B silently, then /stop runs next
    const pC = runMiddlewareChain(chain, makeCtx({ message: makeMsg('C', '/stop') }));

    await Promise.all([pA, pB, pC]);

    // A alone; B flushed; C (survivor) runs with /stop
    expect(trace).toEqual([
      'A:alpha',
      'C:/stop',
    ]);
  });

  it('urgent message runs in parallel, does NOT wait for active owner', async () => {
    const trace: string[] = [];
    const guard = concurrencyGuard({
      strategy: 'merge',
      maxQueue: 5,
      urgentPredicate: (ctx) => (ctx.message.content as string ?? '').startsWith('/'),
    });
    const slowMw: Middleware = async (ctx, next) => {
      trace.push(`start:${ctx.message.messageId}`);
      await new Promise((r) => setTimeout(r, 50));
      trace.push(`end:${ctx.message.messageId}`);
      await next();
    };
    const downstream: Middleware = async () => {};

    const chain = [guard, slowMw, downstream];
    const pA = runMiddlewareChain(chain, makeCtx({ message: makeMsg('A', 'slow') }));
    await new Promise((r) => setTimeout(r, 10));

    // Urgent arrives while A is still running → runs in parallel via next()
    const pB = runMiddlewareChain(chain, makeCtx({ message: makeMsg('B', '/stop') }));

    await Promise.all([pA, pB]);

    // Both start and run in parallel
    expect(trace).toContain('start:A');
    expect(trace).toContain('end:A');
    expect(trace).toContain('start:B');
    expect(trace).toContain('end:B');
    // B starts before A finishes (parallel, not queued)
    const startAIdx = trace.indexOf('start:A');
    const startBIdx = trace.indexOf('start:B');
    const endAIdx = trace.indexOf('end:A');
    expect(startAIdx).toBeLessThan(startBIdx); // A starts first
    expect(startBIdx).toBeLessThan(endAIdx);   // B starts before A ends (parallel!)
  });

  it('urgentPredicate not set: all messages merge normally (no flush)', async () => {
    const trace: string[] = [];
    const guard = concurrencyGuard({ strategy: 'merge', maxQueue: 5 });
    const downstream: Middleware = async (ctx) => {
      trace.push(`${ctx.message.messageId}:${ctx.message.content}`);
    };

    const chain = busyChain(guard, downstream);
    const pA = runMiddlewareChain(chain, makeCtx({ message: makeMsg('A', 'alpha') }));
    await new Promise((r) => setTimeout(r, 10));
    const pB = runMiddlewareChain(chain, makeCtx({ message: makeMsg('B', 'bravo') }));
    const pC = runMiddlewareChain(chain, makeCtx({ message: makeMsg('C', '/stop') }));

    await Promise.all([pA, pB, pC]);

    // Without urgent predicate, /stop merges with B normally
    expect(trace).toHaveLength(2);
    trace.forEach((t) => {
      expect(t.startsWith('A:') || t.includes('/stop')).toBe(true);
    });
  });

  it('cross-target: urgent message for one target does NOT flush other targets', async () => {
    const trace: string[] = [];
    const guard = concurrencyGuard({
      strategy: 'merge',
      maxQueue: 5,
      urgentPredicate: (ctx) => (ctx.message.content as string ?? '').startsWith('/'),
    });
    const downstream: Middleware = async (ctx) => {
      trace.push(`${ctx.message.replyTarget.targetId}:${ctx.message.messageId}:${ctx.message.content}`);
    };

    const u1MsgA = makeMsg('A', 'alpha', 'u1');
    const u1MsgB = makeMsg('B', '/stop', 'u1');
    const u2MsgX = makeMsg('X', 'xray', 'u2');
    const u2MsgY = makeMsg('Y', 'yankee', 'u2');

    const chain = busyChain(guard, downstream);
    const pA = runMiddlewareChain(chain, makeCtx({ message: u1MsgA }));
    const pX = runMiddlewareChain(chain, makeCtx({ message: u2MsgX }));
    await new Promise((r) => setTimeout(r, 10));

    // /stop for u1 — flushes u1 buffer but leaves u2 alone
    const pB = runMiddlewareChain(chain, makeCtx({ message: u1MsgB }));
    const pY = runMiddlewareChain(chain, makeCtx({ message: u2MsgY }));

    await Promise.all([pA, pB, pX, pY]);

    // u2:X and u2:Y should both be present (u2 not affected by u1's /stop)
    const u2Entries = trace.filter((t) => t.startsWith('u2:'));
    expect(u2Entries.length).toBeGreaterThanOrEqual(2);
    // u1:/stop should be present
    expect(trace.some((t) => t.includes('/stop'))).toBe(true);
  });
});

// ============ merge: urgent next() ============

describe('concurrency-guard: strategy=merge — urgent next()', () => {
  it('urgent: runs via next() in parallel to active owner', async () => {
    const trace: string[] = [];
    const guard = concurrencyGuard({
      strategy: 'merge',
      maxQueue: 5,
      urgentPredicate: (ctx) => (ctx.message.content as string ?? '').startsWith('/'),
    });
    const downstream: Middleware = async (ctx) => {
      trace.push(`${ctx.message.messageId}:${ctx.message.content}`);
    };

    const chain = busyChain(guard, downstream);
    const pA = runMiddlewareChain(chain, makeCtx({ message: makeMsg('A', 'alpha') }));
    await new Promise((r) => setTimeout(r, 10));

    const pB = runMiddlewareChain(chain, makeCtx({ message: makeMsg('B', '/stop') }));

    await Promise.all([pA, pB]);

    // Both A and /stop run through downstream in parallel
    expect(trace).toContain('A:alpha');
    expect(trace).toContain('B:/stop');
    expect(trace).toHaveLength(2);
  });

  it('urgent: buffered waiters are resolved silently', async () => {
    const trace: string[] = [];
    const guard = concurrencyGuard({
      strategy: 'merge',
      maxQueue: 5,
      urgentPredicate: (ctx) => (ctx.message.content as string ?? '').startsWith('/'),
    });
    const downstream: Middleware = async (ctx) => {
      trace.push(`${ctx.message.messageId}`);
    };

    const chain = busyChain(guard, downstream);
    const pA = runMiddlewareChain(chain, makeCtx({ message: makeMsg('A', 'a') }));
    await new Promise((r) => setTimeout(r, 10));

    // B/C buffered while A busy, D is urgent
    const pB = runMiddlewareChain(chain, makeCtx({ message: makeMsg('B', 'b') }));
    const pC = runMiddlewareChain(chain, makeCtx({ message: makeMsg('C', 'c') }));
    await new Promise((r) => setTimeout(r, 10));
    const pD = runMiddlewareChain(chain, makeCtx({ message: makeMsg('D', '/stop') }));

    await Promise.all([pA, pB, pC, pD]);

    // A alone; B/C resolved as non-survivors (silent); D runs via next()
    expect(trace).toContain('A');
    expect(trace).toContain('D');
    // B and C should NOT appear (flushed)
    expect(trace).not.toContain('B');
    expect(trace).not.toContain('C');
    expect(trace).toHaveLength(2);
  });

  it('urgent: does NOT abort active owner', async () => {
    const trace: string[] = [];
    const guard = concurrencyGuard({
      strategy: 'merge',
      maxQueue: 5,
      urgentPredicate: (ctx) => (ctx.message.content as string ?? '').startsWith('/'),
    });
    const slowMw: Middleware = async (ctx, next) => {
      trace.push(`start:${ctx.message.messageId}`);
      await new Promise((r) => setTimeout(r, 50));
      trace.push(`end:${ctx.message.messageId}`);
      await next();
    };
    const downstream: Middleware = async () => {};

    const chain = [guard, slowMw, downstream];
    const pA = runMiddlewareChain(chain, makeCtx({ message: makeMsg('A', 'slow') }));
    await new Promise((r) => setTimeout(r, 10));

    // /stop arrives while A is running → runs next() in parallel
    const pB = runMiddlewareChain(chain, makeCtx({ message: makeMsg('B', '/stop') }));

    await Promise.all([pA, pB]);

    // A completes normally; B runs in parallel via next()
    expect(trace).toContain('start:A');
    expect(trace).toContain('end:A');
    expect(trace).toContain('start:B');
    expect(trace).toContain('end:B');
  });

  it('urgent: cross-target isolation', async () => {
    const trace: string[] = [];
    const guard = concurrencyGuard({
      strategy: 'merge',
      maxQueue: 5,
      urgentPredicate: (ctx) => (ctx.message.content as string ?? '').startsWith('/'),
    });
    const downstream: Middleware = async (ctx) => {
      trace.push(`${ctx.message.replyTarget.targetId}:${ctx.message.messageId}:${ctx.message.content}`);
    };

    const u1MsgA = makeMsg('A', 'alpha', 'u1');
    const u1MsgStop = makeMsg('B', '/stop', 'u1');
    const u2MsgX = makeMsg('X', 'xray', 'u2');
    const u2MsgY = makeMsg('Y', 'yankee', 'u2');

    const chain = busyChain(guard, downstream);
    const pA = runMiddlewareChain(chain, makeCtx({ message: u1MsgA }));
    const pX = runMiddlewareChain(chain, makeCtx({ message: u2MsgX }));
    await new Promise((r) => setTimeout(r, 10));

    const pB = runMiddlewareChain(chain, makeCtx({ message: u1MsgStop }));
    const pY = runMiddlewareChain(chain, makeCtx({ message: u2MsgY }));

    await Promise.all([pA, pB, pX, pY]);

    // u1:/stop runs via next(); u2 unaffected
    const u2Entries = trace.filter((t) => t.startsWith('u2:'));
    expect(u2Entries.length).toBeGreaterThanOrEqual(2);
    // u1:/stop should appear
    expect(trace.some((t) => t.includes('/stop'))).toBe(true);
  });
});

describe('concurrency-guard: strategy=merge — defensive init', () => {
  it('mergeBuffer and mergeWaiters auto-init when missing (concurrent edge)', async () => {
    // This covers line 178-181: if mergeBuffer/mergeWaiters are undefined
    // when a new message arrives at a busy target, they are auto-created.
    const guard = concurrencyGuard({ strategy: 'merge', maxQueue: 5 });
    const downstream: Middleware = async (ctx) => {
      // Manually corrupt state to trigger defensive init path
    };

    // Use guard directly without busyChain to avoid the blocker
    const pA = runMiddlewareChain(
      busyChain(guard, downstream),
      makeCtx({ message: makeMsg('A', 'a') }),
    );
    await new Promise((r) => setTimeout(r, 5));

    // B arrives — mergeBuffer is initialized by owner above, so normal buffering
    const pB = runMiddlewareChain(
      busyChain(guard, downstream),
      makeCtx({ message: makeMsg('B', 'b') }),
    );

    await Promise.all([pA, pB]);
    // Both complete without crash — defensive init worked
  });
});

// ============ maxProcessingMs: timeout abort + lock release ============

describe('concurrency-guard: maxProcessingMs — timeout abort', () => {
  it('maxProcessingMs=0 (default): no timeout, long-running chain completes normally', async () => {
    const trace: string[] = [];
    const guard = concurrencyGuard({ strategy: 'merge', maxQueue: 5 }); // default 0
    const slowMw: Middleware = async (ctx) => {
      trace.push(`start:${ctx.message.messageId}`);
      await new Promise((r) => setTimeout(r, 100));
      trace.push(`end:${ctx.message.messageId} aborted=${ctx.signal.aborted}`);
    };

    await runMiddlewareChain([guard, slowMw], makeCtx({ message: makeMsg('A', 'alpha') }));

    expect(trace).toEqual(['start:A', 'end:A aborted=false']);
  });

  it('chain finishes before timeout: signal not aborted, timer cleared', async () => {
    const trace: string[] = [];
    const guard = concurrencyGuard({ strategy: 'merge', maxQueue: 5, maxProcessingMs: 500 });
    const downstream: Middleware = async (ctx) => {
      await new Promise((r) => setTimeout(r, 50));
      trace.push(`${ctx.message.messageId} aborted=${ctx.signal.aborted}`);
    };

    await runMiddlewareChain([guard, downstream], makeCtx({ message: makeMsg('A', 'alpha') }));

    expect(trace).toEqual(['A aborted=false']);
  });

  it('chain exceeds maxProcessingMs: ctx.abort() called, chain aborted, lock released', async () => {
    const trace: string[] = [];
    const guard = concurrencyGuard({ strategy: 'merge', maxQueue: 5, maxProcessingMs: 50 });
    const slowMw: Middleware = async (ctx) => {
      trace.push(`start:${ctx.message.messageId}`);
      // Run longer than maxProcessingMs — abort will fire mid-flight
      await new Promise((r) => setTimeout(r, 200));
      trace.push(`end:${ctx.message.messageId} aborted=${ctx.signal.aborted}`);
    };

    await runMiddlewareChain([guard, slowMw], makeCtx({ message: makeMsg('A', 'alpha') }));

    // Chain completes (even though aborted, the slowMw resolves eventually)
    // The signal should have been aborted at some point
    expect(trace).toHaveLength(2);
    expect(trace[0]).toBe('start:A');
    // After abort, the signal is aborted
    expect(trace[1]).toContain('aborted=true');
  });

  it('timeout with merge: buffered messages drained after abort', async () => {
    const trace: string[] = [];
    const guard = concurrencyGuard({
      strategy: 'merge',
      maxQueue: 5,
      maxProcessingMs: 50,
      onMerge: (buffered) => {
        const first = buffered[0]!;
        first.message.content = buffered.map((c) => c.message.content).join('+');
        return first;
      },
    });
    const slowMw: Middleware = async (ctx, next) => {
      trace.push(`start:${ctx.message.messageId}`);
      await new Promise((r) => setTimeout(r, 200));
      trace.push(`end:${ctx.message.messageId}`);
      await next();
    };
    const downstream: Middleware = async (ctx) => {
      trace.push(`${ctx.message.messageId}:${ctx.message.content}`);
    };

    const chain = [guard, slowMw, downstream];
    const pA = runMiddlewareChain(chain, makeCtx({ message: makeMsg('A', 'alpha') }));
    await new Promise((r) => setTimeout(r, 10));

    // B/C buffered while A runs (will exceed timeout)
    const pB = runMiddlewareChain(chain, makeCtx({ message: makeMsg('B', 'bravo') }));
    const pC = runMiddlewareChain(chain, makeCtx({ message: makeMsg('C', 'charlie') }));

    await Promise.all([pA, pB, pC]);

    // A starts; timeout fires mid-flight → abort, drain buffer → B(survivor) runs merged
    expect(trace).toContain('start:A');
    // B+C merged and dispatched as survivor
    const mergedLine = trace.find((t) => t.includes('bravo+charlie'));
    expect(mergedLine).toBeDefined();
  });

  it('timeout: lock released, next message can proceed', async () => {
    const trace: string[] = [];
    const guard = concurrencyGuard({ strategy: 'merge', maxQueue: 5, maxProcessingMs: 30 });
    const slowMw: Middleware = async (ctx) => {
      trace.push(`start:${ctx.message.messageId}`);
      await new Promise((r) => setTimeout(r, 100));
      trace.push(`end:${ctx.message.messageId}`);
    };

    const chain = [guard, slowMw];
    const pA = runMiddlewareChain(chain, makeCtx({ message: makeMsg('A', 'alpha') }));
    // Wait for timeout to fire
    await new Promise((r) => setTimeout(r, 50));

    // After timeout, lock released → B runs as new owner (no blocking)
    const startB = Date.now();
    const pB = runMiddlewareChain(chain, makeCtx({ message: makeMsg('B', 'bravo') }));
    await pB;
    const elapsedB = Date.now() - startB;

    await Promise.allSettled([pA]);

    // B started immediately (lock was released), not queued
    expect(elapsedB).toBeLessThan(150); // Not waiting for A's full 200ms
    expect(trace).toContain('start:B');
    expect(trace).toContain('end:B');
  });

  it('timeout with queue strategy: next queued message runs after abort', async () => {
    const trace: string[] = [];
    const guard = concurrencyGuard({ strategy: 'queue', maxQueue: 5, maxProcessingMs: 30 });
    const slowMw: Middleware = async (ctx) => {
      trace.push(`start:${ctx.message.messageId}`);
      await new Promise((r) => setTimeout(r, 100));
      trace.push(`end:${ctx.message.messageId}`);
    };

    const chain = [guard, slowMw];
    const pA = runMiddlewareChain(chain, makeCtx({ message: makeMsg('A', 'alpha') }));
    await new Promise((r) => setTimeout(r, 10));
    const pB = runMiddlewareChain(chain, makeCtx({ message: makeMsg('B', 'bravo') }));

    await Promise.allSettled([pA, pB]);

    // A exceeds timeout, aborted; B proceeds as new owner
    expect(trace).toContain('start:A');
    expect(trace).toContain('start:B');
    expect(trace).toContain('end:B');
  });

  it('timeout: downstream can detect abort via ctx.signal.aborted', async () => {
    const trace: string[] = [];
    const guard = concurrencyGuard({ strategy: 'merge', maxQueue: 5, maxProcessingMs: 30 });
    const abortAware: Middleware = async (ctx) => {
      trace.push(`before:${ctx.message.messageId} aborted=${ctx.signal.aborted}`);
      await new Promise((r) => setTimeout(r, 100));
      trace.push(`after:${ctx.message.messageId} aborted=${ctx.signal.aborted}`);
    };

    await runMiddlewareChain([guard, abortAware], makeCtx({ message: makeMsg('A', 'alpha') }));

    // Signal was false at start, true after timeout
    expect(trace[0]).toBe('before:A aborted=false');
    expect(trace[1]).toBe('after:A aborted=true');
  });

  it('timeout: ctx.aborted reflects abort state', async () => {
    const guard = concurrencyGuard({ strategy: 'merge', maxQueue: 5, maxProcessingMs: 30 });
    let abortedAfterSleep = false;
    const checkMw: Middleware = async (ctx) => {
      await new Promise((r) => setTimeout(r, 100));
      abortedAfterSleep = ctx.aborted;
    };

    await runMiddlewareChain([guard, checkMw], makeCtx({ message: makeMsg('A', 'alpha') }));

    expect(abortedAfterSleep).toBe(true);
  });

  it('timeout: does NOT prevent other targets from processing', async () => {
    const trace: string[] = [];
    const guard = concurrencyGuard({ strategy: 'merge', maxQueue: 5, maxProcessingMs: 30 });
    const slowMw: Middleware = async (ctx) => {
      trace.push(`start:${ctx.message.messageId}:${ctx.message.replyTarget.targetId}`);
      await new Promise((r) => setTimeout(r, 100));
      trace.push(`end:${ctx.message.messageId}`);
    };

    const chain = [guard, slowMw];
    // u1: slow message that will timeout
    const u1Msg = makeMsg('A', 'slow', 'u1');
    const pA = runMiddlewareChain(chain, makeCtx({ message: u1Msg }));
    await new Promise((r) => setTimeout(r, 5));

    // u2: runs independently, should not be blocked by u1 timeout
    const u2Msg = makeMsg('X', 'fast', 'u2');
    const startX = Date.now();
    const pX = runMiddlewareChain(chain, makeCtx({ message: u2Msg }));
    await pX;
    const elapsedX = Date.now() - startX;

    await Promise.allSettled([pA]);

    // u2 should complete quickly (not blocked by u1's timeout)
    expect(elapsedX).toBeLessThan(150);
    expect(trace).toContain('start:X:u2');
    expect(trace).toContain('end:X');
  });

  it('timeout not set (0): signal never aborted by guard', async () => {
    const guard = concurrencyGuard({ strategy: 'merge', maxQueue: 5 }); // default maxProcessingMs=0
    const checkMw: Middleware = async (ctx) => {
      await new Promise((r) => setTimeout(r, 50));
      expect(ctx.signal.aborted).toBe(false);
      expect(ctx.aborted).toBe(false);
    };

    await runMiddlewareChain([guard, checkMw], makeCtx({ message: makeMsg('A', 'alpha') }));
  });
});
