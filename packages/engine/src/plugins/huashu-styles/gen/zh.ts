//
// am 接入的 huashu 风格：上游场景 id → 目录名、中英文名、分类、适用题材、画面里写中文用的字体，
// 以及它在上游全风格总览图 assets/全风格总览.jpg 里的格子（6 列 6 行，行优先，从 0 数）。
//
// 只收实做过、与 lemo-opuscar / anidoodle 不重复、不点名具体作品形象的风格；没列的上游场景一律不接
// （为什么不接见 huashu.ts 文件头）。生成器（main.ts）要求这里的每个 id 在固定 commit 上有场景、有配方卡、
// 在上游风格索引（INDEX.md）里有一行；升级 PinnedCommit 时总览图重排了，要重填 cell。
//
// 中文名避开别的来源（huashu.test.ts 的「does not share a Chinese name with another source」）。

/** 画面里写中文用的两种字体（上游 lib/fonts.js 的 family）：霞鹜文楷，或思源黑体粗体（上游沿用 PuHui-Bold 这个名字）。 */
export const KaiFont = 'LXGWWenKai-500';
export const SansFont = 'PuHui-Bold';

export interface ZhEntry {
  slug: string;
  cn: string;
  en: string;
  category_cn: string;
  category_en: string;
  /** 适合的题材。 */
  uses: string[];
  cjk: typeof KaiFont | typeof SansFont;
  /** 在总览图里的格子：row * 6 + col。 */
  cell: number;
}

const ancient = { category_cn: '古代', category_en: 'Ancient' };
const medieval = { category_cn: '中世纪与文艺复兴', category_en: 'Medieval and Renaissance' };
const impressionist = { category_cn: '印象派与后印象派', category_en: 'Impressionism' };
const modern = { category_cn: '现代艺术', category_en: 'Modern art' };
const digital = { category_cn: '数字', category_en: 'Digital' };

