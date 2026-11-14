// 单元测试用的假 ACP 编排工具：建会话（或续接时先重放一段历史），收到提示词后推一段正文与一个 shell 工具调用，
// 发 session/request_permission 问 `npm install three`，按回答推工具结果，最后带用量结束这一轮。
// 提示词里有「挂起」时请求权限后不再动，供取消测试使用。
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } });
let nextId = 100;
const waiting = new Map();
const ask = (method, params) => new Promise((resolve) => { const id = nextId++; waiting.set(id, resolve); send({ id, method, params }); });
let promptId = null;
process.stdout.write('not json, a log line\n');
rl.on('line', async (line) => {
  const m = JSON.parse(line);
  if (m.id !== undefined && waiting.has(m.id)) { waiting.get(m.id)(m.result); waiting.delete(m.id); return; }
  switch (m.method) {
    case 'initialize': send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } }); break;
    case 'session/new': send({ id: m.id, result: { sessionId: 'ses_fake', configOptions: [{ id: 'model', category: 'model', currentValue: 'fake/model-1' }] } }); break;
    case 'session/load':
      update(m.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '这是历史，不该出现' } });
      send({ id: m.id, result: null });
      break;
    case 'session/cancel': if (promptId !== null) send({ id: promptId, result: { stopReason: 'cancelled' } }); break;
    case 'session/prompt': {
      promptId = m.id;
      const sid = m.params.sessionId;
      const text = m.params.prompt[0].text;
      update(sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '想一' } });
      update(sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '想' } });
      update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '先装' } });
      update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '依赖。' } });
      update(sid, { sessionUpdate: 'plan', entries: [{ content: '装依赖', status: 'in_progress', priority: 'high' }] });
      update(sid, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'npm install three', kind: 'execute', status: 'pending', rawInput: { command: 'npm install three' } });
      const answer = await ask('session/request_permission', {
        sessionId: sid,
        toolCall: { toolCallId: 't1', title: 'npm install three', kind: 'execute', rawInput: { command: 'npm install three' } },
        options: [{ optionId: 'once', kind: 'allow_once', name: 'Allow' }, { optionId: 'always', kind: 'allow_always', name: 'Always' }, { optionId: 'reject', kind: 'reject_once', name: 'Reject' }],
      });
      if (text.includes('挂起')) return;
      const allowed = answer?.outcome?.optionId === 'once';
      if (!allowed) { send({ id: m.id, result: { stopReason: 'cancelled' } }); return; }
      update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'added 1 package' } }] });
      update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '装好了。' } });
      send({ id: m.id, result: { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 100, cachedWriteTokens: 20, totalTokens: 135 } } });
      break;
    }
    default: if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: 'nope' } });
  }
});
