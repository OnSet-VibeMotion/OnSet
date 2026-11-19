import fs from 'node:fs';
import path from 'node:path';
import type { ViewBlock, ViewNode } from '../align';
import * as cast from '../cast';
import { load as loadConfig } from '../config';
import * as dialogue from '../dialogue';
import { readCues } from '../srt';
import { containedPath } from './sessions';
import type { ScriptAudio, ScriptAudioOption } from './script_audio';

export interface ScriptDialogue {
  provider: string;
  roles: { id: string; name: string; voice_id?: string }[];
  warning?: string;
}

export function scriptDialogue(root: string): ScriptDialogue {
  const result: ScriptDialogue = { provider: '', roles: [] };
  try {
    containedPath(root, cast.RosterFile);
    const roster = cast.loadRoster(root);
    const packs = (roster.packs ?? []).map((relative) => {
      const yaml = containedPath(root, path.join(relative, cast.PackFile));
      return cast.parsePack(path.dirname(yaml));
    });
    result.roles = packs.map(({ id, name }) => ({ id, name: name || id }));
    result.provider = loadConfig(root).ttsProvider;
    result.roles = result.roles.map((role, index) => {
      const voiceID = packs[index].voice?.[result.provider]?.voiceId;
      return voiceID ? { ...role, voice_id: voiceID } : role;
    });
  } catch (err) {
    result.warning = (err as Error).message;
  }
  return result;
}

function display(nodes: ViewNode[]): string {
  return nodes.map((node) => node.kind === 'phrase' ? display(node.children ?? []) : node.text ?? '').join('');
}

function comparable(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\p{M}]/gu, '');
}

/** 对白装配会先写 WAV 和 SRT，最后写带说话人的时间线。三者要属于同一版配音。 */
export function dialogueAudio(
  root: string,
  option: ScriptAudioOption,
  blocks: ViewBlock[],
  roles: ScriptDialogue['roles'],
): { voice: ScriptAudio; blocks: ViewBlock[] } | undefined {
  try {
    const timeline = containedPath(root, dialogue.DialogueRelPath);
    const subtitles = containedPath(root, dialogue.SRTRelPath);
    if ([timeline, subtitles].some((file) => fs.statSync(file).mtimeMs < option.version)) return;
    const result = dialogue.unmarshalResult(fs.readFileSync(timeline));
    const seconds = dialogue.totalSeconds(result);
    if (result.schema !== dialogue.SchemaVersion || !Number.isFinite(seconds) || seconds <= 0) return;
    const voices = new Map(roles.map((role) => [role.id, role.voice_id]));
    if (result.segments?.some(({ speaker, voiceId }) => voices.get(speaker) && voices.get(speaker) !== voiceId)) return;
    const cues = readCues(subtitles);
    const lines = result.lines ?? [];
    if (cues.length !== lines.length) return;
    const parts = lines.map((line, index) => {
      const cue = cues[index];
      if (line.srtIndex !== cue.index || !line.speaker
        || !Number.isFinite(line.startSeconds) || !Number.isFinite(line.endSeconds)
        || line.startSeconds < (lines[index - 1]?.endSeconds ?? 0) - 1e-6
        || line.endSeconds <= line.startSeconds || line.endSeconds > seconds + 1e-6
        || Math.abs(cue.start_seconds - line.startSeconds) > 0.001
        || Math.abs(cue.end_seconds - line.endSeconds) > 0.001) {
        throw new Error('对白时间线与字幕不一致');
      }
      return { ...line, text: comparable(cue.text) };
    }).filter((line) => line.text);

    // 字幕可以拆开一句台词，也可以合并同一人相邻的几句，跨字幕时沿用实际时间码。
    let index = 0;
    let offset = 0;
    const timed = blocks.map((block) => {
      const text = comparable(display(block.nodes ?? []));
      if (!block.speaker || !text) return block;
      let start: number | undefined;
      let end = 0;
      for (let consumed = 0; consumed < text.length;) {
        const part = parts[index];
        if (!part || part.speaker !== block.speaker) throw new Error('对白说话人与终稿不一致');
        const count = Math.min(text.length - consumed, part.text.length - offset);
        if (part.text.slice(offset, offset + count) !== text.slice(consumed, consumed + count)) {
          throw new Error('对白字幕与终稿不一致');
        }
        const length = part.endSeconds - part.startSeconds;
        start ??= part.startSeconds + length * offset / part.text.length;
        consumed += count;
        offset += count;
        end = part.startSeconds + length * offset / part.text.length;
        if (offset === part.text.length) {
          index++;
          offset = 0;
        }
      }
      return start === undefined ? block : { ...block, time: { start, end } };
    });
    if (!index || index !== parts.length) return;
    return { voice: { ...option, seconds, timing: 'dialogue' }, blocks: timed };
  } catch {
    // 正在装配或稿件已经变动时，等完整的新结果再给当前稿子试听。
    return undefined;
  }
}
