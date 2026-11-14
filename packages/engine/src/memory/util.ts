// 本包内部的小工具（Go 版散落在各文件里的 contains、uniqueSorted、intersect、rendererModel……）。
import { compareBytes } from '../gojson';

export function contains(list: readonly string[] | null | undefined, value: string): boolean {
  return (list ?? []).includes(value);
}

/** 去掉空串与重复后按字节序排序；没有元素时返回 null（Go 的 nil 切片）。 */
export function uniqueSorted(values: readonly string[] | null | undefined): string[] | null {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values ?? []) {
    if (value !== '' && !seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  out.sort(compareBytes);
  return out.length > 0 ? out : null;
}

/** a 与 b 的交集，去重、排序；没有交集时返回 null。 */
export function intersect(a: readonly string[] | null | undefined, b: readonly string[] | null | undefined): string[] | null {
  const out: string[] = [];
  for (const x of a ?? []) {
    if (contains(b, x) && !out.includes(x)) out.push(x);
  }
  out.sort(compareBytes);
  return out.length > 0 ? out : null;
}

/** slices.Equal（nil 与空切片相等）。 */
export function equalStrings(a: readonly string[] | null | undefined, b: readonly string[] | null | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

export function rendererModel(renderer: string, model: string): string {
  return model === '' ? renderer : renderer + '/' + model;
}

/** Go 的 sort.Strings 后的副本。 */
export function sortedStrings(values: readonly string[]): string[] {
  return [...values].sort(compareBytes);
}

/** nil 切片在 JSON 里写成 null、有元素时原样；用于 Go 里不带 omitempty 的切片字段。 */
export function orNull<T>(list: T[] | null | undefined): T[] | null {
  return list ?? null;
}

/** omitempty 的切片：空时省略。 */
export function omitEmpty<T>(list: T[] | null | undefined): T[] | undefined {
  return list && list.length > 0 ? list : undefined;
}

/** Go map 的 JSON：按键排序。 */
export { sortedKeys } from '../gojson';
