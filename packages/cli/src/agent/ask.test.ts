import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import type * as director from '@onset/engine/director';
import * as studioview from '@onset/engine/studioview';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runBuiltinAgent } from './command';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-director-ask-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const fauxService: director.ResolvedService = {
  id: 's-faux',
  name: 'faux',
  protocol: 'openai',
  base_url: 'https://faux.invalid/v1',
  model: 'm1',
  vision: true,
  key: 'sk-faux',
};

function fauxSetup(provider: ReturnType<typeof fauxProvider>) {
  return async (runtime: unknown) => {
    (runtime as { registerNativeProvider(p: unknown): void }).registerNativeProvider(provider.provider);
    return 'faux/m1';
  };
}

describe('director built-in studio_ask tool', () => {
  it('blocks mid-turn on inbox, receives structured answers, and continues in the same turn', async () => {
    const workdir = path.join(tmp, 'proj');
    const inbox = path.join(tmp, 'inbox');
    fs.mkdirSync(workdir, { recursive: true });
    fs.mkdirSync(inbox, { recursive: true });

    const watcher = setInterval(() => {
      const [item] = studioview.listQuestionRequests(inbox);
      if (!item || item.answered) return;
      studioview.writeQuestionResponse(inbox, item.request.id, {
        status: 'answered',
        answers: [
          { question_id: 'opening', label: '开场', selected: ['直接抛数据'] },
          { question_id: 'focus', label: '重点', selected: ['原理拆解'], other: '补性能表' },
        ],
        answer_map: { opening: '直接抛数据', focus: ['原理拆解', '补性能表'] },
      });
      clearInterval(watcher);
    }, 15);

    const faux = fauxProvider({ provider: 'faux', models: [{ id: 'm1' }] });
    let toolReplyText = '';
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('studio_ask', {
            title: '制作规格确认',
            questions: [
              {
                id: 'opening',
                header: '开场',
                question: '怎么开场？',
                options: [{ label: '直接抛数据', recommended: true }, { label: '讲故事' }],
              },
              {
                id: 'focus',
                header: '重点',
                question: '重点展开哪些？',
                multi_select: true,
                options: [{ label: '原理拆解' }, { label: '案例' }],
              },
            ],
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      (context) => {
        const tr = context.messages.find((m) => m.role === 'toolResult' && m.toolName === 'studio_ask');
        toolReplyText =
          tr && tr.role === 'toolResult'
            ? tr.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n')
            : '';
        return fauxAssistantMessage('已收到你的两项选择，同轮继续推进制作。');
      },
    ]);

    const lines: string[] = [];
    try {
      const outcome = await runBuiltinAgent(
        {
          workdir,
          prompt: '先帮我确认规格',
          unsafe: false,
          agent_dir: path.join(tmp, 'agent'),
          service: fauxService,
        },
        (line) => lines.push(line),
        undefined,
        {
          setupModels: fauxSetup(faux),
          env: { [studioview.ViewInboxEnv]: inbox },
        },
      );
      expect(outcome).toEqual({ ok: true });
      expect(toolReplyText).toContain('1. [开场]：直接抛数据');
      expect(toolReplyText).toContain('2. [重点]：原理拆解；补充：补性能表');
      expect(lines.join('\n')).toContain('已收到你的两项选择，同轮继续推进制作。');
    } finally {
      clearInterval(watcher);
    }
  });
});
