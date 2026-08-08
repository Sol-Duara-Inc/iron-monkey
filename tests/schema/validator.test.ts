import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadSchemas, validateEvent } from '../../src/schema/validator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = path.resolve(__dirname, '../../schemas/cdevents');

describe('validateEvent — failure formatting', () => {
  it('returns formatted instancePath errors for an invalid payload', async () => {
    const schemas = await loadSchemas(SCHEMAS_DIR);
    const schema = schemas.get('dev.cdevents.build.finished.0.3.0');
    expect(schema).toBeDefined();

    const result = validateEvent({ context: { id: 42 } }, schema!);
    expect(result.valid).toBe(false);
    expect(result.errors!.length).toBeGreaterThan(0);
    // Errors carry an instancePath (or "(root)") prefix and a message.
    expect(result.errors!.some((e) => /: /.test(e))).toBe(true);
  });
});
