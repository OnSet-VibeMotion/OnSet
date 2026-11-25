/**
 * 基础零版权质感/转场音效生成与 Freesound 音效检索下载操作（仅编排端可见，渲染器严禁暴露）：
 * - assets_generate_base：按需程序化生成 3 张 SVG 纹理 + 2 条 48kHz 16-bit WAV 基础音效到 assets/builtin/
 * - sfx_search：通过 Freesound API v2 按关键词、时长区间与许可证（CC0/CC-BY 等）检索音效
 * - sfx_download：下载指定 Freesound 音效到 assets/sfx/，计算 RMS 与经真峰值夹取的 safe_gain_db 并登记清单
 */
import * as baseassets from '@onset/engine/baseassets';
import * as freesound from '@onset/engine/freesound';
import { formatFixed } from '@onset/engine/gofmt';
import { currentEnvironment } from './cli';
import { defineGroup } from './ops/cli';
import { bool, num, projectRoot, str, strs } from './ops/common';
import { defineOp, isParamProvided, ParamError } from './ops/op';

defineGroup({
  path: ['assets'],
  summary: '内置零版权（MIT）基础质感与基础音效素材',
  description: '纯算法按需生成项目基础 SVG 质感素材（暖纸/胶片颗粒/工程网格）与 48kHz WAV 转场音效，不覆盖用户修改。',
});

defineGroup({
  path: ['sfx'],
  summary: 'Freesound 音效检索、下载与安全增益分析',
  description:
    '通过纯 TypeScript 调用 Freesound API v2 检索并下载音效到 assets/sfx/，自动计算经真峰值防削波夹取的安全增益。',
});

const ValidSortValues = new Set<freesound.FreesoundSort>([
  'score',
  'duration_desc',
  'duration_asc',
  'created_desc',
  'created_asc',
  'downloads_desc',
  'rating_desc',
]);

const ValidQualities = new Set<freesound.FreesoundDownloadQuality>([
  'preview-hq-mp3',
  'preview-hq-ogg',
  'preview-lq-mp3',
  'original',
]);

defineOp({
  name: 'assets_generate_base',
  cli: ['assets', 'generate-base'],
  summary: '在项目中程序化生成零版权（MIT）基础质感 SVG 与基础转场 WAV 音效',
  description:
    '按需确定性生成 3 张 SVG 纹理（paper.svg 暖纸纹理、grain.svg 胶片颗粒、grid.svg 工程参考网格）与 2 条 48kHz 16-bit 立体声 WAV 音效（whoosh.wav、impact.wav，无直流偏移、真峰值 ≤ -1.0 dBTP）落盘至 assets/builtin/ 并写出 manifest.json；默认保护已被用户手动修改的同名文件。',
  examples: [
    'assets_generate_base({"project_root": "."})',
    'assets_generate_base({"project_root": ".", "only": ["paper", "whoosh"]})',
  ],
  params: {
    project_root: projectRoot,
    force: { type: 'boolean', description: '强制覆盖已被用户手动修改的同名内置素材（默认 false）', default: false },
    only: { type: 'strings', description: '可选：仅生成指定 ID（paper / grain / grid / whoosh / impact）' },
  },
  run: (p, { out }) => {
    const root = str(p.project_root) || '.';
    const onlyList = strs(p.only);
    const res = baseassets.generateBaseAssets(root, {
      force: bool(p.force),
      only: onlyList.length > 0 ? onlyList : undefined,
    });
    out.write(
      `基础零版权（${res.license}）素材已就绪：新建 ${res.created_count}、未变 ${res.unchanged_count}、保留用户修改 ${res.preserved_count}、覆盖 ${res.overwritten_count}。\n`,
    );
    for (const item of res.assets) {
      const peakInfo =
        item.true_peak_dbtp !== undefined
          ? `，时长 ${formatFixed(item.duration_seconds ?? 0, 2)}s，真峰 ${formatFixed(item.true_peak_dbtp, 2)} dBTP`
          : '';
      out.write(`  - [${item.status}] ${item.file}（${item.bytes} 字节${peakInfo}）\n`);
    }
    out.write(`清单：${res.manifest_rel_path}\n`);
    return { data: res };
  },
});

