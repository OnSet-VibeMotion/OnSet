// 移植自 internal/song/platforms.go。
import fs from 'node:fs';
import path from 'node:path';
import { isMap, isScalar, parseAllDocuments, Scalar, type Pair } from 'yaml';
import { atomicWrite } from '../fsutil';
import { goPathError, goTrimSpace } from '../gofmt';
import { decodeConfig, localPath, withLock } from './store';
import type { Config } from './types';

/** 对应 Go 的 io.Writer：Node 的 Writable 与测试里的收集器都满足。 */
export interface Writer {
  write(chunk: string): unknown;
}

export interface Platform {
  id: string;
  name: string;
  model: string;
  key: string;
  console: string;
  docs: string;
  notes: string;
}

function platform(id: string, name: string, model: string, key: string, console: string, docs: string, notes: string): Platform {
  return { id, name, model, key, console, docs, notes };
}

export const Platforms: Platform[] = [
  platform('manual', '网页手动生成 / 导入歌曲', 'external', '', '由用户选择歌曲生成网页', 'am song handoff --help', '无需 API Key；输出歌词和曲风说明后暂停，用户在网页生成并提供音频，再运行 am song receive AUDIO。'),
  platform('mureka', 'Mureka 官方 API', 'mureka-9.5', 'MUREKA_API_KEY', 'https://platform.mureka.ai/', 'https://platform.mureka.ai/docs/en/quickstart.html', '支持中文及自带歌词；API 单独充值，与网页会员不互通。每次请求一首，按任务 ID 续跑；时长/BPM 仅作为创作提示。'),
  platform('lyria', 'Google Lyria', 'lyria-3.5', 'GEMINI_API_KEY', 'https://aistudio.google.com/api-keys', 'https://ai.google.dev/gemini-api/docs/music-generation', '需 Gemini API 项目及对应模型权限/计费；使用 Interactions API 指定歌词。目标时长与 BPM 是提示，需试听核对是否改词；同步请求中断不自动重发。'),
  platform('bailian', '阿里云百炼 Fun-Music', 'fun-music-v1', 'DASHSCOPE_API_KEY', 'https://bailian.console.aliyun.com/', 'https://help.aliyun.com/zh/model-studio/fun-music-api', '需北京地域 Fun-Music 邀测权限及普通按量 API Key；当前 Token Plan 清单未包含音乐。指定歌词时曲风提示被忽略，时长/BPM 不作为 API 控制参数。'),
  platform('elevenlabs', 'ElevenLabs Music', 'music_v2_5', 'ELEVENLABS_API_KEY', 'https://elevenlabs.io/app/developers/api-keys', 'https://elevenlabs.io/docs/api-reference/music/compose', '需有 Music API 权限及可用付费额度；使用固定歌词 composition_plan，曲风建议用英文。'),
  platform('fal', 'fal 托管 ACE-Step', 'fal-ai/ace-step', 'FAL_KEY', 'https://fal.ai/dashboard/keys', 'https://fal.ai/models/fal-ai/ace-step/api', '无需自建服务器；使用 fal 队列协议，不能填到自建 ACE-Step endpoint；不宣称该模型为 ACE-Step 1.5。'),
  platform('minimax', 'MiniMax（mmx）', 'music-3.0', '', 'https://www.minimax.io/audio', 'https://platform.minimax.io/docs/api-reference/music-generation', '复用 mmx 登录；已实测部分账户返回 HTTP 410（音乐 API 不再向新用户开放）。登录成功不等于音乐权限可用。'),
  platform('acestep', '自建/远端 ACE-Step', 'acestep-v15-turbo', 'ACESTEP_API_KEY', 'https://github.com/ace-step/ACE-Step-1.5', 'https://github.com/ace-step/ACE-Step-1.5/blob/main/docs/en/API.md', '必须已有可访问服务地址；密钥按服务设置，可为空。不自动部署模型。'),
];

const emptyPlatform: Platform = platform('', '', '', '', '', '', '');

export function providerInfo(id: string): Platform {
  return Platforms.find((p) => p.id === id) ?? emptyPlatform;
}

export function knownProvider(id: string): boolean {
  return providerInfo(id).id !== '';
}

export function platformGuide(out: Writer, id: string, env: Record<string, string> | null): void {
  if (id !== '' && !knownProvider(id)) throw new Error('未知歌曲平台；运行 am song providers 查看支持清单');
  for (const p of Platforms) {
    if (id !== '' && id !== p.id) continue;
    if (p.id === 'manual') out.write(`\n${p.name} [${p.id}]\n  ${p.notes}\n`);
    else out.write(`\n${p.name} [${p.id}]\n  默认模型：${p.model}\n  ${p.notes}\n  开通/密钥：${p.console}\n  API 文档：${p.docs}\n`);
    if (p.key !== '') {
      let status = '未设置';
      if (goTrimSpace(env?.[p.key] ?? '') !== '') status = '已设置（未验证权限/额度）';
      out.write(
        `  ${p.key}：${status}\n  在本机终端设置环境变量（不要填入 song.yaml）：\n    export ${p.key}='<你的 API Key>'\n  am run 嵌套调用还需显式透传（保留已有列表）：\n    export AM_PASSTHROUGH_ENV="\${AM_PASSTHROUGH_ENV:+\${AM_PASSTHROUGH_ENV},}${p.key}"\n`,
      );
    } else if (p.id === 'manual') {
      out.write('  写好歌词后运行 am song handoff；上传生成的音频或提供本机路径后继续。\n');
    } else {
      out.write('  按 mmx auth --help 完成登录。\n');
    }
    let extra = '';
    if (p.id === 'bailian') extra = ' --workspace YOUR_WORKSPACE_ID';
    if (p.id === 'acestep') extra = ' --endpoint https://YOUR_SERVER';
    out.write(`  配置：am song configure --provider ${p.id}${extra}\n`);
  }
  if (id === 'manual') {
    out.write('\n流程：编写歌词/曲风 → am song handoff → 等待用户提供音频 → am song receive AUDIO → 用户确认 → am song select ID → am song prepare。网页模式无需 API Key。\n');
    return;
  }
  out.write(
    '\n配置后：am song doctor → 编写 lyrics.txt → am song generate --count 1 → 试听后 am song select <id>。\n配置和密钥检查不会产生生成费用，也不会验证账户额度。外部歌曲可用 am song import 导入。\n',
  );
}

