/**
 * 命令开头的 `cd <目录> &&` / `cd <目录>;` 去掉：渲染器（qoder 尤甚）每条命令都先 cd 到镜头或项目目录，
 * 一行只显示得下开头，看到的全是 cd，真正跑的是什么反而看不见。完整命令仍在 `full` 里。
 */
export function strippedCommand(command: string): string {
  let rest = command.trim();
  for (;;) {
    const match = /^cd\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s*(?:&&|;)\s*/.exec(rest);
    if (!match || match[0].length >= rest.length) return rest;
    rest = rest.slice(match[0].length);
  }
}

/** 工具名译成一个动词，配上最能说明「做了什么」的那个参数。 */
export function describeTool(
  tool: string,
  input: unknown,
): { verb: string; target: string; command: boolean; path?: string; full?: string } {
  const record = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const text = (key: string) => (typeof record[key] === 'string' ? (record[key] as string) : '');
  const name = tool.toLowerCase();
  const path = text('file_path') || text('path') || text('filePath') || text('notebook_path');
  if (name === 'bash' || name === 'shell' || name === 'command_execution') {
    const command = text('command') || (Array.isArray(record.command) ? (record.command as string[]).join(' ') : '');
    return { verb: '执行', target: strippedCommand(command), command: true, full: command };
  }
  if (name === 'read') return { verb: '读取', target: path, command: false, path };
  if (name === 'write') return { verb: '创建', target: path, command: false, path };
  if (name === 'edit' || name === 'multiedit' || name === 'notebookedit') {
    return { verb: '编辑', target: path, command: false, path };
  }
  if (name === 'file_change') {
    const changes = Array.isArray(record.changes) ? (record.changes as { path?: string }[]) : [];
    return {
      verb: '改文件',
      target: changes
        .map((c) => c.path)
        .filter(Boolean)
        .join('、'),
      command: false,
    };
  }
  if (name === 'grep' || name === 'glob') return { verb: '搜索', target: text('pattern'), command: false };
  // 制作人（pi）自带的找文件、列目录。
  if (name === 'find') return { verb: '找文件', target: text('pattern') || path, command: false };
  if (name === 'ls') return { verb: '查看目录', target: path, command: false, path };
  if (name === 'webfetch') return { verb: '访问', target: text('url'), command: false };
  if (name === 'websearch' || name === 'web_search') return { verb: '搜索网页', target: text('query'), command: false };
  if (name === 'task' || name === 'agent') return { verb: '子任务', target: text('description'), command: false };
  // onset 的工具：claude 系经 MCP 带 mcp__onset__ 前缀，ACP 带 am_ / onset.，制作人直接用操作名。
  const bare = name.replace(/^mcp__onset__/, '').replace(/^onset[._]/, '');
  if (/^(mcp__onset__|onset[._])/.test(name) || bare in onsetVerbs || bare === 'hyperframes') {
    return onsetTool(bare, record);
  }
  const fallback = text('description') || text('url') || text('pattern') || '';
  return { verb: tool, target: fallback, command: false };
}

/** HyperFrames 子命令说成人话：渲染器大半时间在跑它们。 */
const hyperframesVerbs: Record<string, string> = {
  lint: '检查合成代码',
  check: '检查画面',
  validate: '校验合成',
  snapshot: '截取画面',
  render: '渲染视频',
  inspect: '检查布局',
  timeline: '读取时间线',
  compositions: '列出合成',
  info: '查看合成信息',
  init: '建合成骨架',
};

