//
// Assemble 落地的三个产物路径，相对项目根。它们在写方（assemble 本身）、
// 打印方（cli 的 runDialogueAssemble）、读方（validate/cast、castbeats）之间只应有这一份真相源——
// 原先三处各写一遍字面量，改落地路径时读方极容易漏改，导致 am validate cast 报"找不到 production/dialogue.json"。
import path from 'node:path';

/** SRTRelPath 是装配产出的字幕文件相对路径。 */
export const SRTRelPath = 'transcription-production.srt';

/** VoiceRelPath 是装配产出的完整配音相对路径。 */
export const VoiceRelPath = path.join('production', 'audio', 'voice.wav');

/** DialogueRelPath 是装配产出的结构化时间线相对路径。castbeats 用同一个值，不要再造第三处。 */
export const DialogueRelPath = path.join('production', 'dialogue.json');