const workspacePattern = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/;

export function validateHostedConfig(c: Config): void {
  if (c.workspace !== '' && c.provider !== 'bailian') throw new Error('workspace 仅适用于百炼；切换平台请用 am song configure');
  switch (c.provider) {
    case 'bailian':
    case 'elevenlabs':
    case 'fal':
    case 'mureka':
    case 'lyria':
    case 'manual':
      if (c.endpoint !== '') throw new Error('托管平台不接受自定义 endpoint；am song configure 可清理旧服务地址');
  }
  switch (c.provider) {
    case 'manual':
      if (c.model !== 'external') throw new Error('manual 模式 model 必须为 external，具体网页模型由用户选择');
      break;
    case 'mureka':
      if (!['mureka-7.6', 'mureka-o2', 'mureka-8', 'mureka-9', 'mureka-9.5'].includes(c.model)) {
        throw new Error('歌曲平台 Mureka 请指定固定模型：mureka-7.6|mureka-o2|mureka-8|mureka-9|mureka-9.5');
      }
      break;
    case 'lyria':
      if (c.model !== 'lyria-3.5') throw new Error('歌曲平台 Lyria 整曲模式当前支持 lyria-3.5');
      break;
    case 'bailian':
      if (!workspacePattern.test(c.workspace)) {
        throw new Error('百炼需要北京业务空间 ID：am song configure --provider bailian --workspace YOUR_WORKSPACE_ID');
      }
      if (c.model !== 'fun-music-v1' && c.model !== 'fun-music-preview') throw new Error('百炼音乐模型仅支持 fun-music-v1 或 fun-music-preview');
      break;
    case 'elevenlabs':
      if (c.model !== 'music_v2' && c.model !== 'music_v2_5') throw new Error('ElevenLabs chunks 接口仅支持 music_v2 或 music_v2_5');
      break;
    case 'fal':
      if (c.model !== 'fal-ai/ace-step') throw new Error('fal 当前适配模型为 fal-ai/ace-step');
      break;
  }
}

export function checkCredential(c: Config, env: Record<string, string> | null): void {
  const p = providerInfo(c.provider);
  if (p.key === '' || c.provider === 'acestep') return;
  const key = goTrimSpace(env?.[p.key] ?? '');
  if (key === '') throw new Error(`缺少 ${p.key}；运行 am song providers ${p.id} 查看申请及配置步骤；am run 需通过 AM_PASSTHROUGH_ENV 透传`);
  if (c.provider === 'bailian' && key.startsWith('sk-sp-')) {
    throw new Error('Fun-Music 不支持 Token Plan 专用 Key，请配置北京地域普通 DASHSCOPE_API_KEY');
  }
}

/**
 * configure edits only platform fields, preserving user lyrics/style and YAML comments.
 * The whole proposed file is validated before the atomic replacement.
 */
export function configure(root: string, provider: string, model: string, workspace: string, endpoint: string): void {
  if (!knownProvider(provider)) throw new Error('必须指定 --provider；运行 am song providers 查看支持清单');
  withLock(root, () => {
    const file = localPath(root, 'song.yaml');
    let b: string;
    try {
      b = fs.readFileSync(file, 'utf8');
    } catch (err) {
      throw new Error(`请先运行 am song init：${goPathError('open', file, err)}`, { cause: err });
    }
    let docs;
    try {
      docs = parseAllDocuments(b, { keepSourceTokens: false });
    } catch {
      throw new Error('song.yaml 格式无效');
    }
    if (!Array.isArray(docs) || docs.length === 0) throw new Error('song.yaml 格式无效');
    const doc = docs[0];
    if (doc.errors.length > 0 || !isMap(doc.contents)) throw new Error('song.yaml 格式无效');
    if (docs.length > 1) throw new Error('song.yaml 只能包含一份配置');
    if (model === '') model = providerInfo(provider).model;
    const replacements = new Map<string, string>([
      ['provider', provider],
      ['model', model],
      ['workspace', workspace],
      ['endpoint', endpoint],
    ]);
    const node = doc.contents as unknown as { items: Pair[] };
    const fields: Pair[] = [];
    for (const pair of node.items) {
      const key = isScalar(pair.key) ? String(pair.key.value) : '';
      if (replacements.has(key)) {
        const value = replacements.get(key)!;
        replacements.delete(key);
        if (value === '') continue;
        if (isScalar(pair.value)) {
          pair.value.value = value;
          pair.value.tag = undefined;
        } else {
          pair.value = new Scalar(value);
        }
      }
      fields.push(pair);
    }
    node.items = fields;
    for (const k of ['provider', 'model', 'workspace', 'endpoint']) {
      const v = replacements.get(k);
      if (v) node.items.push(doc.createPair(k, v));
    }
    const encoded = doc.toString({ indent: 2, lineWidth: 0 });
    // Validate against the real project root (including lyrics path and cast checks).
    decodeConfig(root, Buffer.from(encoded));
    const info = fs.statSync(path.join(root, 'song.yaml'));
    atomicWrite(file, encoded, info.mode & 0o777);
  });
}
