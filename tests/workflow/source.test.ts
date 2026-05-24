import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/workflow/parser.js', () => ({
  validateWorkflow: vi.fn(),
}));

import { FileWorkflowSource, WorkflowSource } from '../../src/workflow/source.js';
import { validateWorkflow } from '../../src/workflow/parser.js';

const mockWorkflow = {
  workflow: { id: 'wf-1', name: 'test', cdrus: { version: 1 }, produces: [] },
};

describe('FileWorkflowSource', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is a WorkflowSource', () => {
    expect(new FileWorkflowSource('x.yaml')).toBeInstanceOf(WorkflowSource);
  });

  describe('name', () => {
    it('returns the basename of a simple filename', () => {
      expect(new FileWorkflowSource('workflow.yaml').name).toBe('workflow.yaml');
    });

    it('returns the basename of a nested path', () => {
      expect(new FileWorkflowSource('/workflows/my-pipeline.yaml').name).toBe('my-pipeline.yaml');
    });

    it('returns the basename of a relative path', () => {
      expect(new FileWorkflowSource('a/b/c.yaml').name).toBe('c.yaml');
    });
  });

  describe('getWorkflow()', () => {
    it('delegates to validateWorkflow with the original path', async () => {
      (validateWorkflow as ReturnType<typeof vi.fn>).mockResolvedValue(mockWorkflow);

      const result = await new FileWorkflowSource('/some/path.yaml').getWorkflow();

      expect(validateWorkflow).toHaveBeenCalledWith('/some/path.yaml');
      expect(result).toBe(mockWorkflow);
    });

    it('propagates errors thrown by validateWorkflow', async () => {
      (validateWorkflow as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Cannot read workflow file: missing.yaml'),
      );

      await expect(new FileWorkflowSource('missing.yaml').getWorkflow()).rejects.toThrow(
        'Cannot read workflow file',
      );
    });
  });
});

describe('WorkflowSource (abstract contract)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('can be subclassed with a custom implementation', async () => {
    class StaticSource extends WorkflowSource {
      get name() { return 'static'; }
      async getWorkflow() { return mockWorkflow as never; }
    }

    const source = new StaticSource();
    expect(source.name).toBe('static');
    expect(await source.getWorkflow()).toBe(mockWorkflow);
  });

  it('custom source does not call validateWorkflow', async () => {
    class StaticSource extends WorkflowSource {
      get name() { return 'static'; }
      async getWorkflow() { return mockWorkflow as never; }
    }

    await new StaticSource().getWorkflow();
    expect(validateWorkflow).not.toHaveBeenCalled();
  });
});
