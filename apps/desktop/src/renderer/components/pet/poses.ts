import { P, type Pt } from './iso';

/** 人自己的坐标：f 向前、r 向右、z 向上。 */
export type L3 = [number, number, number];

export interface Body {
  hipL: L3;
  hipR: L3;
  kneeL: L3;
  kneeR: L3;
  footL: L3;
  footR: L3;
  shL: L3;
  shR: L3;
  elL: L3;
  elR: L3;
  haL: L3;
  haR: L3;
  head: L3;
}

export type Pose =
  | 'stand'
  | 'walk'
  | 'sit'
  | 'think'
  | 'type'
  | 'stretch'
  | 'operate'
  | 'read'
  | 'write'
  | 'point'
  | 'slate'
  | 'cheer'
  | 'slump'
  | 'cross'
  | 'mic'
  | 'script'
  // 闲着时的姿势：打盹、往后靠、看手机、端杯子喝、聊天、笑、背着手看、站着比划。
  | 'doze'
  | 'lean'
  | 'phone'
  | 'sitSip'
  | 'talk'
  | 'laugh'
  | 'look'
  | 'standTalk'
  // 安装页里赶路的人：抱着自己的器材走、跑，或站着抱着。
  | 'carry'
  | 'carryRun'
  | 'hold';

/** 坐着的姿势（气泡按坐着的头高放）。 */
export const seatedPoses = new Set<Pose>([
  'sit',
  'think',
  'type',
  'stretch',
  'script',
  'doze',
  'lean',
  'phone',
  'sitSip',
  'talk',
  'laugh',
]);

/** 端着杯子的人此刻是不是举到嘴边。 */
export const sipping = (t: number) => Math.sin(t / 1700) > 0.55;

function setSeated(b: Body): void {
  b.hipL = [-0.05, -0.1, 0.5];
  b.hipR = [-0.05, 0.1, 0.5];
  b.kneeL = [0.36, -0.11, 0.5];
  b.kneeR = [0.36, 0.11, 0.5];
  b.footL = [0.4, -0.11, 0.04];
  b.footR = [0.4, 0.11, 0.04];
  b.shL = [-0.08, -0.18, 0.94];
  b.shR = [-0.08, 0.18, 0.94];
  b.elL = [0.08, -0.22, 0.7];
  b.elR = [0.08, 0.22, 0.7];
  b.haL = [0.28, -0.12, 0.62];
  b.haR = [0.28, 0.12, 0.62];
  b.head = [-0.06, 0, 1.17];
}

