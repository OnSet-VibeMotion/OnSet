import { describe, expect, it } from 'vitest';
import { encodeLine, marshal, marshalIndent, sortedKeys } from './index';

// 期望值取自 Go 1.25 的 encoding/json 实际输出（json.Marshal、json.MarshalIndent(v, "", "  ")、
// 以及 SetEscapeHTML(false) + SetIndent("", "\t") 的 Encoder.Encode）。
const value = {
  name: 'a<b>&c \u2028\u2029 \b\f\n\r\t\x01 "q" \\ 中文 😀',
  tags: ['x', 'y'],
  empty: [],
  nil: null,
  map: sortedKeys({ b: 2, a: 1, 中: 3, B: 4 }),
  obj: {},
  f: [0, -0, 1.5, 1e21, 1e20, 1e-7, 0.000001, 123456789.125, 0.3, -3],
};

describe('gojson', () => {
  it('matches json.Marshal', () => {
    expect(marshal(value)).toBe(
      '{"name":"a\\u003cb\\u003e\\u0026c \\u2028\\u2029 \\b\\f\\n\\r\\t\\u0001 \\"q\\" \\\\ 中文 😀","tags":["x","y"],"empty":[],"nil":null,"map":{"B":4,"a":1,"b":2,"中":3},"obj":{},"f":[0,-0,1.5,1e+21,100000000000000000000,1e-7,0.000001,123456789.125,0.3,-3]}',
    );
  });

  it('matches json.MarshalIndent with two spaces', () => {
    expect(marshalIndent(value)).toBe(
      '{\n  "name": "a\\u003cb\\u003e\\u0026c \\u2028\\u2029 \\b\\f\\n\\r\\t\\u0001 \\"q\\" \\\\ 中文 😀",\n  "tags": [\n    "x",\n    "y"\n  ],\n  "empty": [],\n  "nil": null,\n  "map": {\n    "B": 4,\n    "a": 1,\n    "b": 2,\n    "中": 3\n  },\n  "obj": {},\n  "f": [\n    0,\n    -0,\n    1.5,\n    1e+21,\n    100000000000000000000,\n    1e-7,\n    0.000001,\n    123456789.125,\n    0.3,\n    -3\n  ]\n}',
    );
  });

  it('matches an Encoder with SetEscapeHTML(false) and tab indent', () => {
    expect(encodeLine(value, { indent: '\t', escapeHTML: false })).toBe(
      '{\n\t"name": "a<b>&c \\u2028\\u2029 \\b\\f\\n\\r\\t\\u0001 \\"q\\" \\\\ 中文 😀",\n\t"tags": [\n\t\t"x",\n\t\t"y"\n\t],\n\t"empty": [],\n\t"nil": null,\n\t"map": {\n\t\t"B": 4,\n\t\t"a": 1,\n\t\t"b": 2,\n\t\t"中": 3\n\t},\n\t"obj": {},\n\t"f": [\n\t\t0,\n\t\t-0,\n\t\t1.5,\n\t\t1e+21,\n\t\t100000000000000000000,\n\t\t1e-7,\n\t\t0.000001,\n\t\t123456789.125,\n\t\t0.3,\n\t\t-3\n\t]\n}\n',
    );
  });

  it('skips undefined fields like omitted omitempty fields', () => {
    expect(marshal({ a: 1, b: undefined, c: 'x' })).toBe('{"a":1,"c":"x"}');
  });
});
