import { describe, expect, it } from 'vitest';
import {
  ApiError,
  MediaFileType,
  QQBot,
  StreamContentType,
  StreamInputMode,
  StreamInputState,
  StreamSession,
  UploadCache,
  UploadDailyLimitExceededError,
  formatErrorMessage,
  formatFileSize,
  getFileTypeName,
  getMaxUploadSize,
  sanitizeFileName,
  CHUNKED_UPLOAD_MAX_SIZE,
  LARGE_FILE_THRESHOLD,
  MAX_UPLOAD_SIZE,
} from '../src/index.js';

describe('package entry (re-exports)', () => {
  it('exports the QQBot class', () => {
    expect(typeof QQBot).toBe('function');
    expect(QQBot.prototype.start).toBeTypeOf('function');
    expect(QQBot.prototype.sendText).toBeTypeOf('function');
  });

  it('exports the StreamSession class', () => {
    expect(typeof StreamSession).toBe('function');
  });

  it('exports the structured ApiError', () => {
    const err = new ApiError('boom', 500, '/v2/users/x/messages', 1234, 'detail');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ApiError');
    expect(err.httpStatus).toBe(500);
    expect(err.bizCode).toBe(1234);
    expect(err.bizMessage).toBe('detail');
    expect(err.path).toBe('/v2/users/x/messages');
  });

  it('exports the UploadDailyLimitExceededError', () => {
    const err = new UploadDailyLimitExceededError('/tmp/big.zip', 1024, 'limit hit');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('UploadDailyLimitExceededError');
    expect(err.fileSize).toBe(1024);
  });

  it('exposes the MediaFileType enum', () => {
    expect(MediaFileType.IMAGE).toBe(1);
    expect(MediaFileType.VIDEO).toBe(2);
    expect(MediaFileType.VOICE).toBe(3);
    expect(MediaFileType.FILE).toBe(4);
  });

  it('exposes the stream message constants', () => {
    expect(StreamInputMode.REPLACE).toBe('replace');
    expect(StreamInputState.GENERATING).toBe(1);
    expect(StreamInputState.DONE).toBe(10);
    expect(StreamContentType.MARKDOWN).toBe('markdown');
  });

  it('exposes UploadCache as a constructible class', () => {
    const cache = new UploadCache();
    expect(cache.stats().size).toBe(0);
  });

  it('exposes file size constants and helpers', () => {
    expect(LARGE_FILE_THRESHOLD).toBe(5 * 1024 * 1024);
    expect(MAX_UPLOAD_SIZE).toBe(20 * 1024 * 1024);
    expect(CHUNKED_UPLOAD_MAX_SIZE).toBe(100 * 1024 * 1024);
    expect(getFileTypeName(MediaFileType.IMAGE)).toBe('image');
    expect(getMaxUploadSize(MediaFileType.IMAGE)).toBe(30 * 1024 * 1024);
  });

  it('exposes formatting helpers', () => {
    expect(typeof formatErrorMessage).toBe('function');
    expect(typeof formatFileSize).toBe('function');
    expect(formatErrorMessage(new Error('hi'))).toContain('hi');
  });

  it('sanitizes filenames', () => {
    expect(sanitizeFileName('a/b\\c.txt')).toBe('a_b_c.txt');
    expect(sanitizeFileName('   ')).toBe('file');
    expect(sanitizeFileName('')).toBe('file');
  });
});
