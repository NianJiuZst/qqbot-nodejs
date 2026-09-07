import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { QQBot } from '../src/QQBot.js';
import { GatewayConnection, type GatewayConnectionOptions } from '../src/protocol/gateway/gateway-connection.js';

const account = { accountId: 'test', appId: 'test', clientSecret: 'test' };
const controllers: AbortController[] = [];
let server: WebSocketServer;
let url: string;
let sockets: WebSocket[];

function connection(overrides: Partial<GatewayConnectionOptions> = {}) {
  const controller = new AbortController();
  controllers.push(controller);
  return {
    controller,
    gateway: new GatewayConnection({
      account, abortSignal: controller.signal,
      getAccessToken: async () => 'test-token', getGatewayUrl: async () => url,
      onMessage: () => {}, ...overrides,
    }),
  };
}

function outcome(run: Promise<void>) {
  const result = { status: 'pending', error: undefined as unknown };
  void run.then(() => { result.status = 'resolved'; }, (error) => {
    result.status = 'rejected'; result.error = error;
  });
  return result;
}

beforeEach(async () => {
  sockets = [];
  server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  url = `ws://127.0.0.1:${address.port}`;
  server.on('connection', (ws) => {
    sockets.push(ws);
    ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 100_000 } }));
    ws.on('message', (data) => {
      const { op } = JSON.parse(data.toString());
      if (op === 2 || op === 6) ws.send(JSON.stringify({
        op: 0, t: op === 6 ? 'RESUMED' : 'READY', s: 1, d: { session_id: 'test-session' },
      }));
    });
  });
  // Only compress reconnect backoff; actual ws handshake, close and message I/O remain real.
  const realSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback, delay, ...args) =>
    realSetTimeout(callback, [1000, 2000, 3000, 5000, 10_000, 30_000, 60_000].includes(delay as number) ? 1 : delay, ...args)
  ) as typeof setTimeout);
});

afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  for (const ws of server.clients) ws.terminate();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.restoreAllMocks();
});

describe('gateway lifecycle', () => {
  it('reports disconnection and resumes after a temporary outage', async () => {
    const onReady = vi.fn();
    const onResumed = vi.fn();
    const onDisconnected = vi.fn();
    const { gateway } = connection({ onReady, onResumed, onDisconnected });
    const run = outcome(gateway.start());
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());
    sockets[0].terminate();
    await vi.waitFor(() => expect(onResumed).toHaveBeenCalledOnce());
    expect(onDisconnected).toHaveBeenCalledExactlyOnceWith({ code: 1006, reason: '' });
    expect(run.status).toBe('pending');
  });

  it('rejects after the real retry budget is exhausted so an owner can restart', async () => {
    let online = true;
    const onReady = vi.fn();
    const onError = vi.fn();
    const getGatewayUrl = vi.fn(async () => {
      if (!online) throw new Error('simulated outage');
      return url;
    });
    const { gateway } = connection({ onReady, onError, getGatewayUrl });
    const run = outcome(gateway.start());
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());
    online = false;
    sockets[0].terminate();
    await vi.waitFor(() => expect(getGatewayUrl).toHaveBeenCalledTimes(101));
    expect(run.status).toBe('rejected');
    expect(run.error).toEqual(expect.objectContaining({ message: expect.stringMatching(/reconnect attempts/i) }));
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'simulated outage' }));
    online = true;
    const restarted = connection({ onReady });
    outcome(restarted.gateway.start());
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(2));
  });

  it.each([1000, 4914, 4915])('settles a terminal remote close (%i)', async (code) => {
    const onReady = vi.fn();
    const { gateway } = connection({ onReady });
    const run = outcome(gateway.start());
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());
    sockets[0].close(code, 'terminal close');
    await vi.waitFor(() => expect(run.status).toBe('rejected'));
    expect(sockets).toHaveLength(1);
  });

  it('resolves an already-aborted start without fetching credentials', async () => {
    const controller = new AbortController();
    controller.abort();
    const getAccessToken = vi.fn(async () => 'test-token');
    const { gateway } = connection({ abortSignal: controller.signal, getAccessToken });
    const run = outcome(gateway.start());
    await sleep(10);
    expect(run.status).toBe('resolved');
    expect(getAccessToken).not.toHaveBeenCalled();
    const repeated = outcome(gateway.start());
    await sleep(10);
    expect(repeated.status).toBe('resolved');
  });

  it.each(['token', 'url'])('settles abort during %s lookup and does not open a late socket', async (phase) => {
    let release!: (value: string) => void;
    const pending = new Promise<string>((resolve) => { release = resolve; });
    const lookup = vi.fn(() => pending);
    const { gateway, controller } = connection(phase === 'token'
      ? { getAccessToken: lookup } : { getGatewayUrl: lookup });
    const run = outcome(gateway.start());
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledOnce());
    controller.abort();
    await sleep(10);
    expect(run.status).toBe('resolved');
    release(phase === 'token' ? 'test-token' : url);
    await sleep(20);
    expect(sockets).toHaveLength(0);
  });

  it.each([7, 9])('keeps one replacement connection after gateway opcode %i', async (op) => {
    const onReady = vi.fn();
    const onResumed = vi.fn();
    const onDisconnected = vi.fn();
    const { gateway } = connection({ onReady, onResumed, onDisconnected });
    const run = outcome(gateway.start());
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());
    sockets[0].send(JSON.stringify({ op, d: false }));
    await vi.waitFor(() => expect(onReady.mock.calls.length + onResumed.mock.calls.length).toBe(2));
    await sleep(20);
    expect(onDisconnected).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(2);
    expect(sockets[1].readyState).toBe(WebSocket.OPEN);
    expect(run.status).toBe('pending');
  });

  it('does not start a transport or token refresher after QQBot stops during initialization', async () => {
    const bot = new QQBot({ appId: 'test', appSecret: 'test' });
    let release!: (value: string) => void;
    const token = new Promise<string>((resolve) => { release = resolve; });
    vi.spyOn(bot.tokenManager, 'getAccessToken').mockReturnValue(token);
    const gatewayUrl = vi.spyOn(bot.messageApi, 'getGatewayUrl').mockResolvedValue(url);
    const run = outcome(bot.start());
    bot.stop();
    release('test-token');
    await vi.waitFor(() => expect(run.status).toBe('resolved'));
    expect(gatewayUrl).not.toHaveBeenCalled();
    expect(bot.tokenManager.isBackgroundRefreshRunning()).toBe(false);
  });

  it('forwards disconnects and allows QQBot to restart after terminal failure', async () => {
    const bot = new QQBot({ appId: 'test', appSecret: 'test' });
    vi.spyOn(bot.tokenManager, 'getAccessToken').mockResolvedValue('test-token');
    vi.spyOn(bot.messageApi, 'getGatewayUrl').mockResolvedValue(url);
    const onReady = vi.fn();
    const onDisconnected = vi.fn();
    bot.on('ready', onReady).on('disconnected', onDisconnected);
    try {
      const run = outcome(bot.start());
      await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());
      sockets[0].close(4914, 'offline');
      await vi.waitFor(() => expect(run.status).toBe('rejected'));
      expect(onDisconnected).toHaveBeenCalledExactlyOnceWith({ code: 4914, reason: 'offline' });
      expect(bot.tokenManager.isBackgroundRefreshRunning()).toBe(false);
      const restarted = outcome(bot.start());
      await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(2));
      bot.stop();
      await vi.waitFor(() => expect(restarted.status).toBe('resolved'));
    } finally { bot.stop(); }
  });
});
