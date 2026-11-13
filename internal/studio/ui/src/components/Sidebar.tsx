import { useMemo, useState } from 'preact/hooks';
import type { TreeFile } from '../types';

// 文件树。原来放在左侧栏，放映室版去掉了侧栏，文件树只在「文件」页里出现。

interface Dir {
  name: string;
  path: string;
  dirs: Map<string, Dir>;
  files: TreeFile[];
}

function buildTree(files: TreeFile[]): Dir {
  const root: Dir = { name: '', path: '', dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split('/');
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      let next = dir.dirs.get(part);
      if (!next) {
        next = { name: part, path: dir.path ? `${dir.path}/${part}` : part, dirs: new Map(), files: [] };
        dir.dirs.set(part, next);
      }
      dir = next;
    }
    dir.files.push(file);
  }
  return root;
}

export function FileTree(props: { files: TreeFile[]; selected: string; recent: Set<string>; onFile: (path: string) => void }) {
  const root = useMemo(() => buildTree(props.files), [props.files]);
  const [open, setOpen] = useState<Set<string>>(() => new Set(['scenes', 'production']));
  const toggle = (path: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const render = (dir: Dir, depth: number) => (
    <>
      {[...dir.dirs.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((child) => (
          <li key={child.path}>
            <button
              class="row tree-dir"
              style={{ paddingLeft: 8 + depth * 14 }}
              aria-expanded={open.has(child.path)}
              onClick={() => toggle(child.path)}
            >
              <span class="caret" aria-hidden="true">
                {open.has(child.path) ? '▾' : '▸'}
              </span>
              <span class="ellipsis">{child.name}</span>
            </button>
            {open.has(child.path) && <ul class="list">{render(child, depth + 1)}</ul>}
          </li>
        ))}
      {dir.files.map((file) => (
        <li key={file.path} class={file.path === props.selected ? 'active' : ''}>
          <button
            class={'row tree-file' + (props.recent.has(file.path) ? ' recent' : '')}
            style={{ paddingLeft: 26 + depth * 14 }}
            title={file.path}
            data-ctx-file={file.path}
            onClick={() => props.onFile(file.path)}
          >
            <span class="ellipsis">{file.path.split('/').pop()}</span>
            {props.recent.has(file.path) && <span class="mark" aria-label="本轮改动" />}
          </button>
        </li>
      ))}
    </>
  );

  return <ul class="list tree">{render(root, 0)}</ul>;
}
