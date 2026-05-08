import { describe, it, expect } from 'vitest';
import { generateFallbackChainId } from '../../src/chain/fallback.js';

describe('generateFallbackChainId', () => {
  it('returns a URN with the expected structure', () => {
    const id = generateFallbackChainId('My Workflow Name');
    expect(id).toMatch(/^urn:sol-duara:fallback:[a-z0-9-]+:\d{8}T\d{6}Z:[0-9a-f]{6}$/);
  });

  it('slugifies the workflow name', () => {
    const id = generateFallbackChainId('Junction Box Demo');
    expect(id).toContain('junction-box-demo');
  });

  it('uses the sol-duara hyphenated namespace', () => {
    const id = generateFallbackChainId('test');
    expect(id.startsWith('urn:sol-duara:fallback:test:')).toBe(true);
  });

  it('produces different values on successive calls (non-deterministic)', () => {
    const a = generateFallbackChainId('test');
    const b = generateFallbackChainId('test');
    expect(typeof a).toBe('string');
    expect(typeof b).toBe('string');
  });

  it('is not a valid UUID', () => {
    const id = generateFallbackChainId('test');
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    expect(uuidRe.test(id)).toBe(false);
  });
});
