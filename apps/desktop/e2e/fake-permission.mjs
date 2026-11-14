// 假 claude 的「要批准」：照 --mcp-config 启动客户端挂的审批服务（真的 onset studio permission-mcp），
// 像 claude 一样发一次 tools/call，等用户在界面上回答，把结果原样打印出来。
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const config = JSON.parse(process.argv[2]);
const [server] = Object.values(config.mcpServers);
const child = spawn(server.command, server.args, { stdio: ['pipe', 'pipe', 'inherit'] });
const rl = readline.createInterface({ input: child.stdout });
const send = (msg) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '0' } } });
for await (const line of rl) {
  const msg = JSON.parse(line);
  if (msg.id === 1) {
    send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'tools/call', params: { name: 'ask', arguments: { tool_name: 'Bash', input: { command: 'npm install three', description: '安装 three.js' } } } });
  } else if (msg.id === 2) {
    process.stdout.write(msg.result.content[0].text);
    child.kill();
    break;
  }
}
