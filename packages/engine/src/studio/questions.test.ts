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

      // 模拟客户端重启清空内存 pending：仍可从持久化事件流找回并提交 skipped。
      sess.questions.clear();
      const restored = findDeferredQuestion(getSession(server, project, sess.meta.session_id)!.events, defReq.id);
      expect(restored?.deferred).toBe(true);

      const skipped = await send(
        server,
        'POST',
        `/api/sessions/${sess.meta.session_id}/questions/${defReq.id}`,
        JSON.stringify({ status: 'skipped' }),
      );
      expect(skipped.status).toBe(200);
      expect(await skipped.json()).toEqual({ ok: true, mode: 'deferred' });
      expect(findDeferredQuestion(sess.events, defReq.id)).toBeNull();
    } finally {
      server.shutdown();
    }
  });
});
