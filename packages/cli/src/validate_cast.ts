/**
 * 把 validate.castProblems 接成操作 validate_cast。
 * internal/validate 只定义项目级一致性规则，这里是唯一把它接出来的地方。
 */
import * as config from '@am/engine/config';
import * as validate from '@am/engine/validate';
import { projectRoot, str } from './ops/common';
import { defineOp } from './ops/op';

defineOp({
  name: 'validate_cast',
  cli: ['validate', 'cast'],
  summary: '校验多角色项目的项目级一致性',
  description: `校验班底、对白时间线与镜头节拍三者是否互相吻合：

  - cast.yaml 登记的角色包能否加载，班底是否为空
  - 每个角色是否声明了当前 TTS_PROVIDER 的音色
  - production/dialogue.json 是否存在、schema 正确，字幕行数与
    transcription-production.srt 是否一致，逐行时间是否连续不重叠
  - dialogue.json 里的说话人是否都在班底里
  - 所有 scenes/*/scene.json 的 cast.beats 换算回全局时间后，是否合并
    覆盖了 dialogue.json 的全部台词行，以及每个 on_stage 角色的 dna.md
    是否存在于渲染提示词会引用的路径

项目没有 cast.yaml（单口播模式）时视为无事可做，直接通过：这组检查
只对多角色项目生效，对老项目零影响。

TTS_PROVIDER 缺省按 config_get({"key": "TTS_PROVIDER"}) 的解析结果，provider
可显式覆盖。`,
  examples: ['validate_cast()', 'validate_cast({"provider": "bailian"})'],
  params: {
    project_root: { ...projectRoot, description: '项目根目录，缺省为当前目录' },
    provider: { type: 'string', description: 'TTS_PROVIDER，缺省取项目配置的解析结果' },
  },
  run: (p, { out }) => {
    const rootDir = str(p.project_root) !== '' ? str(p.project_root) : '.';
    const resolvedProvider = str(p.provider) !== '' ? str(p.provider) : config.load(rootDir, null).ttsProvider;
    const problems = validate.castProblems(rootDir, resolvedProvider) ?? [];
    if (problems.length > 0) throw new Error(`多角色项目一致性校验未通过：\n  - ${problems.join('\n  - ')}`);
    out.write('多角色项目一致性校验通过\n');
    return { data: { ok: true } };
  },
});
