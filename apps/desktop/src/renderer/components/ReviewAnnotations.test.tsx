import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AnnotationSvgLayer, ReviewCommentsPanel } from './ReviewAnnotations';

describe('ReviewAnnotations', () => {
  it('renders normalized vector marks across all five mark kinds', () => {
    const html = renderToStaticMarkup(
      <AnnotationSvgLayer
        marks={[
          {
            kind: 'rectangle',
            points: [
              { x: 0.1, y: 0.1 },
              { x: 0.5, y: 0.4 },
            ],
          },
          {
            kind: 'ellipse',
            points: [
              { x: 0.2, y: 0.2 },
              { x: 0.6, y: 0.6 },
            ],
          },
          {
            kind: 'arrow',
            points: [
              { x: 0.2, y: 0.3 },
              { x: 0.8, y: 0.7 },
            ],
          },
          {
            kind: 'pen',
            points: [
              { x: 0.1, y: 0.2 },
              { x: 0.2, y: 0.3 },
              { x: 0.3, y: 0.25 },
            ],
          },
          { kind: 'text', points: [{ x: 0.4, y: 0.5 }], text: '字号放大' },
        ]}
      />,
    );
    expect(html).toContain('<rect');
    expect(html).toContain('<ellipse');
    expect(html).toContain('<line');
    expect(html).toContain('<path');
    expect(html).toContain('字号放大');
  });

  it('renders review comments checklist panel with five drawing tools', () => {
    const html = renderToStaticMarkup(<ReviewCommentsPanel version={1} sceneId="scene-001" onBatchSend={vi.fn()} />);
    expect(html).toContain('审片批注清单');
    expect(html).toContain('矩形');
    expect(html).toContain('箭头');
    expect(html).toContain('画笔');
    expect(html).toContain('加入清单');
  });
});
