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

  it('returns a chain-end CDEvent envelope with context and subject', () => {
    const link = buildStandaloneEndLink(opts);
    expect(link).toEqual({
      context: {
        specversion: '0.5.1',
        id: 'end-link-uuid',
        source: 'https://spinnaker.example.com/',
        type: 'dev.cdevents.chain.end',
        timestamp: '2026-05-08T00:00:00.000Z',
        chainId: 'chain-uuid',
        links: [{ type: 'END', target: 'last-event-uuid' }],
      },
      subject: {
        id: 'chain-uuid',
        content: { lastEventId: 'last-event-uuid' },
      },
    });
  });

  it('sets context.specversion to 0.5.1', () => {
    expect(buildStandaloneEndLink(opts).context.specversion).toBe('0.5.1');
  });

  it('sets context.type to dev.cdevents.chain.end', () => {
    expect(buildStandaloneEndLink(opts).context.type).toBe('dev.cdevents.chain.end');
  });

  it('uses the chainId as the subject id', () => {
    expect(buildStandaloneEndLink(opts).subject.id).toBe('chain-uuid');
  });

  it('embeds an END link in context.links pointing at the last event', () => {
    const links = buildStandaloneEndLink(opts).context.links;
    expect(links).toEqual([{ type: 'END', target: 'last-event-uuid' }]);
  });

  it('mirrors lastEventId in subject.content for content-only consumers', () => {
    expect(buildStandaloneEndLink(opts).subject.content).toEqual({
      lastEventId: 'last-event-uuid',
    });
  });
});