defineOp({
  name: 'sfx_search',
  cli: ['sfx', 'search'],
  summary: '通过 Freesound API v2 检索音效（支持时长范围与 CC0/CC-BY 许可过滤）',
  description:
    '使用环境变量 FREESOUND_API_KEY 调用 Freesound API v2 检索音效，支持按关键词、最小时长/最大时长与许可证（如 CC0、CC-BY、CC0,CC-BY）过滤。返回音效 ID、时长、作者、许可证与预览地址，供 sfx_download 下载。',
  examples: [
    'sfx_search({"query": "whoosh transition", "max_duration": 2, "license": "CC0", "limit": 5})',
    'sfx_search({"query": "ui click", "min_duration": 0.1, "max_duration": 1.5, "license": "CC0,CC-BY"})',
  ],
  params: {
    query: {
      type: 'string',
      description: '检索关键词（建议英文描述，如 "whoosh transition"）',
      required: true,
      positional: 0,
    },
    min_duration: { type: 'number', description: '可选：最小时长（秒）' },
    max_duration: { type: 'number', description: '可选：最大时长（秒）' },
    license: { type: 'string', description: '可选：许可证过滤（CC0 / CC-BY / CC-BY-NC / CC0,CC-BY / any）' },
    limit: { type: 'integer', description: '返回条数上限（默认 10，最大 50）', default: freesound.DefaultSearchLimit },
    page: { type: 'integer', description: '分页页码（从 1 起）', default: 1 },
    sort: {
      type: 'string',
      description: '排序方式（score / duration_asc / duration_desc / downloads_desc / rating_desc / created_desc）',
      default: 'score',
    },
  },
  run: async (p, { out, signal }) => {
    const query = str(p.query).trim();
    if (!query) throw new ParamError('sfx_search 的 query 不能为空');
    const sortRaw = str(p.sort).trim() || 'score';
    if (!ValidSortValues.has(sortRaw as freesound.FreesoundSort)) {
      throw new ParamError(`不支持的排序方式：${sortRaw}（可选：${[...ValidSortValues].join('、')}）`);
    }
    const minDuration = isParamProvided(p, 'min_duration') ? num(p.min_duration) : undefined;
    const maxDuration = isParamProvided(p, 'max_duration') ? num(p.max_duration) : undefined;
    const res = await freesound.searchSounds({
      query,
      minDuration,
      maxDuration,
      license: str(p.license).trim() || undefined,
      limit: num(p.limit) || freesound.DefaultSearchLimit,
      page: num(p.page) || 1,
      sort: sortRaw as freesound.FreesoundSort,
      env: currentEnvironment(),
      signal,
    });
    out.write(`Freesound 检索「${res.query}」命中 ${res.count} 条（本次返回 ${res.results.length} 条）：\n`);
    for (const item of res.results) {
      out.write(
        `  - #${item.id} ${item.name}（${formatFixed(item.duration, 2)}s，${item.license_short}，作者 ${item.username}）\n`,
      );
    }
    return { data: res };
  },
});

defineOp({
  name: 'sfx_download',
  cli: ['sfx', 'download'],
  summary: '下载 Freesound 音效到 assets/sfx/ 并输出真峰值防削波安全建议增益',
  description:
    '根据 Freesound 音效 ID 下载音频到项目的 assets/sfx/（按 SHA-256 去重），写入含来源 URL、作者与许可证归属的 assets/sfx/audio-manifest.json，并测量实测 RMS、样本峰值、真峰值及经真峰值夹取后的安全建议增益 safe_gain_db（保证 sample_peak_db + safe_gain_db ≤ -1.0 dBFS）。',
  examples: [
    'sfx_download({"sound_id": 12345, "project_root": "."})',
    'sfx_download({"sound_id": 12345, "name": "card-pop", "target_rms_db": -16, "ceiling_db": -1})',
  ],
  params: {
    sound_id: { type: 'integer', description: 'Freesound 音效 ID（正整数）', required: true, positional: 0 },
    project_root: projectRoot,
    quality: {
      type: 'string',
      description: '下载流选择（preview-hq-mp3 / preview-hq-ogg / preview-lq-mp3 / original）',
      default: 'preview-hq-mp3',
    },
    name: { type: 'string', description: '可选：落盘文件名前缀（自动清洗非法路径字符）' },
    target_rms_db: {
      type: 'number',
      description: '目标 RMS 电平（dBFS，默认 -16）',
      default: freesound.DefaultTargetRmsDB,
    },
    ceiling_db: {
      type: 'number',
      description: '真峰值与样本峰值上限（dBFS，默认 -1.0）',
      default: freesound.DefaultPeakCeilingDB,
    },
  },
  run: async (p, { out, signal }) => {
    const soundId = num(p.sound_id);
    if (!Number.isSafeInteger(soundId) || soundId <= 0) {
      throw new ParamError(`sound_id 必须是正整数，收到 ${String(p.sound_id)}`);
    }
    const qualityRaw = (str(p.quality).trim() || 'preview-hq-mp3') as freesound.FreesoundDownloadQuality;
    if (!ValidQualities.has(qualityRaw)) {
      throw new ParamError(`不支持的 quality：${qualityRaw}（可选：${[...ValidQualities].join('、')}）`);
    }
    const root = str(p.project_root) || '.';
    const targetRmsDb = isParamProvided(p, 'target_rms_db') ? num(p.target_rms_db) : freesound.DefaultTargetRmsDB;
    const ceilingDb = isParamProvided(p, 'ceiling_db') ? num(p.ceiling_db) : freesound.DefaultPeakCeilingDB;
    const res = await freesound.downloadSound(soundId, root, {
      quality: qualityRaw,
      name: str(p.name).trim() || undefined,
      targetRmsDb,
      ceilingDb,
      env: currentEnvironment(),
      signal,
    });
    const tag = res.deduplicated ? '（已命中 SHA-256 去重，复用本地文件）' : '';
    const g = res.entry.gain;
    out.write(`已就绪音效 #${res.entry.freesound_id}：${res.entry.file}${tag}\n`);
    out.write(`归属：${res.entry.attribution}\n`);
    if (g.measured) {
      out.write(
        `响度与安全增益：RMS ${formatFixed(g.rms_db, 2)} dBFS，样本峰值 ${formatFixed(g.sample_peak_db, 2)} dBFS，` +
          `真峰值 ${formatFixed(g.true_peak_dbtp, 2)} dBTP，原建议 ${formatFixed(g.suggested_gain_db, 2)} dB → ` +
          `安全建议 safe_gain_db=${formatFixed(g.safe_gain_db, 2)} dB\n`,
      );
      if (g.clipping_warning) out.write(`警告：${g.clipping_warning}\n`);
    } else if (g.note) {
      out.write(`提示：${g.note}\n`);
    }
    out.write(`清单：${freesound.SfxAssetsRelDir}/${freesound.SfxManifestFile}\n`);
    return { data: res };
  },
});
