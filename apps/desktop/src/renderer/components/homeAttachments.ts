import { api } from '../api';
import type { Attachment } from '../types';

export type HomeMaterial =
  | { kind: 'file'; name: string; file: File }
  | { kind: 'directory'; name: string; files: { path: string; file: File }[]; directories: string[] };

export function fileMaterials(files: FileList | File[]): HomeMaterial[] {
  return Array.from(files, (file) => ({ kind: 'file', name: file.name, file }));
}

/** 必须在 drop 回调里同步取出 entry；离开回调后浏览器会清空拖拽数据。 */
export function droppedMaterials(data: DataTransfer): Promise<HomeMaterial[]> {
  const items = Array.from(data.items).filter((item) => item.kind === 'file');
  if (!items.length) return Promise.resolve(fileMaterials(data.files));
  const entries = items.map((item) => ({ entry: item.webkitGetAsEntry?.(), file: item.getAsFile() }));
  return Promise.all(entries.map(async ({ entry, file }) => {
    if (!entry?.isDirectory) {
      if (!file) throw new Error('无法读取拖入的文件，请重新拖入');
      return { kind: 'file', name: file.name, file } as HomeMaterial;
    }
    const material: Extract<HomeMaterial, { kind: 'directory' }> = { kind: 'directory', name: entry.name, files: [], directories: [] };
    let count = 0;
    let bytes = 0;
    const visit = async (entry: FileSystemEntry, rel: string): Promise<void> => {
      if (++count > 1000) throw new Error('一个文件夹最多导入 1000 个条目');
      if (entry.name.startsWith('.env')) throw new Error('.env 不能上传：凭据不进项目');
      if (entry.isFile) {
        const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
        bytes += file.size;
        if (bytes > 512 << 20) throw new Error('一个文件夹的素材不能超过 512 MB');
        material.files.push({ path: rel, file });
      } else if (entry.isDirectory) {
        material.directories.push(rel);
        const reader = (entry as FileSystemDirectoryEntry).createReader();
        // Chromium 一次只返回一批目录项，要读到空批次才算遍历完成。
        for (;;) {
          const children = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
          if (!children.length) break;
          for (const child of children) await visit(child, rel ? `${rel}/${child.name}` : child.name);
        }
      } else {
        throw new Error(`无法读取「${entry.name}」`);
      }
    };
    await visit(entry, '');
    return material;
  }));
}

export function materialFiles(materials: HomeMaterial[]): File[] {
  return materials.flatMap((item) => item.kind === 'file' ? [item.file] : item.files.map(({ file }) => file));
}

/** 建好项目后再导入，目录引用的出处因此始终是新项目里的真实路径。 */
export async function uploadMaterials(materials: HomeMaterial[]): Promise<Attachment[]> {
  const attachments: Attachment[] = [];
  for (const material of materials) {
    const form = new FormData();
    const headers: Record<string, string> = {};
    if (material.kind === 'file') {
      form.append('file', material.file, material.name);
    } else {
      headers['X-Onset-Upload-Directory'] = encodeURIComponent(material.name);
      for (const dir of material.directories) form.append('directory:' + encodeURIComponent(dir), '');
      // 空 Blob 在 Electron 自定义协议里会报 Could not get blob data；
      // 空文件与目录标记用空字符串字段，普通文件照旧流式上传。
      for (const { path, file } of material.files) {
        if (file.size === 0) form.append('file:' + encodeURIComponent(path), '');
        else form.append('file:' + encodeURIComponent(path), file, 'file');
      }
    }
    const result = await api<{ attachments: Attachment[] }>('/api/uploads', { method: 'POST', headers, body: form });
    attachments.push(...result.attachments);
  }
  return attachments;
}
