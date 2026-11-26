/**
 * 渲染前静态「引擎契约硬门禁」（独立于 rules.ts，避免影响 rules_ids 与记忆标签表）。
 *
 * 读取当前镜头生效的整片风格元数据中的 engine_contract：
 * - threejs：必须真实引入/使用 three / THREE；若缺失（或用 CSS preserve-3d/perspective/rotateX/rotateY 伪装）返回阻断级 error；
 * - webgl2：必须真实调用 getContext('webgl2'/'webgl') 或 WebGL shader 编译；若缺失（或用 CSS backdrop-filter/filter: blur 伪装）返回阻断级 error；
 * - canvas2d：缺失 getContext('2d') 时返回非阻断 warning；
 * - 显式偏离豁免：源码顶部注释（// onset-engine-deviation: <engine> -> <replacement> | reason: <理由>）或镜头配置声明后，
 *   将 error 降级为带理由留痕的 warning 放行。
 * - 无 engine_contract 的老风格 0 影响、100% 向后兼容。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  type EngineContract,
  type EngineKind,
  find as findFilmStyle,
  ManifestFile,
  NoFilmStyle,
  readManifest,
  SkillName,
  SkillsSubdir,
  styleDirOf,
} from '../filmstyle';
import {
  analyzeContractFiles,
  collectConfigDeviations,
  type EngineDeviation,
  type EngineSignals,
} from './engine_contract_scan';
import { scan } from './scan';

export type { EngineDeviation } from './engine_contract_scan';

export interface EngineContractIssue {
  engine: EngineKind;
  severity: 'error' | 'warn';
  code: string;
  message: string;
  disguise?: string[];
  deviation?: EngineDeviation;
}

export interface EngineContractReport {
  ok: boolean;
  style_key: string;
  contract: EngineContract | null;
  files: string[];
  errors: EngineContractIssue[];
  warnings: EngineContractIssue[];
  deviations: EngineDeviation[];
}

export interface EngineContractOptions {
  /** 镜头 scene.json 的 film_style 原值（空=默认风格，none=不用风格，"来源/目录名"=点名风格）。 */
  filmStyle?: string;
  /** 已展开的待检源码相对路径（通常复用 determinism.scan 的 files）；不传时内部自动发现。 */
  files?: readonly string[];
  /** 显式传入的引擎契约（主要用于单测或上层已解析时复用）；未传时从生效风格自动解析。 */
  contract?: EngineContract | null;
  /** 显式传入的偏离豁免（字符串、对象或数组）。 */
  deviation?: unknown;
}

const validEngines = new Set<EngineKind>(['threejs', 'webgl2', 'canvas2d']);

function parseContractObject(raw: unknown): EngineContract | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.required)) return null;
  const required = obj.required.filter(
    (v): v is EngineKind => typeof v === 'string' && validEngines.has(v as EngineKind),
  );
  if (required.length === 0) return null;
  const severity =
    obj.severity === 'error' || obj.severity === 'warn'
      ? obj.severity
      : required.includes('canvas2d')
        ? 'warn'
        : 'error';
  return { required, severity, ...(typeof obj.note === 'string' && obj.note ? { note: obj.note } : {}) };
}

