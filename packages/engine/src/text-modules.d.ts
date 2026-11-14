// 随程序下发的文本数据文件（模板）：vitest 由 vitest.config.ts 的插件、esbuild 由 --loader:.tmpl=text 当文本加载。
declare module '*.tmpl' {
  const text: string;
  export default text;
}
