// 桌宠的制作人此刻在哪个部门、气泡说什么：纯函数，不开客户端（原来写在 e2e/pet.spec.mjs 里）。
import { expect, test } from 'vitest';
import { buildBlocks } from './model.ts';
import { choiceQuestion, crewLinger, crewState } from './crew.ts';

const start = Date.parse('2026-11-15T00:00:00Z');
function turnOf(rows) {
  const events = [{ kind: 'turn-start' }, ...rows].map((event, seq) => ({
    seq, turn_id: 'current', time: new Date(start + seq * 1000).toISOString(), ...event,
  }));
  return buildBlocks(events).find((block) => block.kind === 'turn');
}
const now = start + 10_000;
const calling = (tool, input) => turnOf([{ kind: 'tool-call', call_id: 'c', tool, input }]);

test('没有进行中的一轮时不给状态（桌宠按待命画）', () => {
  expect(crewState(undefined, [], [], now)).toBeNull();
});

test('还没有结果的那次调用决定制作人在哪个部门，气泡只写一行', () => {
  // 读文件：气泡只写文件名。
  expect(crewState(calling('Read', { file_path: 'production/script-final.md' }), [], [], now)).toEqual({ mood: 'reading', line: '读取 script-final.md' });
  // 调 onset 渲染镜头：没有镜头在渲染时写工具在做什么。
  expect(crewState(calling('mcp__onset__scene_run', { scene: 'scenes/scene-001' }), [], [], now)).toEqual({ mood: 'filming', line: '渲染镜头 scene-001' });
  // 制作人（内置编排工具）不带前缀：照样认得是在拍。
  expect(crewState(calling('scene_run', { scene: 'scenes/scene-001' }), [], [], now)).toEqual({ mood: 'filming', line: '渲染镜头 scene-001' });
  // 有镜头在渲染时点名在拍哪几个，多了只点前两个。
  const rendering = ['scene-001', 'scene-002', 'scene-003'].map((id) => ({ id, rendering: true }));
  expect(crewState(calling('scene_run', {}), [], rendering, now).line).toBe('在拍 scene-001、scene-002 等 3 个镜头');
  expect(crewState(calling('mcp__onset__hyperframes', { subcommand: 'render' }), [], [], now).mood).toBe('filming');
  // 改分镜计划：走到分镜板前。
  expect(crewState(calling('Edit', { file_path: 'production/scene-plan.json', old_string: 'a', new_string: 'b' }), [], [], now)).toEqual({ mood: 'storyboarding', line: '编辑 scene-plan.json' });
  expect(crewState(calling('mcp__onset__scene_cues', {}), [], [], now).mood).toBe('storyboarding');
  // 拼接：交给剪辑师。
  expect(crewState(calling('mcp__onset__concat', {}), [], [], now).mood).toBe('editing');
  // 配音命令与音色库：配音演员。
  expect(crewState(calling('Bash', { command: 'edge-tts --text hi' }), [], [], now).mood).toBe('voicing');
  expect(crewState(calling('mcp__onset__voice_list', {}), [], [], now).mood).toBe('voicing');
  // 其他文件编辑与命令。
  expect(crewState(calling('Write', { file_path: 'notes.md' }), [], [], now).mood).toBe('writing');
  expect(crewState(calling('Bash', { command: 'ls -la' }), [], [], now).mood).toBe('running');
});

test('没有进行中的调用就是在想，有待办时说在想哪一条', () => {
  const read = { kind: 'tool-call', call_id: 'r', tool: 'Read', input: { file_path: 'a.md' } };
  const done = { kind: 'tool-result', call_id: 'r', text: 'ok' };
  expect(crewState(turnOf([read, done]), [], [], now)).toEqual({ mood: 'thinking', line: '在想下一步' });
  const plan = { kind: 'plan', plan: [{ text: '读稿子', status: 'completed' }, { text: '正在定风格', status: 'in_progress' }] };
  expect(crewState(turnOf([plan]), [], [], now)).toEqual({ mood: 'thinking', line: '在想：定风格' });
});

test('等批准优先于手上的调用', () => {
  const turn = calling('Bash', { command: 'npm install three' });
  expect(crewState(turn, [{ id: 'a' }], [], now)).toEqual({ mood: 'waiting', line: '等你批准' });
  expect(crewState(turn, [{ id: 'a' }, { id: 'b' }], [], now).line).toBe('有 2 件事等你批准');
});

test('一轮结束后按结果留一会儿收工 / 停下 / 没做成，过了 crewLinger 回到待命', () => {
  const ended = (status) => turnOf([{ kind: 'turn-end', status }]);
  const end = start + 1000;
  expect(crewState(ended('done'), [], [], end + 1000)).toEqual({ mood: 'done', line: '收工' });
  expect(crewState(ended('cancelled'), [], [], end + 1000)).toEqual({ mood: 'stopped', line: '先停在这里' });
  expect(crewState(ended('interrupted'), [], [], end + 1000).mood).toBe('stopped');
  expect(crewState(ended('failed'), [], [], end + 1000)).toEqual({ mood: 'failed', line: '这一轮没做成' });
  expect(crewState(ended('done'), [], [], end + crewLinger + 1)).toBeNull();
});

test('桌宠上选项前面的问话：去掉 choices 代码块，取最后一行', () => {
  expect(choiceQuestion('选一个风格：\n```choices\n深色科技风\n白板手绘风\n```')).toBe('选一个风格：');
  expect(choiceQuestion('## 说明\n\n**挑一个：**')).toBe('挑一个：');
  expect(choiceQuestion('问'.repeat(80))).toHaveLength(60);
});
