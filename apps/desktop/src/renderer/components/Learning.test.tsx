// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { mockApi } from '../testing';
import type { LearningProposal, LearningRelation, LearningState } from '../types';
import { LearningSection } from './Learning';

// 进化页的「谁向谁学」：评判累积出的提议，人点头后成为学习关系。提议怎么从评判里算出来、确认后写进 learning.json
// 由 packages/engine/src/studio/learning.test.ts 钉着；这里看页面怎么说、点了发什么。

const proposal: LearningProposal = {
  student: 'codex/student',
  teacher: 'claude/teacher',
  features: [],
  matches: 4,
  teacher_wins: 3,
  student_wins: 1,
  ties: 0,
  rate: 0.75,
  enough: true,
  auditions: ['audition-20261111-000000', 'audition-20261112-000000', 'audition-20261114-000000'],
};

const relation: LearningRelation = {
  id: 'rel-1',
  student: 'codex/student',
  teacher: 'claude/teacher',
  features: [],
  created_at: '2026-11-15T00:00:00Z',
  note: '',
  progress: {
    points: (['loss', 'loss', 'win', 'loss'] as const).map((result, i) => ({ at: `2026-11-1${i + 1}T00:00:00Z`, audition: `audition-2026111${i + 1}-000000`, result, rate: [0, 0, 1 / 3, 1 / 4][i] })),
    exams: [],
  },
  lessons: [],
  learnable: 3,
  exemplars: 3,
};

const learning = (over: Partial<LearningState>): LearningState => ({ relations: [], proposals: [], verdicts: 4, exemplars: 4, thresholds: { matches: 3, rate: 0.6 }, ...over });

describe('谁向谁学', () => {
  it('按评判提议让输的一方向赢的一方学，确认后列出学习关系与胜率曲线', async () => {
    const api = mockApi({
      '/api/learning': learning({ proposals: [proposal] }),
      'POST /api/learning/relations': () => {
        api.set('/api/learning', learning({ relations: [relation], proposals: null }));
        return { id: 'rel-1' };
      },
    });
    const { container } = render(<LearningSection version={1} scenes={[]} sceneId="" run={vi.fn()} onAudition={vi.fn()} />);
    const row = (await screen.findByText(/在 4 场里输给/)).closest<HTMLElement>('.learning-proposal')!;
    expect(row.textContent).toContain('codex · student 在 4 场里输给 claude · teacher 3 场');
    await userEvent.click(within(row).getByRole('button', { name: '让它学' }));
    expect(api.calls.find((c) => c.method === 'POST')?.body).toEqual({ student: 'codex/student', teacher: 'claude/teacher', features: [] });
    const card = (await screen.findByText(/正面比了 4 场/)).closest<HTMLElement>('.learning-relation')!;
    expect(card.textContent).toContain('codex · student');
    expect(card.querySelectorAll('.learning-curve circle.pt')).toHaveLength(4);
    expect(container.querySelector('.learning-proposal')).toBeNull();
    expect(api.unmatched).toEqual([]);
  });

  it('还没有评判时指去试镜', async () => {
    mockApi({ '/api/learning': learning({ verdicts: 0, exemplars: 0 }) });
    const onAudition = vi.fn();
    render(<LearningSection version={1} scenes={[]} sceneId="" run={vi.fn()} onAudition={onAudition} />);
    await userEvent.click(await screen.findByRole('button', { name: '去试镜' }));
    expect(onAudition).toHaveBeenCalled();
  });
});
