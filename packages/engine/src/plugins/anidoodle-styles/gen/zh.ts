//
// anidoodle 风格的中文名、分类、示范画与适用题材（上游只有英文），以及每种风格在上游图鉴
// skills/anidoodle/assets/styles.jpg 里的格子（8 列 4 行，行优先，从 0 数）。
//
// 生成器（main.ts）要求这张表与固定 commit 上的风格一一对应，多一条少一条都报错。
// 升级 PinnedCommit 时上游加了风格，要在这里补一行；图鉴重排了，要重填 cell。

export interface ZhEntry {
  cn: string;
  category_cn: string;
  /** 上游示范画画的是什么。 */
  hero_cn: string;
  /** 适合的题材。 */
  uses: string[];
  /** 在图鉴里的格子：row * 8 + col。 */
  cell: number;
}

export const zhTable: Record<string, ZhEntry> = {
  ranunculus: { cn: '铅笔淡彩', category_cn: '水彩', hero_cn: '一朵盛开的毛茛', uses: ['花草静物', '生活随笔', '温柔叙事'], cell: 0 },
  colouredPencil: { cn: '彩色铅笔', category_cn: '干性画材', hero_cn: '修八音盒的铁皮机器人与偷螺丝的乌鸦', uses: ['童趣故事', '手作与日常', '科普小品'], cell: 1 },
  koi: { cn: '马克笔漫画', category_cn: '漫画', hero_cn: '荷叶下转身的锦鲤', uses: ['轻松科普', '角色故事', '社交短片'], cell: 2 },
  scrapbook: { cn: '档案剪贴簿', category_cn: '拼贴', hero_cn: '蜜蜂怎样找到花：采集蜂、玫瑰、摇摆舞与证据', uses: ['历史考据', '调查报道', '自然科普'], cell: 3 },
  pixelArt: { cn: '像素画', category_cn: '数字', hero_cn: '月夜花园里扑萤火虫的猫', uses: ['游戏与科技', '怀旧', '轻松解说'], cell: 4 },
  sumiE: { cn: '水墨画', category_cn: '墨', hero_cn: '风中翠竹与麻雀', uses: ['传统文化', '诗词', '哲思'], cell: 5 },
  woodcut: { cn: '浮世绘木版', category_cn: '版画与印刷', hero_cn: '雨中太鼓桥上的两只苍鹭', uses: ['日本文化', '历史故事', '风物'], cell: 6 },
  toyBrick: { cn: '塑料积木', category_cn: '渲染', hero_cn: '底板上的积木港口拖船', uses: ['儿童科普', '工程与结构', '轻松解说'], cell: 7 },
  pocketWatch: { cn: '圆珠笔速写', category_cn: '钢笔', hero_cn: '桌上的一只怀表', uses: ['笔记感讲解', '个人随笔', '机械与物件'], cell: 8 },
  brokenColour: { cn: '碎色油画', category_cn: '油画', hero_cn: '日出时的小港口', uses: ['风景与城市', '艺术史', '抒情'], cell: 9 },
  scratchboard: { cn: '刮画', category_cn: '墨', hero_cn: '月光下猞猁的头肩像', uses: ['悬疑与夜景', '动物', '强对比叙事'], cell: 10 },
  isometric: { cn: '等轴剖面', category_cn: '数字', hero_cn: '夜里亮着炉火的两层面包房剖面', uses: ['流程与系统', '商业解说', '空间结构'], cell: 11 },
  balloon: { cn: '蜡笔', category_cn: '干性画材', hero_cn: '一只热气球', uses: ['儿童内容', '童趣故事', '温暖日常'], cell: 12 },
  paintedOil: { cn: '布面油画', category_cn: '油画', hero_cn: '窗边的两只梨与铜锅', uses: ['人物与历史', '艺术史', '厚重叙事'], cell: 13 },
  embroidery: { cn: '手工刺绣', category_cn: '织物', hero_cn: '带蜜蜂的植物花环', uses: ['手作与生活', '节日', '温柔叙事'], cell: 14 },
  halftone: { cn: '报纸网点', category_cn: '版画与印刷', hero_cn: '黄昏时驶过石拱桥的蒸汽火车', uses: ['新闻与时事', '历史回顾', '复古宣传'], cell: 15 },
  wren: { cn: '墨线淡彩', category_cn: '墨', hero_cn: '一只鹪鹩', uses: ['自然笔记', '旅行', '随笔'], cell: 16 },
  midCentury: { cn: '世纪中期水粉', category_cn: '复古绘本', hero_cn: '山坡小镇上放风筝的女孩', uses: ['城市与生活', '复古', '童趣故事'], cell: 17 },
  stipple: { cn: '针管点画', category_cn: '墨', hero_cn: '剖开的鹦鹉螺壳', uses: ['科学插图', '自然科普', '精细结构'], cell: 18 },
  lowPoly: { cn: '低多边形', category_cn: '代码 3D', hero_cn: '黎明的山间湖泊与红色独木舟', uses: ['地理与风景', '科技', '氛围'], cell: 19 },
  moonPhases: { cn: '石板粉笔', category_cn: '粉笔', hero_cn: '月相', uses: ['课堂讲解', '数理推导', '知识科普'], cell: 20 },
  charcoalErasure: { cn: '炭笔擦改', category_cn: '干性画材', hero_cn: '一张纸上的一棵橡树走过四季', uses: ['时间流逝', '记忆与变化', '沉重叙事'], cell: 21 },
  rubberHose: { cn: '橡皮管卡通', category_cn: '老式卡通', hero_cn: '在厨房台面上跳舞的咖啡壶', uses: ['幽默', '复古', '拟人化讲解'], cell: 22 },
  flatVector: { cn: '扁平矢量', category_cn: '扁平插画', hero_cn: '海湾里绕标的小帆船队', uses: ['商业与产品', '数据解说', '轻快科普'], cell: 23 },
  fox: { cn: '撕纸拼贴', category_cn: '拼贴', hero_cn: '黄昏的一只狐狸', uses: ['童话', '自然', '温暖叙事'], cell: 24 },
  paperCraft: { cn: '纸偶剧场拼贴', category_cn: '拼贴', hero_cn: '玩具剧场舞台上的海边小镇', uses: ['故事讲述', '童话', '舞台感叙事'], cell: 25 },
  lighthouse: { cn: '孔版印刷', category_cn: '版画与印刷', hero_cn: '日落时的灯塔', uses: ['海报感', '文艺', '独立出版'], cell: 26 },
  blueprint: { cn: '蓝图晒印', category_cn: '技术制图', hero_cn: '怀表传动轮系的平面与剖面', uses: ['机械原理', '工程', '发明史'], cell: 27 },
  mellan: { cn: '单线雕刻', category_cn: '雕刻', hero_cn: '一根线盘出的月亮', uses: ['天文', '肖像', '极简'], cell: 28 },
  storybook: { cn: '绘本铅笔水彩', category_cn: '水彩', hero_cn: '挥手的小机器人 Bit', uses: ['儿童绘本', '角色故事', '温柔科普'], cell: 29 },
  folkTale: { cn: '民间故事绘本', category_cn: '绘画', hero_cn: '桦树林边菜园里抱着公鸡的男孩', uses: ['民间故事', '乡土', '童话'], cell: 30 },
  dreamGlaze: { cn: '梦境罩染', category_cn: '绘画', hero_cn: '沙漠里被问号托起的空心面具', uses: ['超现实', '心理与哲思', '梦境'], cell: 31 },
};
