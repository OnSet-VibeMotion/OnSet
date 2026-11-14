import { TTSProviders } from '../config/providers';
import { MissingError } from '../prereq';
import { runVoice } from './runner';
import { defaultDir } from './dir';
import { list } from './library';

/** 服务音色发现也由宿主管理，模型无需知道各家 CLI。 */
export async function catalog(provider: string, env: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
  if (provider === 'breeze') return { provider, voices: list(defaultDir(env)).map((v) => ({ id: v.name, name: v.name, is_default: v.is_default })) };
  if (provider === 'mlx') return { provider, voices: ['Vivian', 'Serena', 'Uncle_Fu', 'Dylan', 'Eric'] };
  if (provider === 'tencent') return { provider, voices: [], hint: 'voice 使用腾讯云 VoiceType 数字；可沿用项目已确认的音色，完整列表见 https://cloud.tencent.com/document/product/1073/92668' };
  const spec = TTSProviders.find((p) => p.id === provider);
  const commands: Record<string, string[]> = {
    minimax: ['speech', 'voices', '--output', 'json'],
    bailian: ['speech', 'synthesize', '--list-voices', '--model', 'cosyvoice-v3-flash'],
    edge: ['--list-voices'],
    elevenlabs: ['voices', 'search', '--format', 'json'],
  };
  if (!spec || !commands[provider]) throw new MissingError('内置配音服务 ' + provider, '第三方配音请使用插件登记的工具');
  const output = await runVoice(spec.command, commands[provider], env, signal);
  try { return { provider, voices: JSON.parse(output) }; }
  catch { return { provider, voices: output }; }
}
