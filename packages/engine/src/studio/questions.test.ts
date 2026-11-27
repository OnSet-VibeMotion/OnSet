import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as projectinit from '../projectinit';
import {
  KindQuestion,
  KindQuestionDeferred,
  KindQuestionResolved,
  writeQuestionDeferred,
  writeQuestionRequest,
} from '../studioview';
import { expireQuestions, findDeferredQuestion, pollQuestions } from './questions';
import { createSession, emit, getSession } from './sessions';
import { send, startStudio, tempDir } from './testsupport';

function makeServer() {
  const root = tempDir();
  const project = path.join(root, 'demo');
  projectinit.create({
    target: project,
    canvas: 'vertical-3x4',
    delivery: 'speech',
    narration: projectinit.NarrationSolo,
  });
  const server = startStudio({ configPath: path.join(root, 'studio.json'), projectPath: project });
  return { root, project: server.currentProject().path, server };
}

describe('studio questions API & lifecycle', () => {
  it('polls inbox questions, accepts live answers via HTTP POST, and rejects invalid or duplicate submissions', async () => {
    const { root, project, server } = makeServer();
    try {
      const sess = createSession(server, project, 'chat', '测试', { tool: 'claude', renderer: 'claude' });
      const inbox = path.join(root, 'inbox-live');
      const req = writeQuestionRequest(inbox, {
        title: '规格确认',
        questions: [
          { id: 'opening', header: '开场', question: '怎么开场？', options: [{ label: '数据' }, { label: '故事' }] },
          {
            id: 'focus',
            header: '重点',
            question: '重点？',
            multi_select: true,
            options: [{ label: '原理' }, { label: '对比' }],
          },
        ],
      });
      const seen = new Set<string>();
      const deferredSeen = new Set<string>();
      pollQuestions(inbox, 't1', sess.questions, seen, deferredSeen, (turn, event) => emit(sess, turn, event));

      expect(sess.events.some((e) => e.kind === KindQuestion && e.question?.id === req.id)).toBe(true);

      // 缺少必答题时返回 400，且不消耗 pending 状态。
      const bad = await send(
        server,
        'POST',
        `/api/sessions/${sess.meta.session_id}/questions/${req.id}`,
        JSON.stringify({ status: 'answered', answers: [{ question_id: 'opening', selected: ['数据'] }] }),
      );
      expect(bad.status).toBe(400);
      expect(sess.questions.has(req.id)).toBe(true);

      // 合法提交返回 200、写回 response 文件并发出 question-resolved。
      const ok = await send(
        server,
        'POST',
        `/api/sessions/${sess.meta.session_id}/questions/${req.id}`,
        JSON.stringify({
          status: 'answered',
          answers: [
            { question_id: 'opening', selected: ['数据'] },
            { question_id: 'focus', selected: ['原理'], other: '加结论' },
          ],
          note: '尽量精炼',
        }),
      );
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ ok: true, mode: 'live' });
      expect(sess.questions.has(req.id)).toBe(false);
      const resolved = sess.events.find((e) => e.kind === KindQuestionResolved && e.question?.id === req.id);
      expect(resolved?.question?.answer_map).toEqual({ opening: '数据', focus: ['原理', '加结论'] });
      expect(fs.existsSync(path.join(inbox, 'questions', `${req.id}.response.json`))).toBe(true);

      // 重复提交返回 409。
      const dup = await send(
        server,
        'POST',
        `/api/sessions/${sess.meta.session_id}/questions/${req.id}`,
        JSON.stringify({ status: 'skipped' }),
      );
      expect(dup.status).toBe(409);
    } finally {
      server.shutdown();
    }
  });

  it('preserves deferred questions across turn-end and restores them from event history after restart', async () => {
    const { root, project, server } = makeServer();
    try {
      const sess = createSession(server, project, 'chat', '跨轮测试', { tool: 'claude', renderer: 'claude' });
      const inbox = path.join(root, 'inbox-deferred');
      const liveReq = writeQuestionRequest(inbox, { questions: [{ question: '普通题', options: ['A', 'B'] }] });
      const defReq = writeQuestionRequest(inbox, {
        title: '待确认',
        questions: [{ id: 'style', header: '风格', question: '选风格？', options: ['科技', '手绘'] }],
      });
      const seen = new Set<string>();
      const deferredSeen = new Set<string>();
      const emitEv = (turn: string, event: { kind: string; question?: any }) => emit(sess, turn, event);

      pollQuestions(inbox, 't1', sess.questions, seen, deferredSeen, emitEv);
      writeQuestionDeferred(inbox, defReq.id);
      pollQuestions(inbox, 't1', sess.questions, seen, deferredSeen, emitEv);
      expect(sess.events.some((e) => e.kind === KindQuestionDeferred && e.question?.id === defReq.id)).toBe(true);

      // 回合结束：普通题过期，deferred 题保留。
      expireQuestions(sess.questions, 't1', emitEv);
      expect(sess.questions.has(liveReq.id)).toBe(false);
      expect(sess.questions.has(defReq.id)).toBe(true);
      expect(
        sess.events.some(
          (e) => e.kind === KindQuestionResolved && e.question?.id === liveReq.id && e.question?.status === 'expired',
        ),
      ).toBe(true);

      // 真实重启恢复：关闭原 Server 并用同一配置与项目新建 Server，从落盘事件恢复 deferred 问题。
      server.shutdown();
      const restarted = startStudio({ configPath: path.join(root, 'studio.json'), projectPath: project });
      try {
        const reloaded = getSession(restarted, project, sess.meta.session_id)!;
        const restored = findDeferredQuestion(reloaded.events, defReq.id);
        expect(restored?.deferred).toBe(true);

        // 非法 view 必须在消费问题前被 400 拒绝，问题仍保持可答。
        const badView = await send(
          restarted,
          'POST',
          `/api/sessions/${sess.meta.session_id}/questions/${defReq.id}`,
          JSON.stringify({
            status: 'answered',
            answers: [{ question_id: 'style', selected: ['科技'] }],
            view: ['not-an-object'],
          }),
        );
        expect(badView.status).toBe(400);
        expect(findDeferredQuestion(reloaded.events, defReq.id)).not.toBeNull();

        // 项目写权被占用时续接失败（409 project_busy），问题不得被消费丢失。
        const busyPath = restarted.currentProject().path;
        restarted.acquire(busyPath, '渲染中');
        try {
          const busy = await send(
            restarted,
            'POST',
            `/api/sessions/${sess.meta.session_id}/questions/${defReq.id}`,
            JSON.stringify({ status: 'answered', answers: [{ question_id: 'style', selected: ['科技'] }] }),
          );
          expect(busy.status).toBe(409);
          expect(findDeferredQuestion(reloaded.events, defReq.id)).not.toBeNull();
        } finally {
          restarted.release(busyPath);
        }

        const skipped = await send(
          restarted,
          'POST',
          `/api/sessions/${sess.meta.session_id}/questions/${defReq.id}`,
          JSON.stringify({ status: 'skipped' }),
        );
        expect(skipped.status).toBe(200);
        expect(await skipped.json()).toEqual({ ok: true, mode: 'deferred' });
        expect(findDeferredQuestion(reloaded.events, defReq.id)).toBeNull();
      } finally {
        restarted.shutdown();
      }
    } finally {
      server.shutdown();
    }
  });

  it('switches to deferred continuation when timeout wins the disk claim before pollQuestions runs', async () => {
    const { root, project, server } = makeServer();
    try {
      const sess = createSession(server, project, 'chat', '竞态测试', { tool: 'claude', renderer: 'claude' });
      const inbox = path.join(root, 'inbox-race');
      const req = writeQuestionRequest(inbox, {
        questions: [{ id: 'q1', header: '风格', question: '选哪种？', options: ['A', 'B'] }],
      });
      const seen = new Set<string>();
      const deferredSeen = new Set<string>();
      pollQuestions(inbox, 't1', sess.questions, seen, deferredSeen, (turn, event) => emit(sess, turn, event));

      // 工具端先写入超时移交标记，但服务端尚未再次 pollQuestions（内存中 item.deferred 仍为 false）。
      expect(writeQuestionDeferred(inbox, req.id)).toBe(true);
      expect(sess.questions.get(req.id)?.deferred).toBe(false);

      // 前端提交 skipped：必须识别磁盘协调状态并走 deferred 模式，不写死掉的 live response。
      const res = await send(
        server,
        'POST',
        `/api/sessions/${sess.meta.session_id}/questions/${req.id}`,
        JSON.stringify({ status: 'skipped' }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, mode: 'deferred' });
      expect(fs.existsSync(path.join(inbox, 'questions', `${req.id}.response.json`))).toBe(false);
    } finally {
      server.shutdown();
    }
  });
});