function readJSONObject(file: string): Record<string, unknown> | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function ancestorDirs(startDir: string): string[] {
  const dirs: string[] = [];
  let cur = path.resolve(startDir);
  while (true) {
    dirs.push(cur);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return dirs;
}

/** 定位镜头生效的风格目录与风格标识（来源/目录名），并读取其 engine_contract。 */
export function resolveSceneEngineContract(
  sceneDir: string,
  filmStyleInput?: string,
): { styleKey: string; contract: EngineContract | null } {
  const sceneMeta = readJSONObject(path.join(sceneDir, 'scene.json'));
  const filmStyle =
    filmStyleInput !== undefined
      ? filmStyleInput
      : typeof sceneMeta?.film_style === 'string'
        ? sceneMeta.film_style
        : '';
  if (filmStyle === NoFilmStyle) return { styleKey: '', contract: null };

  let styleDir = '';
  let key = '';
  if (filmStyle !== '') {
    key = filmStyle;
    for (const dir of ancestorDirs(sceneDir)) {
      try {
        const found = styleDirOf(dir, filmStyle);
        if (found) {
          styleDir = found;
          break;
        }
      } catch {
        // 非「来源/目录名」或该层无此风格，继续向上查。
      }
    }
  } else {
    for (const dir of ancestorDirs(sceneDir)) {
      const candidate = path.join(dir, SkillsSubdir, SkillName);
      const manifest = readManifest(path.join(candidate, ManifestFile));
      if (manifest && manifest.source && manifest.slug) {
        styleDir = candidate;
        key = `${manifest.source}/${manifest.slug}`;
        break;
      }
    }
  }

  if (styleDir) {
    const styleJson = readJSONObject(path.join(styleDir, 'style.json'));
    const fromFile = parseContractObject(styleJson?.engine_contract);
    if (fromFile) return { styleKey: key, contract: fromFile };
  }
  if (key) {
    const match = findFilmStyle(key);
    if (match.ok && match.style?.engine_contract) {
      return { styleKey: `${match.style.source}/${match.style.slug}`, contract: match.style.engine_contract };
    }
  }
  return { styleKey: key, contract: null };
}

function findMatchingDeviation(
  engine: EngineKind,
  deviations: readonly EngineDeviation[],
): EngineDeviation | undefined {
  return deviations.find((d) => d.engine === engine || d.engine === '*');
}

function evaluateEngine(
  engine: EngineKind,
  contract: EngineContract,
  signals: EngineSignals,
): EngineContractIssue | null {
  const defaultSeverity: 'error' | 'warn' = engine === 'canvas2d' ? 'warn' : contract.severity;
  if (engine === 'threejs' && !signals.hasThree) {
    const disguise = [...signals.fake3dHits].slice(0, 5);
    const base =
      disguise.length > 0
        ? `风格引擎契约要求 Three.js 真 3D 渲染，但源码未引入/使用 three/THREE，反而检测到 CSS 伪 3D 写法（${disguise.join('、')}）；禁止用 CSS 冒充 3D`
        : '风格引擎契约要求 Three.js 真 3D 渲染，但源码未检测到 three 模块引入或 THREE API 调用';
    return {
      engine,
      severity: defaultSeverity,
      code: 'engine-contract.threejs',
      message: base,
      ...(disguise.length ? { disguise } : {}),
    };
  }
  if (engine === 'webgl2' && !signals.hasWebGL2) {
    const disguise = [...signals.fakeShaderHits].slice(0, 5);
    const base =
      disguise.length > 0
        ? `风格引擎契约要求 WebGL2 / 着色器渲染，但源码未调用 getContext('webgl2') 或 WebGL shader，反而检测到 CSS 滤镜伪装（${disguise.join('、')}）`
        : "风格引擎契约要求 WebGL2 / 着色器渲染，但源码未检测到 getContext('webgl2') 或 WebGL shader 编译调用";
    return {
      engine,
      severity: defaultSeverity,
      code: 'engine-contract.webgl2',
      message: base,
      ...(disguise.length ? { disguise } : {}),
    };
  }
  if (engine === 'canvas2d' && !signals.hasCanvas2D) {
    return {
      engine,
      severity: 'warn',
      code: 'engine-contract.canvas2d',
      message: "风格引擎契约建议使用 Canvas2D 逐帧绘制，但源码未检测到 getContext('2d')（疑似退化为纯 SVG/DOM 拼贴）",
    };
  }
  return null;
}

/** 格式化引擎契约违规条目，用于 VerificationError 与终端输出。 */
export function formatEngineContractIssue(issue: EngineContractIssue): string {
  const tag = issue.severity === 'error' ? '引擎契约拦截' : '引擎契约提醒';
  if (issue.deviation) {
    return `${tag} [${issue.code}] 已按显式偏离声明降级放行（${issue.deviation.engine} -> ${issue.deviation.replacement}，理由：${issue.deviation.reason}，出处：${issue.deviation.source}）`;
  }
  return `${tag} [${issue.code}] ${issue.message}（若确需偏离请在源码顶部写 // onset-engine-deviation: ${issue.engine} -> <替代方案> | reason: <理由>）`;
}

/** 对单个镜头目录执行渲染前静态引擎契约检查。 */
export function checkEngineContract(sceneDir: string, opts: EngineContractOptions = {}): EngineContractReport {
  const root = path.resolve(sceneDir);
  const resolved =
    opts.contract !== undefined
      ? { styleKey: opts.filmStyle ?? '', contract: opts.contract }
      : resolveSceneEngineContract(root, opts.filmStyle);
  if (!resolved.contract) {
    return {
      ok: true,
      style_key: resolved.styleKey,
      contract: null,
      files: [],
      errors: [],
      warnings: [],
      deviations: [],
    };
  }
  const files = opts.files ? [...opts.files] : scan(root).files;
  if (files.length === 0) {
    return {
      ok: true,
      style_key: resolved.styleKey,
      contract: resolved.contract,
      files: [],
      errors: [],
      warnings: [],
      deviations: [],
    };
  }

  const signals: EngineSignals = {
    hasThree: false,
    hasWebGL2: false,
    hasCanvas2D: false,
    fake3dHits: new Set(),
    fakeShaderHits: new Set(),
    deviations: [],
  };
  collectConfigDeviations(opts.deviation, 'options', signals.deviations);
  const sidecar = readJSONObject(path.join(root, 'engine-deviation.json'));
  if (sidecar) collectConfigDeviations(sidecar, 'engine-deviation.json', signals.deviations);

  analyzeContractFiles(root, files, signals);

  const errors: EngineContractIssue[] = [];
  const warnings: EngineContractIssue[] = [];
  for (const engine of resolved.contract.required) {
    const issue = evaluateEngine(engine, resolved.contract, signals);
    if (!issue) continue;
    const deviation = findMatchingDeviation(engine, signals.deviations);
    if (issue.severity === 'error' && deviation) {
      warnings.push({
        ...issue,
        severity: 'warn',
        deviation,
        message: `${issue.message}（已显式声明偏离：${deviation.engine} -> ${deviation.replacement}，理由：${deviation.reason}）`,
      });
    } else if (issue.severity === 'error') {
      errors.push(issue);
    } else {
      warnings.push(deviation ? { ...issue, deviation } : issue);
    }
  }
  return {
    ok: errors.length === 0,
    style_key: resolved.styleKey,
    contract: resolved.contract,
    files,
    errors,
    warnings,
    deviations: signals.deviations,
  };
}
