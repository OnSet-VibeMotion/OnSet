// 镜头制作卡片上的阶段、等待状态与那一行说明：纯函数，不开客户端
// （原来写在 e2e/render-board.spec.mjs、e2e/windows-render-progress.spec.mjs 里）。
// 步骤的形状照后端 studio/activity.ts 从 codex 流里译出来的写：MCP 工具带 mcp__onset__ 前缀，命令是 shell，改文件是 file_change。
import { expect, test } from 'vitest';
import { currentActivityStep, renderPhases, renderPresentation, windowsRenderProgress } from './render-progress.ts';
import { describeTool } from './chat/model.ts';

const hf = (subcommand, state = 'running', args) => ({ kind: 'tool', tool: 'mcp__onset__hyperframes', input: { subcommand, ...(args ? { args } : {}) }, state });
const edit = { kind: 'tool', tool: 'file_change', input: { id: 'edit', type: 'file_change', changes: [{ path: 'scene.js', kind: 'update' }] }, state: 'done' };
const command = (state) => ({ kind: 'tool', tool: 'shell', input: { command: 'inspect existing files' }, state });
const reconnect = { kind: 'error', text: 'Reconnecting... 2/5 (stream disconnected before completion: tls handshake eof)' };
const phase = (steps) => renderPhases[renderPresentation(steps).phase];

test('阶段来自实际动作，等待是独立状态', () => {
  // 刚改完文件：在制作画面，等模型给出下一步。
  expect(renderPresentation([edit])).toMatchObject({ state: 'waiting', label: '等模型回复', detail: '最近已更新制作文件' });
  expect(phase([edit])).toBe('制作画面');
  expect(phase([hf('check', 'done', ['--json'])])).toBe('检查画面');
  expect(phase([hf('check')])).toBe('检查画面');
  expect(phase([{ kind: 'tool', tool: 'mcp__onset__config_get', input: { key: 'FILM_STYLE' }, state: 'done' }])).toBe('准备素材');
  expect(renderPresentation([hf('render')])).toMatchObject({ phase: 3, state: 'busy', label: '进行中', detail: '正在渲染视频' });
  // 还没有任何日志：启动中，阶段未知。
  expect(renderPresentation([])).toEqual({ phase: undefined, state: 'starting', label: '启动中', detail: '正在启动制作工具' });
  // 后来的步骤认不出阶段时沿用前面最近一个认得出的。
  expect(phase([edit, { kind: 'text', text: '接着做' }])).toBe('制作画面');
});

test('命令结束后是等模型，不是还在干活', () => {
  expect(renderPresentation([command('done')])).toMatchObject({ state: 'waiting', label: '等模型回复', detail: '制作命令已完成' });
  // 运行时路径留在过程里，标题只说在跑制作命令。
  expect(renderPresentation([command('running')]).detail).toBe('正在运行制作命令');
});

test('后启动的命令已经结束、前面的 MCP 渲染仍在跑：不误报为等模型', () => {
  const steps = [command('done'), hf('render'), command('done')];
  expect(currentActivityStep(steps)).toBe(steps[1]);
  expect(renderPresentation(steps)).toMatchObject({ phase: 3, state: 'busy', label: '进行中', detail: '正在渲染视频' });
  expect(windowsRenderProgress(steps).title).toBe('取帧与编码中');
});

test('模型连接中断：正在重连，阶段留在最后的动作上', () => {
  const steps = [command('done'), { ...hf('render'), state: 'done' }, reconnect];
  expect(renderPresentation(steps)).toMatchObject({ phase: 3, state: 'warning', label: '正在重连', detail: '模型连接中断，正在重试' });
  expect(windowsRenderProgress(steps)).toMatchObject({ title: '连接重试中', line: reconnect.text });
  const short = [edit, { kind: 'error', text: 'Reconnecting: tls handshake eof' }];
  expect(renderPresentation(short)).toMatchObject({ phase: 1, label: '正在重连' });
  // 别的错误不算重连。
  expect(renderPresentation([edit, { kind: 'error', text: 'boom' }])).toMatchObject({ state: 'warning', label: '处理问题' });
});

test('想完一段与说完话：等后续', () => {
  expect(renderPresentation([{ kind: 'thinking', text: '想', chars: 1 }])).toMatchObject({ state: 'waiting', label: '等模型回复', detail: '刚想完一段，等模型给出下一步' });
  expect(renderPresentation([{ kind: 'text', text: '[[USER_MESSAGE]]视频已渲染完成\n细节' }])).toMatchObject({ label: '收尾中', detail: '视频已渲染完成' });
  expect(renderPresentation([{ kind: 'text', text: '画面排好了' }])).toMatchObject({ label: '等后续进展', detail: '画面排好了' });
});

test('不报工具结束事件的旧流：最后一步说了算，等待写成「等待更新」', () => {
  expect(renderPresentation([command('running'), hf('check', 'running')], false).label).toBe('进行中');
  expect(renderPresentation([hf('render', 'done')], false).label).toBe('等待更新');
  expect(windowsRenderProgress([hf('render', 'done')], false).title).toBe('等待状态更新');
});

test('检查画面时标题只说在检查，参数与运行时路径留在过程里', () => {
  const shell = { kind: 'tool', tool: 'shell', input: { command: '"C:\\Program Files\\WindowsApps\\OpenAI.CodexRuntime\\pwsh.exe" -Command "inspect scene files"' }, state: 'done' };
  expect(describeTool(shell.tool, shell.input).target).toContain('OpenAI.CodexRuntime');
  const steps = [shell, hf('check', 'running', ['--json'])];
  expect(renderPresentation(steps)).toMatchObject({ phase: 2, detail: '正在检查画面' });
  expect(describeTool('mcp__onset__hyperframes', steps[1].input).target).toBe('--json');
});
