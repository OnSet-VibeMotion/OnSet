// Go text/template 的最小子集，只够渲染风格来源的 SKILL.md、ATTRIBUTION.md 这类模板（lemo-opuscar、anidoodle 共用）：
// {{.A.B}} 取字段、{{if .X}} … {{end}} 条件、{{- / -}} 去掉相邻空白。
// 遇到不认识的动作直接报错，免得模板悄悄用了这里没实现的语法却渲染成别的样子。

type Node =
  | { kind: 'text'; text: string }
  | { kind: 'field'; path: string[] }
  | { kind: 'if'; path: string[]; body: Node[] };

/** text/template 的「空白」：空格、制表、回车、换行。 */
const trimSet = ' \t\r\n';

function trimLeft(s: string): string {
  let i = 0;
  while (i < s.length && trimSet.includes(s[i]!)) i++;
  return s.slice(i);
}

function trimRight(s: string): string {
  let i = s.length;
  while (i > 0 && trimSet.includes(s[i - 1]!)) i--;
  return s.slice(0, i);
}

interface Token {
  text: string;
  action?: string;
}

function tokenize(name: string, source: string): Token[] {
  const tokens: Token[] = [];
  let rest = source;
  let trimNext = false;
  for (;;) {
    const open = rest.indexOf('{{');
    let text = open < 0 ? rest : rest.slice(0, open);
    if (trimNext) text = trimLeft(text);
    if (open < 0) {
      tokens.push({ text });
      return tokens;
    }
    const close = rest.indexOf('}}', open + 2);
    if (close < 0) throw new Error(`template: ${name}: unclosed action`);
    let inner = rest.slice(open + 2, close);
    // 「{{- 」与「 -}}」：减号后（前）必须跟空白，才是去空白标记。
    if (/^-[ \t\r\n]/.test(inner)) {
      text = trimRight(text);
      inner = inner.slice(1);
    }
    trimNext = false;
    if (/[ \t\r\n]-$/.test(inner)) {
      trimNext = true;
      inner = inner.slice(0, -1);
    }
    tokens.push({ text, action: inner.trim() });
    rest = rest.slice(close + 2);
  }
}

function parseField(name: string, expr: string): string[] {
  if (!/^(\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(expr)) throw new Error(`template: ${name}: unsupported action ${JSON.stringify(expr)}`);
  return expr.slice(1).split('.');
}

function parse(name: string, source: string): Node[] {
  const root: Node[] = [];
  const stack: Node[][] = [root];
  for (const token of tokenize(name, source)) {
    const current = stack[stack.length - 1]!;
    if (token.text !== '') current.push({ kind: 'text', text: token.text });
    if (token.action === undefined) continue;
    const action = token.action;
    if (action === 'end') {
      if (stack.length === 1) throw new Error(`template: ${name}: unexpected {{end}}`);
      stack.pop();
    } else if (action.startsWith('if ')) {
      const node: Node = { kind: 'if', path: parseField(name, action.slice(3).trim()), body: [] };
      current.push(node);
      stack.push(node.body);
    } else {
      current.push({ kind: 'field', path: parseField(name, action) });
    }
  }
  if (stack.length !== 1) throw new Error(`template: ${name}: unexpected EOF`);
  return root;
}

function resolve(name: string, data: unknown, fieldPath: string[]): unknown {
  let value = data;
  for (const field of fieldPath) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, field)) {
      throw new Error(`template: ${name}: executing "${name}": can't evaluate field ${field}`);
    }
    value = (value as Record<string, unknown>)[field];
  }
  return value;
}

/** text/template 的真值：false、0、nil、空串、空切片 / 空 map 为假。 */
function truthy(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

function print(value: unknown): string {
  if (value === null || value === undefined) return '<no value>';
  if (Array.isArray(value)) return '[' + value.map(print).join(' ') + ']';
  return String(value);
}

function execute(name: string, nodes: Node[], data: unknown): string {
  let out = '';
  for (const node of nodes) {
    if (node.kind === 'text') out += node.text;
    else if (node.kind === 'field') out += print(resolve(name, data, node.path));
    else if (truthy(resolve(name, data, node.path))) out += execute(name, node.body, data);
  }
  return out;
}

/** 解析并执行模板。data 的字段名用 Go 的导出名（Style.CN 等）。 */
export function renderTemplate(name: string, source: string, data: unknown): string {
  return execute(name, parse(name, source), data);
}