function applyIdleAndCarryPose(b: Body, pose: Pose, t: number, sway: number): boolean {
  switch (pose) {
    case 'doze': {
      setSeated(b);
      const nod = Math.sin(t / 1300) * 0.02;
      b.shL = [-0.1, -0.18, 0.92];
      b.shR = [-0.1, 0.18, 0.92];
      b.elL = [0.05, -0.22, 0.66];
      b.elR = [0.05, 0.22, 0.66];
      b.haL = [0.22, -0.08, 0.56];
      b.haR = [0.22, 0.08, 0.56];
      b.head = [0.06, 0.06, 1.08 + nod];
      return true;
    }
    case 'lean':
      setSeated(b);
      b.shL = [-0.14, -0.18, 0.92];
      b.shR = [-0.14, 0.18, 0.92];
      b.elL = [-0.16, -0.36, 0.86];
      b.elR = [-0.16, 0.36, 0.86];
      b.haL = [-0.2, -0.48, 0.92];
      b.haR = [-0.2, 0.48, 0.92];
      b.head = [-0.12, sway * 2, 1.15];
      return true;
    case 'phone':
      setSeated(b);
      b.elL = [0.1, -0.2, 0.7];
      b.elR = [0.1, 0.2, 0.7];
      b.haL = [0.28, -0.04, 0.84];
      b.haR = [0.28, 0.04, 0.84];
      b.head = [0.02, 0, 1.12];
      return true;
    case 'sitSip': {
      setSeated(b);
      const up = sipping(t);
      b.elR = up ? [0.14, 0.2, 0.84] : [0.16, 0.22, 0.68];
      b.haR = up ? [0.1, 0.06, 1.08] : [0.3, 0.14, 0.8];
      b.head = up ? [-0.09, 0, 1.17] : [-0.06, 0, 1.17];
      return true;
    }
    case 'talk': {
      setSeated(b);
      const g = Math.sin(t / 260);
      b.elR = [0.16, 0.26, 0.8];
      b.haR = [0.34, 0.22, 0.92 + g * 0.05];
      b.head = [-0.04, 0, 1.17 + Math.abs(g) * 0.012];
      return true;
    }
    case 'laugh': {
      setSeated(b);
      const h = Math.abs(Math.sin(t / 140));
      b.shL = [-0.08, -0.18, 0.94 + h * 0.02];
      b.shR = [-0.08, 0.18, 0.94 + h * 0.02];
      b.elL = [0.06, -0.22, 0.72];
      b.elR = [0.06, 0.22, 0.72];
      b.haL = [0.16, -0.06, 0.7];
      b.haR = [0.16, 0.06, 0.7];
      b.head = [-0.12, 0, 1.17 + h * 0.03];
      return true;
    }
    case 'look':
      b.elL = [-0.1, -0.22, 1.04];
      b.elR = [-0.1, 0.22, 1.04];
      b.haL = [-0.16, -0.06, 0.92];
      b.haR = [-0.16, 0.06, 0.92];
      b.head = [0.02, Math.sin(t / 1500) * 0.04, 1.53];
      return true;
    case 'standTalk': {
      const g = Math.sin(t / 240);
      b.elR = [0.2, 0.26, 1.12];
      b.haR = [0.4, 0.24, 1.24 + g * 0.06];
      b.elL = [0.1, -0.24, 1.0];
      b.haL = [0.2, -0.2, 0.86];
      b.head = [0.02, 0, 1.53 + Math.abs(g) * 0.012];
      return true;
    }
    case 'carry':
    case 'carryRun': {
      // 腿照走路摆（跑的时候步子大、抬腿高、身子前倾），胳膊抱在胸前。
      const run = pose === 'carryRun';
      const s = Math.sin(t / (run ? 85 : 110));
      const c = Math.cos(t / (run ? 85 : 110));
      const stride = run ? 0.32 : 0.22;
      const lift = run ? 0.16 : 0.08;
      const lean = run ? 0.08 : 0.02;
      const kLiftL = run ? 0.06 * Math.max(0, c) : 0;
      const kLiftR = run ? 0.06 * Math.max(0, -c) : 0;
      b.footL = [stride * s, -0.1, 0.04 + Math.max(0, lift * c)];
      b.footR = [-stride * s, 0.1, 0.04 + Math.max(0, -lift * c)];
      b.kneeL = [stride * 0.55 * s + 0.05 + kLiftL, -0.09, 0.46 + kLiftL];
      b.kneeR = [-stride * 0.55 * s + 0.05 + kLiftR, 0.09, 0.46 + kLiftR];
      b.shL = [lean, -0.18, 1.3];
      b.shR = [lean, 0.18, 1.3];
      b.elL = [0.14 + lean, -0.22, 1.04];
      b.elR = [0.14 + lean, 0.22, 1.04];
      b.haL = [0.3 + lean, -0.09, 1.12];
      b.haR = [0.3 + lean, 0.09, 1.12];
      b.head = [0.03 + lean * 1.4, 0, 1.53 + Math.abs(c) * (run ? 0.04 : 0.02)];
      return true;
    }
    case 'hold':
      b.elL = [0.14, -0.22, 1.04];
      b.elR = [0.14, 0.22, 1.04];
      b.haL = [0.3, -0.09, 1.12];
      b.haR = [0.3, 0.09, 1.12];
      b.head = [0.03, sway * 2, 1.53];
      return true;
    default:
      return false;
  }
}

