// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditionCompare } from './AuditionCompare';
import type { AuditionContestant } from '../types';

const contestants: AuditionContestant[] = ['A', 'B', 'C', 'D', 'E', 'F'].map(slot => ({
  slot, status: 'done', outcome: slot === 'A' ? 'failed' : 'succeeded', output: slot === 'A' ? '' : `${slot}.mp4`,
}));
function setup(entries = contestants) {
  const onPick = vi.fn();
  const view = render(<AuditionCompare contestants={entries} version={1} labelFor={c => `选手 ${c.slot}`} onPick={onPick} />);
  return { ...view, onPick };
}
function ready(container: HTMLElement) {
  const videos = [...container.querySelectorAll('video')];
  for (const video of videos) {
    Object.defineProperty(video, 'duration', { configurable: true, value: 8 });
    fireEvent.loadedMetadata(video);
    fireEvent.loadedData(video);
  }
  return videos;
}
afterEach(() => vi.restoreAllMocks());

describe('试镜画面对比', () => {
  it('默认同时显示所有有画面的选手，不把比较限制为两份', () => {
    const { container } = setup();
    expect(container.querySelectorAll('video')).toHaveLength(5);
    expect([...container.querySelectorAll('.audition-screen')].map(e => e.getAttribute('data-slot'))).toEqual(['B', 'C', 'D', 'E', 'F']);
    expect(screen.queryByLabelText('左侧画面')).toBeNull();
  });

  it('所有画面共用时间轴，放大和返回保留比较位置，选择对应选手', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const { container, onPick } = setup();
    const videos = ready(container);
    fireEvent.change(screen.getByLabelText('对比播放位置'), { target: { value: '3.5' } });
    expect(videos.map(v => v.currentTime)).toEqual([3.5, 3.5, 3.5, 3.5, 3.5]);
    await userEvent.click(screen.getByRole('button', { name: '放大 B' }));
    expect(container.querySelector('[data-slot="C"]')?.hasAttribute('hidden')).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: '返回全部画面' }));
    expect(container.querySelectorAll('.audition-screen:not([hidden])')).toHaveLength(5);
    expect(videos.every(v => v.currentTime === 3.5)).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: '选 F 为最佳' }));
    expect(onPick).toHaveBeenCalledWith('F');
  });

  it('所有画面一起播放与暂停；播放失败时停止并提示', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
      Object.defineProperty(this, 'paused', { configurable: true, value: false });
      return Promise.resolve();
    });
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
      Object.defineProperty(this, 'paused', { configurable: true, value: true });
    });
    const { container } = setup();
    ready(container);
    await userEvent.click(screen.getByRole('button', { name: '一起播放' }));
    expect(play).toHaveBeenCalledTimes(5);
    await userEvent.click(screen.getByRole('button', { name: '暂停' }));
    expect(pause).toHaveBeenCalled();
    play.mockRejectedValueOnce(new Error('decode error'));
    await userEvent.click(screen.getByRole('button', { name: '一起播放' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('无法播放'));
    expect(screen.getByRole('button', { name: '一起播放' })).toBeTruthy();
  });

  it('只有一份画面时说明无法比较，视频加载失败有提示', () => {
    const { container } = setup(contestants.slice(0, 2));
    expect(screen.getByText('还需要另一份画面才能对比。')).toBeTruthy();
    expect(container.querySelectorAll('video')).toHaveLength(1);
    fireEvent.error(container.querySelector('video')!);
    expect(screen.getByRole('alert').textContent).toContain('B 的视频无法载入');
    expect(screen.getByRole('button', { name: '播放' }).hasAttribute('disabled')).toBe(true);
  });

  it('一份视频损坏不阻止其余画面对比', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const { container } = setup();
    const videos = ready(container);
    fireEvent.error(videos[0]);
    expect(screen.getByRole('alert').textContent).toContain('B 的视频无法载入');
    await userEvent.click(screen.getByRole('button', { name: '一起播放' }));
    expect(play).toHaveBeenCalledTimes(4);
  });

  it('新选手出片自动加入对比；老师只作参照不能选为最佳', () => {
    const props = { version: 1, labelFor: (c: AuditionContestant) => `选手 ${c.slot}`, onPick: vi.fn() };
    const reference = { ...contestants[2], role: 'reference' as const };
    const { rerender, container } = render(<AuditionCompare {...props} contestants={[contestants[1], reference]} />);
    ready(container);
    fireEvent.change(screen.getByLabelText('对比播放位置'), { target: { value: '2' } });
    rerender(<AuditionCompare {...props} contestants={[{ ...contestants[0], output: 'A.mp4' }, contestants[1], reference]} />);
    expect(ready(container).map(v => v.currentTime)).toEqual([2, 2, 2]);
    expect(screen.queryByRole('button', { name: '选 C 为最佳' })).toBeNull();
  });
});