export const zhTable: Record<string, ZhEntry> = {
  '01_cave': { slug: 'cave-painting', cn: '洞穴岩画', en: 'Cave painting', ...ancient, uses: ['人类起源', '远古与考古', '狩猎与自然'], cjk: KaiFont, cell: 0 },
  '02_egypt': { slug: 'egyptian-tomb', cn: '古埃及墓室壁画', en: 'Egyptian tomb painting', ...ancient, uses: ['古埃及与古文明', '农业与手工业起源', '神话与信仰'], cjk: KaiFont, cell: 1 },
  '03_greek': { slug: 'greek-black-figure', cn: '古希腊黑绘陶', en: 'Attic black-figure pottery', ...ancient, uses: ['古希腊与西方源头', '神话与史诗', '哲学与体育'], cjk: KaiFont, cell: 2 },
  '04_roman': { slug: 'roman-mosaic', cn: '庞贝马赛克', en: 'Pompeii mosaic', ...ancient, uses: ['罗马与地中海', '城市与建筑史', '考古'], cjk: KaiFont, cell: 3 },
  '20_dunhuang': { slug: 'dunhuang-mural', cn: '敦煌壁画', en: 'Dunhuang mural', ...ancient, uses: ['丝绸之路', '佛教与传统文化', '中国艺术史'], cjk: KaiFont, cell: 4 },
  '05_gothic': { slug: 'gothic-illumination', cn: '哥特泥金手抄本', en: 'Gothic illuminated manuscript', ...medieval, uses: ['中世纪', '书籍与知识史', '宗教与传说'], cjk: KaiFont, cell: 6 },
  '06_renaissance': { slug: 'renaissance-sfumato', cn: '文艺复兴晕涂', en: 'Renaissance sfumato', ...medieval, uses: ['文艺复兴', '发明与科学史', '人物传记'], cjk: KaiFont, cell: 7 },
  '08_impressionism': { slug: 'impressionism', cn: '印象派外光', en: 'Impressionism', ...impressionist, uses: ['城市与生活', '光与色彩', '抒情'], cjk: KaiFont, cell: 10 },
  '29_seurat': { slug: 'seurat-pointillism', cn: '修拉点彩', en: 'Seurat pointillism', ...impressionist, uses: ['色彩与视觉科学', '公园与日常', '安静叙事'], cjk: KaiFont, cell: 11 },
  '09_postimp': { slug: 'van-gogh', cn: '梵高旋涡笔触', en: 'Van Gogh post-impressionism', ...impressionist, uses: ['夜空与天文', '艺术家传记', '情绪与内心'], cjk: KaiFont, cell: 12 },
  '19_munch': { slug: 'munch-expressionism', cn: '蒙克表现主义', en: 'Munch expressionism', ...modern, uses: ['焦虑与心理', '社会情绪', '压迫感叙事'], cjk: KaiFont, cell: 13 },
  '10_nouveau': { slug: 'art-nouveau', cn: '慕夏新艺术海报', en: 'Art Nouveau poster', ...modern, uses: ['广告与品牌史', '自然与装饰', '优雅叙事'], cjk: KaiFont, cell: 14 },
  '28_monet': { slug: 'monet-water-lilies', cn: '莫奈睡莲', en: 'Monet water lilies', ...impressionist, uses: ['自然与园林', '季节与时间', '抒情'], cjk: KaiFont, cell: 15 },
  '36_picasso_blue': { slug: 'picasso-blue-period', cn: '毕加索蓝色时期', en: 'Picasso Blue Period', ...modern, uses: ['孤独与贫困', '人物命运', '忧郁叙事'], cjk: KaiFont, cell: 16 },
  '18_klimt': { slug: 'klimt-golden', cn: '克里姆特金箔', en: 'Klimt golden phase', ...modern, uses: ['爱情与人物', '奢华与装饰', '维也纳与世纪末'], cjk: KaiFont, cell: 17 },
  '11_cubism': { slug: 'analytic-cubism', cn: '分析立体主义', en: 'Analytic Cubism', ...modern, uses: ['多视角与认知', '城市与咖啡馆', '现代艺术史'], cjk: KaiFont, cell: 18 },
  '12_bauhaus': { slug: 'bauhaus', cn: '包豪斯构成', en: 'Bauhaus', ...modern, uses: ['设计史', '工业与产品', '几何与秩序'], cjk: SansFont, cell: 19 },
  '22_constructivism': { slug: 'constructivism', cn: '俄国构成主义', en: 'Russian Constructivism', ...modern, uses: ['宣传与口号', '工业与革命', '强节奏标语'], cjk: SansFont, cell: 20 },
  '23_dali': { slug: 'dali-surrealism', cn: '达利超现实', en: 'Dalí surrealism', ...modern, uses: ['时间与记忆', '梦境与心理', '荒诞'], cjk: KaiFont, cell: 22 },
  '24_hopper': { slug: 'hopper-realism', cn: '霍珀光影', en: 'Hopper American realism', ...modern, uses: ['都市孤独', '城市与日常', '安静叙事'], cjk: KaiFont, cell: 23 },
  '30_matisse': { slug: 'matisse-cutouts', cn: '马蒂斯剪纸', en: 'Matisse cut-outs', ...modern, uses: ['海洋与自然', '轻快艺术', '儿童与创造力'], cjk: KaiFont, cell: 24 },
  '13_pop': { slug: 'pop-art', cn: '利希滕斯坦波普', en: 'Lichtenstein pop art', ...modern, uses: ['消费与广告', '流行文化', '戏剧化转折'], cjk: SansFont, cell: 25 },
  '21_kusama': { slug: 'kusama-dots', cn: '草间弥生波点', en: 'Kusama polka dots', ...modern, uses: ['重复与无限', '心理与执念', '当代艺术'], cjk: KaiFont, cell: 26 },
  '31_haring': { slug: 'keith-haring', cn: '凯斯·哈林街头涂鸦', en: 'Keith Haring', ...modern, uses: ['街头与音乐', '社会议题', '节奏感讲解'], cjk: SansFont, cell: 28 },
  '15_raytrace': { slug: 'raytrace-cgi', cn: '早期光追CGI', en: 'Early ray-traced CGI', ...digital, uses: ['计算机图形史', '科技怀旧', '90 年代'], cjk: SansFont, cell: 31 },
  '26_vaporwave': { slug: 'vaporwave', cn: '蒸汽波霓虹', en: 'Vaporwave', ...digital, uses: ['互联网怀旧', '消费与都市', '赛博与霓虹'], cjk: SansFont, cell: 32 },
};
