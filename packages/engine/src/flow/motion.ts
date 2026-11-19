import { isObject, knownFields, str, strings } from './fields';

export const MotionPromptID = 'motion-prompt';

export interface MotionEffect {
  id: string;
  name: string;
  category: string;
  summary: string;
  aliases?: string[];
  example?: string;
  spec?: string[];
  example_url?: string;
  renderer_skill?: string;
}

export function parseMotionEffects(value: unknown, skills: readonly { name: string }[]): MotionEffect[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('station.motion_effects 要是数组');
  const ids = new Set<string>();
  return value.map((effect: unknown, index) => {
    const where = `motion_effects[${index}]`;
    if (!isObject(effect)) throw new Error(`${where} 要是对象`);
    knownFields(effect, ['id', 'name', 'category', 'summary', 'aliases', 'example', 'spec', 'example_url', 'renderer_skill'], where);
    const id = str(effect, 'id', where);
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error(`${where}.id 要是小写字母、数字与连字符`);
    if (ids.has(id)) throw new Error(`station.motion_effects 里有重名的动效：${id}`);
    ids.add(id);
    const rendererSkill = str(effect, 'renderer_skill', where, false);
    if (rendererSkill && !skills.some((skill) => skill.name === rendererSkill)) {
      throw new Error(`${where}.renderer_skill：没有登记渲染技能 ${rendererSkill}`);
    }
    const exampleURL = str(effect, 'example_url', where, false);
    const url = exampleURL ? URL.parse(exampleURL) : null;
    if (exampleURL && (url?.protocol !== 'https:' || url.username || url.password)) {
      throw new Error(`${where}.example_url 要是没有凭据的 HTTPS 地址`);
    }
    const aliases = strings(effect, 'aliases', where);
    const spec = strings(effect, 'spec', where);
    const example = str(effect, 'example', where, false);
    return {
      id,
      name: str(effect, 'name', where),
      category: str(effect, 'category', where),
      summary: str(effect, 'summary', where),
      ...(aliases.length ? { aliases } : {}),
      ...(spec.length ? { spec } : {}),
      ...(example ? { example } : {}),
      ...(url ? { example_url: url.href } : {}),
      ...(rendererSkill ? { renderer_skill: rendererSkill } : {}),
    };
  });
}
