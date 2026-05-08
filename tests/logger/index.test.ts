import { describe, it, expect, afterEach } from 'vitest';
import { createLogger, setLogger, getLogger } from '../../src/logger/index.js';

describe('createLogger', () => {
  it('creates a json logger by default', () => {
    const logger = createLogger();
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
  });

  it('creates a logger with the specified log level', () => {
    const logger = createLogger({ level: 'debug' });
    expect(logger.level).toBe('debug');
  });

  it('creates a logger with error level', () => {
    const logger = createLogger({ level: 'error' });
    expect(logger.level).toBe('error');
  });

  it('creates a text (pino-pretty) logger without throwing', () => {
    // pino-pretty transport is async; just verify construction does not throw
    expect(() => createLogger({ format: 'text' })).not.toThrow();
  });

  it('defaults to info level', () => {
    const logger = createLogger({ format: 'json' });
    expect(logger.level).toBe('info');
  });
});

describe('setLogger / getLogger', () => {
  let original: ReturnType<typeof getLogger>;

  afterEach(() => {
    // restore the logger we had before each test
    setLogger(original);
  });

  it('getLogger returns the default logger before any setLogger call', () => {
    original = getLogger();
    expect(original).toBeDefined();
  });

  it('getLogger returns the logger set by setLogger', () => {
    original = getLogger();
    const custom = createLogger({ level: 'warn' });
    setLogger(custom);
    expect(getLogger()).toBe(custom);
  });

  it('getLogger reflects the most recently set logger', () => {
    original = getLogger();
    const first = createLogger({ level: 'debug' });
    const second = createLogger({ level: 'error' });
    setLogger(first);
    setLogger(second);
    expect(getLogger()).toBe(second);
  });
});
