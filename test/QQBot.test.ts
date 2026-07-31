import { describe, expect, it } from 'vitest';
import { QQBot } from '../src/index.js';

describe('QQBot construction', () => {
  it('throws when appId is missing', () => {
    expect(() => new QQBot({ appId: '', appSecret: 'x' })).toThrow(/appId/);
  });

  it('throws when appSecret is missing', () => {
    expect(() => new QQBot({ appId: 'x', appSecret: '' })).toThrow(/appSecret/);
  });

  it('exposes the protocol-layer primitives', () => {
    const bot = new QQBot({ appId: 'app', appSecret: 'secret' });
    expect(bot.tokenManager).toBeDefined();
    expect(bot.apiClient).toBeDefined();
    expect(bot.messageApi).toBeDefined();
    expect(bot.mediaApi).toBeDefined();
    expect(bot.chunkedMediaApi).toBeDefined();
  });

  it('returns a chainable on() handle', () => {
    const bot = new QQBot({ appId: 'app', appSecret: 'secret' });
    const handle = bot.on('ready', () => {});
    expect(handle).toBe(bot);
  });

  it('rejects sendTyping for non-c2c targets', async () => {
    const bot = new QQBot({ appId: 'app', appSecret: 'secret' });
    await expect(
      bot.sendTyping({ scope: 'group', targetId: 'g1' }),
    ).rejects.toThrow(/c2c/i);
  });

  it('rejects openStream for non-c2c targets', () => {
    const bot = new QQBot({ appId: 'app', appSecret: 'secret' });
    expect(() =>
      bot.openStream({ target: { scope: 'group', targetId: 'g1', msgId: 'm1' } }),
    ).toThrow(/c2c/i);
  });

  it('rejects openStream when msgId is missing', () => {
    const bot = new QQBot({ appId: 'app', appSecret: 'secret' });
    expect(() =>
      bot.openStream({ target: { scope: 'c2c', targetId: 'u1' } }),
    ).toThrow(/msgId/i);
  });
});
