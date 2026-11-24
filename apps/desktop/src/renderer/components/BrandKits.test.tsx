import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BrandKitsPanel } from './BrandKits';

describe('BrandKitsPanel', () => {
  it('renders website extraction composer and manual brand kit controls', () => {
    const html = renderToStaticMarkup(<BrandKitsPanel version={1} onQuick={vi.fn()} />);
    expect(html).toContain('跨项目品牌包（Brand Kit）');
    expect(html).toContain('从官网提取');
    expect(html).toContain('手动新建品牌包');
  });
});
