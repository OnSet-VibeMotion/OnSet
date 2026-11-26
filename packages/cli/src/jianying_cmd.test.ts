import { describe, expect, it } from 'vitest';
import './cli';
import { findOp } from './ops/op';

describe('project_export_jianying op', () => {
  it('registers project_export_jianying in the op table with expected CLI path and params', () => {
    const op = findOp('project_export_jianying');
    expect(op).toBeDefined();
    expect(op?.cli).toEqual(['jianying', 'export']);
    expect(Object.keys(op?.params ?? {})).toEqual(['project_root', 'dest', 'name', 'include_draft', 'overwrite']);
  });
});
