/**
 * A built event carries no empty object. The release workflow's merge and
 * deployment name the layered Saronis types whose `repository` and
 * `environment` are objects with no declared member: each goes out with data.
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import { buildManifest } from '../../src/manifest/builder.js';
import { resolveChainTree } from '../../src/workflow/chain-tree.js';
import { createRegistry } from '../../src/expressions/loader.js';
import { createLogger, setLogger } from '../../src/logger/index.js';
import type { WorkflowFile } from '../../src/workflow/types.js';
import type { IronMonkeyConfig } from '../../src/config/types.js';

setLogger(createLogger({ level: 'fatal', format: 'json' }));

const SCHEMAS_DIR = path.resolve(__dirname, '../../schemas/cdevents');
const MERGED = 'com.saronis.platform.svc.change.merged.0.1.0';
const DEPLOYED = 'com.saronis.platform.svc.service.deployed.0.1.0';

describe('a built event carries no empty object', () => {
  it("fills the release types' repository and environment with three pairs each", async () => {
    const config: IronMonkeyConfig = {
      buses: { default: { type: 'rabbitmq', url: 'amqp://x' } },
      tools: {},
      schemasPath: SCHEMAS_DIR,
    };
    const workflow = {
      workflow: {
        id: 'release-wf',
        name: 'release-wf',
        defaults: { tool: 't', source: 'https://t.example/' },
        produces: [{ event: MERGED }, { event: DEPLOYED }],
      },
    } as unknown as WorkflowFile;
    const chain = resolveChainTree(workflow, createRegistry([]));
    const manifest = await buildManifest({ id: 'release-wf', name: 'release-wf' }, chain, config, {
      noConduit: true,
      interval: 0,
    });
    const [merged, deployed] = manifest.events;
    const objects: Array<[string, unknown, string[] | undefined]> = [
      ['repository', merged.payload.subject.content.repository, merged.synthesized],
      ['environment', deployed.payload.subject.content.environment, deployed.synthesized],
      ['repository', deployed.payload.subject.content.repository, deployed.synthesized],
    ];
    for (const [field, value, synthesized] of objects) {
      const pairs = value as Record<string, unknown>;
      expect(
        Object.values(pairs).map((v) => typeof v),
        field,
      ).toEqual(['string', 'number', 'boolean']);
      for (const key of Object.keys(pairs)) {
        expect(synthesized).toContain(`/subject/content/${field}/${key}`);
      }
    }
  });
});
