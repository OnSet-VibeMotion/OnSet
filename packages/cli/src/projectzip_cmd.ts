/**
 * 离线便携工程 ZIP 归档操作（project_export_zip / project_import_zip）。
 */
import * as projectzip from '@onset/engine/projectzip';
import { defineGroup } from './ops/cli';
import { bool, projectRoot, str } from './ops/common';
import { defineOp } from './ops/op';

defineGroup({
  path: ['project-zip'],
  summary: '离线便携工程 ZIP 归档与 HyperFrames ZIP 互通',
  description:
    '导出自动剔除密钥与临时缓存并逐文件自验的便携工程 ZIP，或安全导入 OnSet 归档与标准 HyperFrames 项目 ZIP。',
});

defineOp({
  name: 'project_export_zip',
  cli: ['project-zip', 'export'],
  summary: '导出离线便携工程 ZIP（自动剥离密钥/缓存并自验）',
  description: `将项目源码、分镜、配音字幕、资源池与字体许可证打成自包含便携 ZIP（自动排除 .env、attempts/ 与回退大对象）。
落盘前会以与导入完全一致的校验逻辑逐文件核对字节数与 SHA-256。`,
  examples: ['project_export_zip({"project_root": ".", "dest": "/tmp/my-film.onset.zip"})'],
  params: {
    project_root: projectRoot,
    dest: { type: 'string', description: '输出 ZIP 路径，必填', required: true, positional: 0 },
    title: { type: 'string', description: '归档标题，留空取项目目录名' },
    include_renders: { type: 'boolean', description: '是否一并打包已渲染的 MP4（默认关闭）' },
  },
  run: async (p, { out }) => {
    const root = str(p.project_root) || '.';
    const dest = str(p.dest);
    const res = projectzip.exportProjectZip(root, dest, {
      title: str(p.title) || undefined,
      includeRenders: bool(p.include_renders),
    });
    out.write(`已导出便携工程 ZIP（自验通过，共 ${res.file_count} 个文件，${res.bytes} 字节）：${res.archive_path}\n`);
    return { data: res };
  },
});

defineOp({
  name: 'project_import_zip',
  cli: ['project-zip', 'import'],
  summary: '导入 OnSet 便携工程 ZIP 或标准 HyperFrames 项目 ZIP 到独立目录',
  description: `校验并解包 OnSet 便携工程 ZIP 或外部标准 HyperFrames 项目 ZIP 到指定新目录（拒绝覆盖非空目录，拒绝路径穿越、符号链接与哈希不符）。`,
  examples: ['project_import_zip({"zip": "/tmp/my-film.onset.zip", "dest": "/tmp/my-film-copy"})'],
  params: {
    zip: { type: 'string', description: '待导入的 ZIP 文件路径', required: true, positional: 0 },
    dest: { type: 'string', description: '导入目标目录（必须不存在或为空）', required: true, positional: 1 },
  },
  run: async (p, { out }) => {
    const res = projectzip.importProjectZip(str(p.zip), str(p.dest));
    out.write(`已导入 ${res.kind} 项目「${res.title}」（${res.file_count} 个文件）→ ${res.destination}\n`);
    return { data: res };
  },
});
