import type { ModelSpec } from '../toolinstall';

/**
 * Breeze TTS 2 的 MLX 8bit 转换（约 4.6 GB；bf16 版 7.6 GB，4bit 版音质未经验证）。
 * mlx-audio 0.6.1 起支持（models/breeze_tts）。只列加载要用的文件，外加 LICENSE / NOTICE
 * 随模型留在本机；魔搭特有的 configuration.json 与 README 不列。摘要取自魔搭的文件列表，2026-11。
 */
export const BreezeTTS2: ModelSpec = {
  repo: 'mlx-community/Breeze-TTS-2-mlx-8bit',
  files: [
    { path: 'LICENSE', sha256: '2a143ae167cb0253d95bafa694e415570dcce336d712230d205c538523bbd855', size: 18856 },
    { path: 'NOTICE', sha256: '70bc248b98e5bb527f160c86be56d60ef8c63776c43051273643db036ebee40d', size: 146 },
    {
      path: 'audio_tokenizer/config.json',
      sha256: 'ee65bb901c876664ab8707c487157aa1a6ee57c65969b28fb5ec9dc211e68167',
      size: 2336,
    },
    {
      path: 'audio_tokenizer/model.safetensors',
      sha256: '836b7b357f5ea43e889936a3709af68dfe3751881acefe4ecf0dbd30ba571258',
      size: 682293092,
    },
    {
      path: 'audio_tokenizer/preprocessor_config.json',
      sha256: 'fcb3805e597e786d4067706e602f6688524640f8d3396790e2e09b5942fcbdfb',
      size: 234,
    },
    { path: 'config.json', sha256: '91cf471c3a9bd00e61046a5e08dce22967f161e75488d21b128026154111be65', size: 12379 },
    {
      path: 'generation_config.json',
      sha256: '2ef3f2c0ab8d9ad241059138a795433c5410fd9954efb9625674ecd2a9529434',
      size: 251,
    },
    {
      path: 'model.safetensors',
      sha256: 'd7a82315bcc59c3057f13bb85100743c7cd40692e38145fb255d6c1f0bf447bc',
      size: 3885721536,
    },
    {
      path: 'model.safetensors.index.json',
      sha256: '113da60084ed077d67dd99706e5619f4c40056d777225923302cb957b3677026',
      size: 98863,
    },
    {
      path: 'special_tokens_map.json',
      sha256: '194f265bb588d142a16f27d9576104eb3dab3d7ba9961541d2d6e3d5e77e6470',
      size: 886,
    },
    {
      path: 'tokenizer.json',
      sha256: 'd3ec9ac3eb2392389b9f5112e85d8b43316494addb587ba7b7a9d61eac23af96',
      size: 33386945,
    },
    {
      path: 'tokenizer_config.json',
      sha256: '2c084fd6725c2284e8aa6da095a8d036d48fe79665595bfcd50371821b620e44',
      size: 1157960,
    },
  ],
};

/** MLX Qwen3 配音模型：摘要来自魔搭同名镜像，2026-11；与 Breeze 一样只由工具准备页下载。 */
export const QwenCustomVoice: ModelSpec = {
  repo: 'mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit',
  files: [
    { path: 'config.json', sha256: '2eea3665564268139c3beb8d497fd3c2e4524e9eed5452836cdf1de96ed3cdbd', size: 6058 },
    {
      path: 'generation_config.json',
      sha256: 'f1b90b4513f3b34c62851049e2492d7b4c5940daf1276f89c82b8ef04127f3aa',
      size: 245,
    },
    { path: 'merges.txt', sha256: '599bab54075088774b1733fde865d5bd747cbcc7a547c5bc12610e874e26f5e3', size: 1671839 },
    {
      path: 'model.safetensors',
      sha256: '3bcb2c4a127e6243e81a30b7126c7865f686d3559de4f938e5d3b150c6a9560d',
      size: 1286743170,
    },
    {
      path: 'model.safetensors.index.json',
      sha256: '0c92041960fa189cf35ae538c8d9ca07c468edddd0c9bb52274c5d4d287a860b',
      size: 71447,
    },
    {
      path: 'preprocessor_config.json',
      sha256: 'efdde1022ea9d76928bf7a9cd53139138f5ba2e466e837f08f6105ab1af1c119',
      size: 127,
    },
    {
      path: 'speech_tokenizer/config.json',
      sha256: 'ee65bb901c876664ab8707c487157aa1a6ee57c65969b28fb5ec9dc211e68167',
      size: 2336,
    },
    {
      path: 'speech_tokenizer/model.safetensors',
      sha256: '836b7b357f5ea43e889936a3709af68dfe3751881acefe4ecf0dbd30ba571258',
      size: 682293092,
    },
    {
      path: 'speech_tokenizer/preprocessor_config.json',
      sha256: 'fcb3805e597e786d4067706e602f6688524640f8d3396790e2e09b5942fcbdfb',
      size: 234,
    },
    {
      path: 'tokenizer_config.json',
      sha256: 'dc3c31c3bdaedd5016382bb3cbe07323026775ad51f5a4fb564505992ae4a670',
      size: 7344,
    },
    { path: 'vocab.json', sha256: 'ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910', size: 2776833 },
  ],
};
