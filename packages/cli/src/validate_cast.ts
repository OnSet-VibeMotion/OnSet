/**
 * 把 validate.castProblems 接到 am validate 命令组上，移植自 internal/cli/validate_cast.go。
 * internal/validate 只定义项目级一致性规则，这里是唯一把它接到 CLI 上的地方。
 */
import * as config from '@am/engine/config';
import * as validate from '@am/engine/validate';
import { noArgs } from './cli';
import { Command, type Out, ref } from './cobra';

export function newValidateCastCommand(stdout: Out): Command {
  const projectRoot = ref('');
  const provider = ref('');
  const cmd = new Command({
    use: 'cast',
    args: noArgs,
    short: '校验多角色项目的项目级一致性',
    long: `校验班底、对白时间线与镜头节拍三者是否互相吻合：

  - cast.yaml 登记的角色包能否加载，班底是否为空
  - 每个角色是否声明了当前 TTS_PROVIDER 的音色
  - production/dialogue.json 是否存在、schema 正确，字幕行数与
    transcription-production.srt 是否一致，逐行时间是否连续不重叠
  - dialogue.json 里的说话人是否都在班底里
  - 所有 scenes/*/scene.json 的 cast.beats 换算回全局时间后，是否合并
    覆盖了 dialogue.json 的全部台词行，以及每个 on_stage 角色的 dna.md
    是否存在于渲染提示词会引用的路径

项目没有 cast.yaml（单口播模式）时视为无事可做，直接退出 0：这组检查
只对多角色项目生效，对老项目零影响。

TTS_PROVIDER 缺省按 am config get TTS_PROVIDER 的解析结果，--provider
可显式覆盖。`,
    example: `  am validate cast
  am validate cast --provider bailian
  am validate cast --project-root .`,
    runE: () => {
      const rootDir = projectRoot.value !== '' ? projectRoot.value : '.';
      const resolvedProvider = provider.value !== '' ? provider.value : config.load(rootDir, null).ttsProvider;
      const problems = validate.castProblems(rootDir, resolvedProvider) ?? [];
      if (problems.length > 0) throw new Error(`多角色项目一致性校验未通过：\n  - ${problems.join('\n  - ')}`);
      stdout.write('多角色项目一致性校验通过\n');
    },
  });
  cmd.flags().stringVar(projectRoot, 'project-root', '', '项目根目录，缺省为当前目录');
  cmd.flags().stringVar(provider, 'provider', '', 'TTS_PROVIDER，缺省取 am config 解析结果');
  return cmd;
}
