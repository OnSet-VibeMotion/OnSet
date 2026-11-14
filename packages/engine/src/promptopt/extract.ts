/**
 * 从模型的回复里取出 JSON 对象。
 *
 * 提示词要求只输出一个 JSON 对象，但各家模型常在前面加一句话、包一层代码块，或者先写一份草稿再改；
 * 所以从后往前找最后一个能解析、并且带着要求字段的对象。
 */

/** text 里从 start（必须是「{」）开始、括号配平的那一段；配不平时为 null。字符串里的括号不算。 */
function balancedObject(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** 最后一个能解析成对象、且带着 requiredKey 的 JSON；没有时为 null。 */
export function extractJSONObject(text: string, requiredKey: string): Record<string, unknown> | null {
  for (let i = text.lastIndexOf('{'); i >= 0; i = i === 0 ? -1 : text.lastIndexOf('{', i - 1)) {
    const candidate = balancedObject(text, i);
    if (candidate === null) continue;
    try {
      const value: unknown = JSON.parse(candidate);
      if (value !== null && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, requiredKey)) {
        return value as Record<string, unknown>;
      }
    } catch {
      // 不是合法 JSON（例如正文里的花括号），接着往前找。
    }
  }
  return null;
}
