// 假 claude 的「多题提问」：照 --mcp-config 启动客户端挂的 onset 工具服务（真的 onset studio tools-mcp），
// 发起一次 studio_ask 多题调用，等用户在界面上逐题勾选提交，再把结构化答案打印出来供假 claude 同轮继续回复。
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const config = JSON.parse(process.argv[2]);
const server = config.mcpServers.onset;
const child = spawn(server.command, server.args, {
  env: { ...process.env, ...(server.env ?? {}) },
  stdio: ['pipe', 'pipe', 'inherit'],
});
const rl = readline.createInterface({ input: child.stdout });
const send = (msg) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
send({
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '0' } },
});
for await (const line of rl) {
  const msg = JSON.parse(line);
  if (msg.id === 1) {
    send({ method: 'notifications/initialized' });
    send({
      id: 2,
      method: 'tools/call',
      params: {
        name: 'studio_ask',
        arguments: {
          title: '开工前确认 2 项规格',
          questions: [
            {
              id: 'opening',
              header: '开场方式',
              question: '前 15 秒希望用哪种开场钩子？',
              options: [
                { label: '直接抛核心数据', description: '3 秒直入对比结论', recommended: true },
                { label: '先抛问题留悬念', description: '先铺垫背景再揭示' },
              ],
            },
            {
              id: 'focus',
              header: '重点章节',
              question: '哪些部分需要重点展开？',
              multi_select: true,
              options: [{ label: '架构原理' }, { label: '性能对比' }],
            },
          ],
        },
      },
    });
  } else if (msg.id === 2) {
    process.stdout.write(msg.result.content[0].text);
    child.kill();
    break;
  }
}