/** onset 工具服务里常用工具的说法；其余按工具名把下划线换成空格。 */
const onsetVerbs: Record<string, string> = {
  scene_run: '渲染镜头',
  scene_run_all: '渲染全部镜头',
  scene_lint: '检查镜头',
  scene_frames: '抽帧查看',
  scene_frames_batch: '批量抽帧验收',
  scene_preview_check: '检查画面并生成联系表',
  scene_cues: '计算镜头时长',
  scene_prepare: '准备镜头目录',
  scene_seams: '检查镜头接缝',
  scene_usage: '查看渲染用量',
  tool_search: '检索工具',
  tool_call: '调用扩展工具',
  onset_call: '调用扩展工具',
  job_wait: '等任务跑完',
  job_cancel: '取消任务',
  tool_help: '查工具说明',
  concat: '拼接成片',
  review: '复查成片',
  align_build: '生成配音时间轴',
  align_run: '对齐配音和字幕',
  timing_report: '生成时长报告',
  audio_mix: '混音并校验成片',
  audio_patch_voice: '替换局部配音',
  phrase_frames: '生成短语验收证据',
  flow_guide: '查看制作阶段说明',
  inputs_manifest: '核对输入清单',
  align_text: '整理朗读文本',
  audio_check: '校验字幕时间轴',
  validate_reads: '检查阅读时长',
  validate_video: '校验成片',
  validate_publish: '校验发布配置',
  validate_beat: '校验卡点规格',
  validate_song: '校验歌曲规格',
  beat_import: '导入卡点音乐',
  beat_analyze: '分析音乐节拍',
  beat_regrid: '调整节拍网格',
  beat_confirm: '确认节拍网格',
  beat_cues: '计算镜头时长',
  beat_click: '生成节拍试听',
  song_configure: '配置歌曲参数',
  song_generate: '生成歌曲',
  song_import: '导入歌曲',
  song_select: '选定歌曲候选',
  song_prepare: '整理唱词时间轴',
  song_cues: '计算歌曲镜头',
  song_mux: '合成歌曲成片',
  song_handoff: '生成网页制歌交接',
  song_receive: '接收网页歌曲',
  film_style_list: '查看整片风格',
  film_style_use: '换整片风格',
  voice_synthesize: '合成配音',
  voice_list: '查看音色',
  voice_save: '存音色',
  sfx_search: '检索音效',
  sfx_download: '下载音效',
  brand_kit_list: '查看品牌包',
  brand_kit_get: '读取品牌包',
  brand_kit_extract: '提取品牌包',
  brand_kit_apply: '应用品牌包',
  project_export_jianying: '导出剪映草稿',
  media_frame_qc: '自动帧检视频',
  media_generate: '生成多模态素材',
  studio_show: '打开页面',
  studio_step: '标出步骤',
  studio_confirm: '记录关卡确认',
  studio_ask: '请用户确认',
  memory_remember: '记下偏好',
  config_get: '读取配置',
};

/** 内置插件给自己的工具写的说法（/api/stations 的 contents.ops[].verb），由 app.tsx 在读到插件列表后填。 */
const pluginVerbs = new Map<string, string>();

/** 内置插件工具的说法；没登记时为 undefined。 */
export function pluginVerb(name: string): string | undefined {
  return pluginVerbs.get(name);
}

export function setPluginVerbs(entries: { name: string; verb: string }[]): void {
  pluginVerbs.clear();
  for (const e of entries) if (e.verb) pluginVerbs.set(e.name, e.verb);
}

function onsetTool(name: string, record: Record<string, unknown>): { verb: string; target: string; command: boolean } {
  const text = (key: string) => (typeof record[key] === 'string' ? (record[key] as string) : '');
  const args = Array.isArray(record.args) ? (record.args as unknown[]).map(String).join(' ') : '';
  if (name === 'hyperframes') {
    const sub = text('subcommand');
    return { verb: hyperframesVerbs[sub] ?? `HyperFrames ${sub}`.trim(), target: args, command: false };
  }
  if (name === 'job_wait' || name === 'job_cancel')
    return { verb: onsetVerbs[name], target: text('job'), command: false };
  if (name === 'tool_search') {
    const target = text('query') || text('category') || text('tool');
    return { verb: onsetVerbs[name], target, command: false };
  }
  const target =
    text('scene') ||
    text('scene_id') ||
    text('tool') ||
    text('page') ||
    text('key') ||
    text('name') ||
    text('query') ||
    args;
  return { verb: onsetVerbs[name] ?? pluginVerbs.get(name) ?? name.replace(/_/g, ' '), target, command: false };
}