export function body(pose: Pose, t: number): Body {
  const b: Body = {
    hipL: [0, -0.09, 0.86],
    hipR: [0, 0.09, 0.86],
    kneeL: [0.03, -0.09, 0.46],
    kneeR: [0.03, 0.09, 0.46],
    footL: [0, -0.1, 0.04],
    footR: [0, 0.1, 0.04],
    shL: [0, -0.18, 1.3],
    shR: [0, 0.18, 1.3],
    elL: [0.02, -0.22, 1.03],
    elR: [0.02, 0.22, 1.03],
    haL: [0.06, -0.21, 0.8],
    haR: [0.06, 0.21, 0.8],
    head: [0, 0, 1.53],
  };
  const sway = Math.sin(t / 900) * 0.012;
  if (!applyIdleAndCarryPose(b, pose, t, sway)) {
    switch (pose) {
      case 'walk': {
        const s = Math.sin(t / 110);
        const c = Math.cos(t / 110);
        b.footL = [0.22 * s, -0.1, 0.04 + Math.max(0, 0.08 * c)];
        b.footR = [-0.22 * s, 0.1, 0.04 + Math.max(0, -0.08 * c)];
        b.kneeL = [0.12 * s + 0.05, -0.09, 0.46];
        b.kneeR = [-0.12 * s + 0.05, 0.09, 0.46];
        b.elL = [-0.08 * s, -0.22, 1.03];
        b.elR = [0.08 * s, 0.22, 1.03];
        b.haL = [-0.18 * s, -0.21, 0.82];
        b.haR = [0.18 * s, 0.21, 0.82];
        b.head = [0.02, 0, 1.53 + Math.abs(c) * 0.02];
        break;
      }
      case 'sit':
        setSeated(b);
        b.head = [-0.06, sway * 2, 1.17];
        break;
      case 'think':
        setSeated(b);
        b.elR = [0.26, 0.16, 0.86];
        b.haR = [0.1, 0.05, 1.06];
        b.head = [0.0, 0.02, 1.17];
        break;
      case 'script':
        setSeated(b);
        b.elL = [0.14, -0.2, 0.74];
        b.elR = [0.14, 0.2, 0.74];
        b.haL = [0.32, -0.1, 0.86];
        b.haR = [0.32, 0.1, 0.86];
        b.head = [0.0, 0, 1.15];
        break;
      case 'type': {
        setSeated(b);
        const k = Math.sin(t / 70);
        b.shL = [0.0, -0.18, 0.96];
        b.shR = [0.0, 0.18, 0.96];
        b.elL = [0.22, -0.22, 0.76];
        b.elR = [0.22, 0.22, 0.76];
        b.haL = [0.44, -0.1, 0.8 + Math.max(0, k) * 0.04];
        b.haR = [0.44, 0.1, 0.8 + Math.max(0, -k) * 0.04];
        b.head = [0.06, 0, 1.18];
        break;
      }
      case 'stretch':
        setSeated(b);
        b.elL = [-0.02, -0.3, 1.18];
        b.elR = [-0.02, 0.3, 1.18];
        b.haL = [-0.12, -0.08, 1.24];
        b.haR = [-0.12, 0.08, 1.24];
        b.head = [-0.08, 0, 1.17];
        break;
      case 'operate':
        b.elL = [0.22, -0.24, 1.15];
        b.elR = [0.22, 0.24, 1.15];
        b.haL = [0.42, -0.14, 1.3 + sway];
        b.haR = [0.42, 0.14, 1.3 - sway];
        b.head = [0.06, 0, 1.53];
        break;
      case 'read': {
        const flip = Math.sin(t / 600) * 0.02;
        b.elL = [0.12, -0.22, 1.02];
        b.elR = [0.12, 0.22, 1.02];
        b.haL = [0.32, -0.12, 1.1 + flip];
        b.haR = [0.32, 0.12, 1.1 - flip];
        b.head = [0.05, 0, 1.51];
        break;
      }
      case 'write': {
        const w = Math.sin(t / 140) * 0.06;
        b.shL = [0.05, -0.18, 1.27];
        b.shR = [0.05, 0.18, 1.27];
        b.elL = [0.22, -0.22, 1.02];
        b.elR = [0.24, 0.2, 1.0];
        b.haL = [0.42, -0.14, 0.9];
        b.haR = [0.44, 0.06 + w, 0.9];
        b.head = [0.12, 0, 1.46];
        break;
      }
      case 'point':
        b.elR = [0.24, 0.24, 1.32];
        b.haR = [0.5, 0.26, 1.46];
        break;
      case 'slate': {
        const bob = Math.sin(t / 300) * 0.03;
        b.elL = [0.14, -0.22, 0.98];
        b.elR = [0.16, 0.24, 1.0];
        b.haL = [0.3, 0.0, 1.06 + bob];
        b.haR = [0.3, 0.34, 1.06 + bob];
        break;
      }
      case 'cheer': {
        const up = Math.abs(Math.sin(t / 220));
        b.elL = [0.04, -0.3, 1.5];
        b.elR = [0.04, 0.3, 1.5];
        b.haL = [0.06, -0.26, 1.76 + up * 0.04];
        b.haR = [0.06, 0.26, 1.76 + up * 0.04];
        b.head = [0, 0, 1.55 + up * 0.03];
        break;
      }
      case 'slump':
        b.shL = [0.06, -0.17, 1.24];
        b.shR = [0.06, 0.17, 1.24];
        b.elL = [0.06, -0.2, 0.98];
        b.elR = [0.06, 0.2, 0.98];
        b.haL = [0.08, -0.18, 0.74];
        b.haR = [0.08, 0.18, 0.74];
        b.head = [0.16, 0, 1.38];
        break;
      case 'cross':
        b.elL = [0.14, -0.22, 1.08];
        b.elR = [0.14, 0.22, 1.08];
        b.haL = [0.16, 0.12, 1.14];
        b.haR = [0.16, -0.12, 1.12];
        b.head = [0.02, sway * 3, 1.53];
        break;
      case 'mic':
        b.elR = [0.16, 0.24, 1.08];
        b.haR = [0.2, 0.2, 1.3];
        b.head = [0.06, 0, 1.53];
        break;
      default:
        b.head = [0, sway * 2, 1.53];
    }
  }
  // 呼吸：不走路时肩和头跟着一起一伏，站着、坐着都不是僵住的。
  if (pose !== 'walk' && pose !== 'carry' && pose !== 'carryRun') {
    const br = Math.sin(t / 650) * 0.008;
    b.head = [b.head[0], b.head[1], b.head[2] + br];
    b.shL = [b.shL[0], b.shL[1], b.shL[2] + br * 0.6];
    b.shR = [b.shR[0], b.shR[1], b.shR[2] + br * 0.6];
  }
  return b;
}

/** 一个人身上某个关节此刻在画布上的位置（与 person 同一种投影），给手里的东西用。 */
export function jointAt(x: number, y: number, a: number, pose: Pose, t: number, j: keyof Body): Pt {
  const [f, r, z] = body(pose, t)[j];
  return P(x + f * Math.cos(a) - r * Math.sin(a), y + f * Math.sin(a) + r * Math.cos(a), z);
}
