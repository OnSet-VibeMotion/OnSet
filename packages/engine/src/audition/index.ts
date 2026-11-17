// Package audition：试镜——同一镜头、同一份冻结输入，几位选手（渲染工具 + 模型）各渲染一遍，由人盲评，采用胜者；
// 由评判累积学习关系（learning）、向老师学（learn）、范例库（exemplars）、人评考试与按镜头分派的推荐。
export * from './audition';
export * from './exemplars';
export * from './learn';
export * from './learning';
export * from './exam';
export * from './aftervote';
export * from './run';
