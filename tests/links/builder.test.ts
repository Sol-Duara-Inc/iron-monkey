import { describe, it, expect } from 'vitest';
import {
  buildPathLink,
  buildEndLink,
  buildStartLink,
  buildStandaloneEndLink,
} from '../../src/links/builder.js';

describe('buildPathLink', () => {
  it('returns a PATH link pointing to the given event id', () => {
    const link = buildPathLink('prev-evt-123');
    expect(link).toEqual({ type: 'PATH', target: 'prev-evt-123' });
  });
});

describe('buildEndLink', () => {
  it('returns an END link pointing to the last event id', () => {
    const link = buildEndLink('last-evt-456');
    expect(link).toEqual({ type: 'END', target: 'last-evt-456' });
  });
});

describe('buildStartLink', () => {
  it('returns a START link pointing to the first event id', () => {
    const link = buildStartLink('first-evt-789');
    expect(link).toEqual({ type: 'START', target: 'first-evt-789' });
  });
});

describe('buildStandaloneEndLink', () => {
  const opts = {
    id: 'end-link-uuid',
    source: 'https://spinnaker.example.com/',
    chainId: 'chain-uuid',
    lastEventId: 'last-event-uuid',
    timestamp: '2026-05-08T00:00:00.000Z',
  };

  it('returns a standalone end link with all required fields', () => {
    const link = buildStandaloneEndLink(opts);
    expect(link).toEqual({
      specversion: '0.5.1',
      id: 'end-link-uuid',
      source: 'https://spinnaker.example.com/',
      type: 'dev.cdevents.chain.end',
      timestamp: '2026-05-08T00:00:00.000Z',
      chainId: 'chain-uuid',
      lastEventId: 'last-event-uuid',
    });
  });

  it('sets specversion to 0.5.1', () => {
    expect(buildStandaloneEndLink(opts).specversion).toBe('0.5.1');
  });

  it('sets type to dev.cdevents.chain.end', () => {
    expect(buildStandaloneEndLink(opts).type).toBe('dev.cdevents.chain.end');
  });
});
