/**
 * 内置插件「发布」（publishing）：按发布平台出封面、写标题简介话题、整理发布信息并校验。
 * 开关、名字与说明在 assets/plugins/publishing/am-station.json；制作提示词的段落在同目录的 sections/（口播与卡点各有一版的带 -beat）。
 * 这里登记它的全部代码：站（路线上的「封面与发布信息」、判断函数、提示词段落）、validate_publish 操作、
 * 发布页、/api/publish 接口与「检查发布信息」命令。宿主里没有按名字写的「发布」特判。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { BuiltinPlugin, JudgeContext } from '../../plugin/types';
import { formatV } from '../../validate/yamlany';
import { publishAPI } from './api';
import { publish, readPublish } from './publish';

export { coverSpecs, minCoverShortSide, parseRatio, platformName, validateCoverImages, type CoverSpec } from './cover_images';
export { titleLimits, validateCopyTitles } from './copy_titles';
export { publishAPI } from './api';
export { publish, readPublish } from './publish';

/** publish.md 的发布状态；没有这个文件为空串，读不出状态算草稿。 */
export function publishStatus(root: string): string {
  const file = path.join(root, 'publish.md');
  try {
    fs.statSync(file);
  } catch {
    return '';
  }
  try {
    const data = readPublish(file);
    return typeof data?.publish_status === 'string' ? data.publish_status : 'draft';
  } catch {
    return 'draft';
  }
}

function mtime(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : String(v ?? ''));

export const publishing: BuiltinPlugin = {
  id: 'publishing',
  apply(ctx) {
    ctx.station({
      id: 'publish',
      name: '发布',
      nodes: [{ id: 'publish', label: '封面与发布信息', step: 'publish', page: 'publish', produces: [{ path: 'publish.md' }, { prefix: 'covers/' }] }],
      flows: ['speech', 'beat'],
      after: 'review',
      sections: [
        // 口播与卡点各接在自己那一版的段落后面；卡点的「刷新发布配置」另有一版（合同值从网格与分镜计划推导）。
        { id: 'config-lifecycle', file: 'sections/config-lifecycle.md', after: 'style/film-style-mix', flows: ['speech'] },
        { id: 'config-lifecycle-beat', file: 'sections/config-lifecycle-beat.md', after: 'style/film-style-mix-beat', flows: ['beat'] },
        { id: 'stage', file: 'sections/stage.md', after: 'review/stage', stage: 'publish', title: '刷新发布配置', flows: ['speech'] },
        { id: 'stage-beat', file: 'sections/stage-beat.md', after: 'review/stage-beat', stage: 'publish', title: '刷新发布配置', flows: ['beat'] },
        { id: 'deliverables', file: 'sections/deliverables.md', after: 'host/deliverables' },
      ],
      judges: {
        publish: {
          // 发布信息要到「ready」才算做完；写了但还有人工检查没做的，停在这一站。
          output: (c: JudgeContext) => (publishStatus(c.root) === 'ready' ? mtime(path.join(c.root, 'publish.md')) : 0),
          detail: (c: JudgeContext) => {
            const status = publishStatus(c.root);
            const label: Record<string, string> = { draft: '草稿', pending_manual_checks: '还剩人工检查', blocked: '有问题挡着', ready: '可以发布' };
            return status ? label[status] ?? status : undefined;
          },
          // 发布信息只差人工检查（上传前的几项手动核对）时，是在等你。
          waiting: (c: JudgeContext) => (publishStatus(c.root) === 'pending_manual_checks' ? 'user' : undefined),
          guide: { ai: 'AI 在按各平台的规格做封面、写标题和简介。', user: '最后一步：封面、标题和简介。', page: 'publish', pageLabel: '看发布页' },
        },
      },
    });

    ctx.op({
      name: 'validate_publish',
      cli: ['validate', 'publish'],
      summary: '校验 publish.md',
      verb: '校验发布信息',
      description: `校验 file 指向的发布配置。

publish.md 必须以安全 YAML frontmatter 提供机器字段，并以固定 Markdown 章节
提供人工可复制内容。校验会核对字段完整性，以及它引用的产物是否与项目实际一致，
因此需要 project_root 定位项目（缺省为当前目录）。

通过时给出 publish 校验通过：<路径>（<状态>）。`,
      examples: ['validate_publish({"file": "publish.md"})'],
      params: {
        file: { type: 'string', description: 'publish.md 的路径', required: true, positional: 0 },
        project_root: { type: 'string', description: '项目根目录，缺省为当前目录', default: '.' },
      },
      run: (p, { out }) => {
        const rootDir = str(p.project_root) === '' ? '.' : str(p.project_root);
        const data = publish(str(p.file), rootDir);
        out.write(`publish 校验通过：${str(p.file)}（${formatV(data.publish_status)}）\n`);
        return { data: { ok: true, file: str(p.file), status: data.publish_status } };
      },
    });

    ctx.page({ id: 'publish', label: '发布', target: '', after: 'review', files: ['publish.md'], slot: true });
    ctx.route({ pattern: '/api/publish', handle: (host) => publishAPI(host) });
    ctx.validator({ id: 'publish', label: '检查发布信息', file: 'publish.md', op: 'validate_publish' });
  },
};
