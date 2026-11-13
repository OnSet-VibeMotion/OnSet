// 单元测试用的假 codex app-server：建或续接会话，turn/start 后推一个 agentMessage、计划、shell 命令（先请批准，
// 命令带 /bin/zsh -lc 包装），按回答推命令结果与用量，再发 turn/completed。
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
const note = (method, params) => send({ method, params });
let nextId = 100;
const waiting = new Map();
const ask = (method, params) => new Promise((resolve) => { const id = nextId++; waiting.set(id, resolve); send({ id, method, params }); });
rl.on('line', async (line) => {
  const m = JSON.parse(line);
  if (m.id !== undefined && waiting.has(m.id)) { waiting.get(m.id)(m.result); waiting.delete(m.id); return; }
  const thread = 'thr_fake';
  switch (m.method) {
    case 'initialize': send({ id: m.id, result: { userAgent: 'fake', platformFamily: 'unix', platformOs: 'macos', codexHome: '/tmp' } }); break;
    case 'initialized': break;
    case 'thread/start':
    case 'thread/resume':
      process.stderr.write(JSON.stringify({ settings: m.params }) + '\n');
      send({ id: m.id, result: { thread: { id: thread }, model: 'gpt-fake', approvalPolicy: m.params.approvalPolicy, sandbox: m.params.sandbox } });
      break;
    case 'turn/start': {
      const turn = 'turn_1';
      send({ id: m.id, result: { turn: { id: turn, status: 'inProgress' } } });
      note('item/completed', { threadId: thread, turnId: turn, item: { type: 'agentMessage', id: 'a1', text: '先装依赖。' } });
      note('turn/plan/updated', { threadId: thread, turnId: turn, plan: [{ step: '装依赖', status: 'inProgress' }] });
      const answer = await ask('item/commandExecution/requestApproval', { threadId: thread, turnId: turn, itemId: 'c1', command: "/bin/zsh -lc 'npm install three'", startedAtMs: 1 });
      const ok = answer?.decision === 'accept';
      note('item/started', { threadId: thread, turnId: turn, item: { type: 'commandExecution', id: 'c1', command: "/bin/zsh -lc 'npm install three'", status: 'inProgress' } });
      note('item/completed', { threadId: thread, turnId: turn, item: { type: 'commandExecution', id: 'c1', command: "/bin/zsh -lc 'npm install three'", status: ok ? 'completed' : 'declined', exitCode: ok ? 0 : 1, aggregatedOutput: ok ? 'added 1 package' : '' } });
      note('thread/tokenUsage/updated', { threadId: thread, turnId: turn, tokenUsage: { last: { inputTokens: 50, cachedInputTokens: 40, outputTokens: 5, reasoningOutputTokens: 0, totalTokens: 55 }, total: { inputTokens: 1050, cachedInputTokens: 840, outputTokens: 105, reasoningOutputTokens: 0, totalTokens: 1155 } } });
      note('thread/tokenUsage/updated', { threadId: thread, turnId: turn, tokenUsage: { last: { inputTokens: 30, cachedInputTokens: 20, outputTokens: 3, reasoningOutputTokens: 0, totalTokens: 33 }, total: { inputTokens: 1080, cachedInputTokens: 860, outputTokens: 108, reasoningOutputTokens: 0, totalTokens: 1188 } } });
      note('turn/completed', { threadId: thread, turn: { id: turn, status: process.env.FAKE_TURN_FAIL ? 'failed' : 'completed', error: process.env.FAKE_TURN_FAIL ? { message: '模型请求失败' } : null } });
      break;
    }
    default: if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: 'nope' } });
  }
});
