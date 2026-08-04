import {
  Box3,
  BoxGeometry,
  DynamicDrawUsage,
  Euler,
  Group,
  InstancedMesh,
  Matrix4,
  Quaternion,
  Vector3,
  type Material,
} from 'three';
import { MOB_DEATH_DURATION, type Mob, type MobType } from '../../lib/mobs';
import { professionOf } from '../../lib/trading';

/**
 * 生物渲染实例化：同种同变体生物的每个部件层（几何×材质）共用一个 InstancedMesh，
 * draw call 从 O(生物数×部件数) 降到 O(变体数×部件层数)。
 * 现有生物动画全部是整体级（根节点 position/rotation.y/rotation.z/scale，无部件级动画），
 * 因此每帧只需按生物位姿合成根矩阵、再右乘静态部件局部矩阵写入实例缓冲。
 * 本文件不依赖 React/DOM，可在 Node 下纯函数自测（见 __tests__/mob-instancing.test.ts）。
 */

// ——— 部件几何注册表（模块级共享常量，与此前 Mobs.tsx 内联常量一一对应） ———
function geo(w: number, h: number, d: number): BoxGeometry {
  return new BoxGeometry(w, h, d);
}
export const MOB_GEOS: Record<string, BoxGeometry> = {
  head: geo(0.42, 0.42, 0.42),
  body: geo(0.5, 0.7, 0.28),
  leg: geo(0.2, 0.75, 0.22),
  arm: geo(0.18, 0.6, 0.2),
  // MC 僵尸招牌姿势：双臂前平举（水平臂几何）
  armForward: geo(0.18, 0.18, 0.55),
  bodyWide: geo(0.9, 0.5, 0.4),
  pigLeg: geo(0.12, 0.3, 0.12),
  chickenBody: geo(0.32, 0.35, 0.35),
  chickenHead: geo(0.2, 0.2, 0.2),
  beak: geo(0.08, 0.06, 0.12),
  spiderBody: geo(0.9, 0.35, 0.7),
  spiderHead: geo(0.35, 0.3, 0.3),
  spiderLeg: geo(0.55, 0.06, 0.06),
  creeperBody: geo(0.45, 0.85, 0.3),
  creeperFace: geo(0.3, 0.3, 0.02),
  snout: geo(0.16, 0.14, 0.08),
  horn: geo(0.08, 0.12, 0.08),
  shroom: geo(0.14, 0.06, 0.14),
  shroomCap: geo(0.18, 0.06, 0.18),
  sword: geo(0.05, 0.5, 0.05),
  blazeRod: geo(0.09, 0.9, 0.09),
  ghastBody: geo(2.2, 2.2, 2.2),
  ghastTentacle: geo(0.22, 1.1, 0.22),
  // 快乐恶魂链（1.21.6）：小恶魂小方体 + 快乐恶魂巨体（比恶魂更大）+ 鞍具（鞍座与护目镜）
  ghastlingBody: geo(0.9, 0.9, 0.9),
  ghastlingTentacle: geo(0.12, 0.5, 0.12),
  happyGhastBody: geo(3.0, 3.0, 3.0),
  happyGhastTentacle: geo(0.3, 1.4, 0.3),
  ghastEye: geo(0.3, 0.3, 0.06),
  ghastMouth: geo(0.5, 0.12, 0.06),
  harnessSeat: geo(1.6, 0.35, 1.6),
  harnessGoggles: geo(1.6, 0.5, 0.25),
  sheepWool: geo(1.0, 0.62, 0.62),
  sheepSlim: geo(0.7, 0.42, 0.42),
  sheepHead: geo(0.36, 0.3, 0.3),
  wolfBody: geo(0.55, 0.4, 0.9),
  wolfHead: geo(0.34, 0.3, 0.34),
  wolfEar: geo(0.08, 0.14, 0.08),
  wolfTail: geo(0.12, 0.12, 0.45),
  collar: geo(0.4, 0.14, 0.14),
  enderLeg: geo(0.18, 1.2, 0.18),
  enderBody: geo(0.42, 1.1, 0.26),
  enderArm: geo(0.12, 1.4, 0.12),
  enderEye: geo(0.08, 0.06, 0.02),
  witherRib: geo(0.7, 0.16, 0.3),
  witherHead: geo(0.44, 0.44, 0.44),
  witherSideHead: geo(0.34, 0.34, 0.34),
  // 末影龙：躯干纵贯 z 轴（头朝 +z，与 mob 朝向 yaw 一致），部件以体心为原点
  dragonBody: geo(1.1, 1, 4.2),
  dragonNeck: geo(0.55, 0.55, 1.1),
  dragonHead: geo(0.85, 0.85, 1.3),
  dragonSnout: geo(0.5, 0.4, 0.6),
  dragonHorn: geo(0.12, 0.5, 0.12),
  dragonTail: geo(0.55, 0.55, 2.2),
  dragonTailTip: geo(0.3, 0.3, 1.8),
  dragonWing: geo(3.2, 0.12, 1.7),
  dragonEyeBand: geo(0.9, 0.15, 0.15),
  shulkerBase: geo(0.9, 0.55, 0.9),
  shulkerLid: geo(0.8, 0.35, 0.8),
  slimeBody: geo(1.2, 1.2, 1.2),
  slimeEye: geo(0.14, 0.14, 0.04),
  slimeMouth: geo(0.32, 0.09, 0.04),
  // 幻翼：扁平翼膜 + 小身板（MC 鳐形）
  phantomBody: geo(0.9, 0.25, 0.5),
  phantomWing: geo(1.6, 0.08, 0.6),
  phantomTail: geo(0.3, 0.06, 0.5),
  phantomEye: geo(0.1, 0.08, 0.02),
  // 铁傀儡：高大人形部件（MC 2.7 格村庄守卫——宽肩、过膝长臂、大扁头+大鼻子）
  golemLeg: geo(0.26, 1.1, 0.3),
  golemBody: geo(0.95, 1.0, 0.55),
  golemArm: geo(0.26, 1.35, 0.26),
  golemHead: geo(0.58, 0.5, 0.5),
  golemNose: geo(0.12, 0.28, 0.14),
  golemVine: geo(0.14, 0.3, 0.04),
  // 铜傀儡（1.21.9）：约 1 格高的小傀儡——方头小身、细臂、小鼻、头顶短避雷针（MC 标志）
  copperBody: geo(0.4, 0.45, 0.28),
  copperHead: geo(0.36, 0.32, 0.32),
  copperArm: geo(0.1, 0.35, 0.1),
  copperNose: geo(0.08, 0.14, 0.1),
  copperRod: geo(0.05, 0.24, 0.05),
  // 村民：MC 大扁头 + 前垂大鼻子 + 抱臂长袍
  villagerHead: geo(0.52, 0.46, 0.46),
  villagerNose: geo(0.1, 0.24, 0.12),
  villagerArms: geo(0.56, 0.2, 0.3),
  // 受击红闪壳：单位盒按各生物部件包围盒缩放（略大于本体），不占位时写零缩放矩阵隐藏
  flash: geo(1, 1, 1),
};

/** 部件定义：几何键 + 材质键 + 局部偏移（rz = 绕 z 固定倾角，仅龙/幻翼翼膜用） */
export interface PartDef {
  geo: string;
  mat: string;
  x: number;
  y: number;
  z: number;
  rz?: number;
}

function pt(geoKey: string, mat: string, x: number, y: number, z: number, rz?: number): PartDef {
  return { geo: geoKey, mat, x, y, z, rz };
}

/**
 * 静态变体的部件表（与原 makeMobMesh 逐行对应；羊/狼/村民为动态变体，见 partsForVariant）。
 * 部件顺序与原 switch 一致（同层内顺序不影响渲染，仅便于对照）。
 * 牛/猪/鸡即温带（temperate）型；寒带/热带变种同形换料，见 partsForVariant（1.21.5）。
 */
const BASE_PARTS: Record<string, PartDef[]> = {
  zombie: [
    pt('leg', 'zombiePants', -0.13, 0.375, 0),
    pt('leg', 'zombiePants', 0.13, 0.375, 0),
    pt('body', 'zombieShirt', 0, 1.1, 0),
    // MC 僵尸双臂前平举（与肩同高，指向移动方向）
    pt('armForward', 'zombieSkin', -0.34, 1.32, 0.22),
    pt('armForward', 'zombieSkin', 0.34, 1.32, 0.22),
    pt('head', 'zombieSkin', 0, 1.66, 0),
  ],
  skeleton: [
    pt('leg', 'boneDark', -0.13, 0.375, 0),
    pt('leg', 'boneDark', 0.13, 0.375, 0),
    pt('body', 'bone', 0, 1.1, 0),
    pt('arm', 'bone', -0.34, 1.15, 0),
    pt('arm', 'bone', 0.34, 1.15, 0),
    pt('head', 'bone', 0, 1.66, 0),
  ],
  creeper: [
    pt('pigLeg', 'creeperDark', -0.12, 0.15, -0.12),
    pt('pigLeg', 'creeperDark', 0.12, 0.15, -0.12),
    pt('pigLeg', 'creeperDark', -0.12, 0.15, 0.12),
    pt('pigLeg', 'creeperDark', 0.12, 0.15, 0.12),
    pt('creeperBody', 'creeper', 0, 0.85, 0),
    pt('head', 'creeper', 0, 1.48, 0),
    pt('creeperFace', 'creeperDark', 0, 1.48, 0.22),
  ],
  spider: [
    pt('spiderBody', 'spider', 0, 0.4, 0),
    pt('spiderHead', 'spider', 0, 0.35, 0.5),
    ...[-1, 1].flatMap((side) =>
      [0, 1, 2, 3].map((i) => pt('spiderLeg', 'spider', side * 0.6, 0.3, -0.3 + i * 0.2)),
    ),
  ],
  pig: [
    pt('pigLeg', 'pigDark', -0.25, 0.15, -0.25),
    pt('pigLeg', 'pigDark', 0.25, 0.15, -0.25),
    pt('pigLeg', 'pigDark', -0.25, 0.15, 0.25),
    pt('pigLeg', 'pigDark', 0.25, 0.15, 0.25),
    pt('bodyWide', 'pig', 0, 0.55, 0),
    pt('head', 'pig', 0, 0.6, 0.55),
    pt('snout', 'pigDark', 0, 0.5, 0.79),
  ],
  cow: [
    pt('pigLeg', 'cow', -0.25, 0.15, -0.25),
    pt('pigLeg', 'cow', 0.25, 0.15, -0.25),
    pt('pigLeg', 'cow', -0.25, 0.15, 0.25),
    pt('pigLeg', 'cow', 0.25, 0.15, 0.25),
    pt('bodyWide', 'cow', 0, 0.6, 0),
    pt('head', 'cowLight', 0, 0.75, 0.55),
    pt('horn', 'cowLight', -0.18, 1.02, 0.55),
    pt('horn', 'cowLight', 0.18, 1.02, 0.55),
  ],
  mooshroom: [
    // 红身牛 + 背上蘑菇伞 + 白斑（MC 蘑菇牛）
    pt('pigLeg', 'mooshroom', -0.25, 0.15, -0.25),
    pt('pigLeg', 'mooshroom', 0.25, 0.15, -0.25),
    pt('pigLeg', 'mooshroom', -0.25, 0.15, 0.25),
    pt('pigLeg', 'mooshroom', 0.25, 0.15, 0.25),
    pt('bodyWide', 'mooshroom', 0, 0.6, 0),
    pt('head', 'mooshroomSpot', 0, 0.75, 0.55),
    pt('horn', 'mooshroomSpot', -0.18, 1.02, 0.55),
    pt('horn', 'mooshroomSpot', 0.18, 1.02, 0.55),
    // 背上三朵蘑菇（红伞白斑小方块）
    pt('shroom', 'mooshroom', -0.15, 1.05, -0.1),
    pt('shroomCap', 'mooshroomSpot', -0.15, 1.13, -0.1),
    pt('shroom', 'mooshroom', 0.18, 1.05, 0.15),
    pt('shroomCap', 'mooshroomSpot', 0.18, 1.13, 0.15),
    pt('shroom', 'mooshroom', 0, 1.05, -0.25),
    pt('shroomCap', 'mooshroomSpot', 0, 1.13, -0.25),
  ],
  zombified_piglin: [
    // 僵尸猪灵：腐粉与尸斑拼接的人形 + 金剑（与僵尸同款双臂前平举）
    pt('leg', 'piglinRot', -0.13, 0.375, 0),
    pt('leg', 'piglinRot', 0.13, 0.375, 0),
    pt('body', 'piglinSkin', 0, 1.1, 0),
    pt('armForward', 'piglinSkin', -0.34, 1.32, 0.22),
    pt('armForward', 'piglinRot', 0.34, 1.32, 0.22),
    pt('head', 'piglinSkin', 0, 1.66, 0),
    pt('snout', 'piglinRot', 0, 1.6, 0.22),
    pt('sword', 'goldSword', 0.42, 1.0, 0.1),
  ],
  piglin: [
    // 猪灵：粉棕皮猪人 + 金剑
    pt('leg', 'piglinDark', -0.13, 0.375, 0),
    pt('leg', 'piglinDark', 0.13, 0.375, 0),
    pt('body', 'piglinFlesh', 0, 1.1, 0),
    pt('arm', 'piglinFlesh', -0.34, 1.15, 0),
    pt('arm', 'piglinFlesh', 0.34, 1.15, 0),
    pt('head', 'piglinFlesh', 0, 1.66, 0),
    pt('snout', 'piglinDark', 0, 1.6, 0.22),
    pt('sword', 'goldSword', 0.42, 1.0, 0.1),
  ],
  piglin_brute: [
    // 猪灵蛮兵：深褐魁梧猪人 + 金斧（更高大，MC 堡垒守卫）
    pt('leg', 'bruteDark', -0.15, 0.375, 0),
    pt('leg', 'bruteDark', 0.15, 0.375, 0),
    pt('body', 'brute', 0, 1.15, 0),
    pt('arm', 'brute', -0.36, 1.2, 0),
    pt('arm', 'brute', 0.36, 1.2, 0),
    pt('head', 'brute', 0, 1.72, 0),
    pt('snout', 'bruteDark', 0, 1.66, 0.22),
    pt('sword', 'goldSword', 0.44, 1.05, 0.1),
  ],
  blaze: [
    // 烈焰人：明黄头 + 环身烈焰棒（MC 标志造型）
    pt('head', 'blaze', 0, 1.3, 0),
    pt('blazeRod', 'blazeRod', 0.3, 0.85, 0),
    pt('blazeRod', 'blazeRod', -0.3, 0.85, 0),
    pt('blazeRod', 'blazeRod', 0, 0.85, 0.3),
    pt('blazeRod', 'blazeRod', 0, 0.85, -0.3),
  ],
  wither_skeleton: [
    // 凋灵骷髅：炭黑高个 + 石剑
    pt('leg', 'wither', -0.13, 0.45, 0),
    pt('leg', 'wither', 0.13, 0.45, 0),
    pt('body', 'wither', 0, 1.25, 0),
    pt('arm', 'wither', -0.34, 1.3, 0),
    pt('arm', 'wither', 0.34, 1.3, 0),
    pt('head', 'wither', 0, 1.85, 0),
    pt('sword', 'arrow', 0.42, 1.1, 0.1),
  ],
  enderman: [
    // 末影人：炭黑高个（2.9 高）+ 紫瞳 + 垂手长臂（MC 标志造型）
    pt('enderLeg', 'enderman', -0.12, 0.6, 0),
    pt('enderLeg', 'enderman', 0.12, 0.6, 0),
    pt('enderBody', 'enderman', 0, 1.75, 0),
    pt('enderArm', 'enderman', -0.36, 1.3, 0),
    pt('enderArm', 'enderman', 0.36, 1.3, 0),
    pt('head', 'enderman', 0, 2.55, 0),
    pt('enderEye', 'enderEyes', -0.09, 2.6, 0.22),
    pt('enderEye', 'enderEyes', 0.09, 2.6, 0.22),
  ],
  wither: [
    // 凋灵 Boss：三头骨 + 炭黑骨架体（MC 标志造型）
    pt('witherRib', 'witherBody', 0, 1.0, 0),
    pt('witherRib', 'witherBody', 0, 1.35, 0),
    pt('witherHead', 'witherBody', 0, 1.8, 0),
    pt('witherSideHead', 'witherBody', -0.42, 1.55, 0),
    pt('witherSideHead', 'witherBody', 0.42, 1.55, 0),
  ],
  shulker: [
    // 潜影贝：紫壳方盒 + 微开顶盖（MC 标志造型；固着不动）
    pt('shulkerBase', 'shulkerShell', 0, 0.3, 0),
    pt('shulkerLid', 'shulkerTop', 0.04, 0.72, 0.04),
  ],
  slime: [
    // 史莱姆：绿方块 + 双眼与嘴（体型由 slimeSize 缩放在根矩阵逐生物表达，非变体）
    pt('slimeBody', 'slimeOuter', 0, 0.7, 0),
    pt('slimeEye', 'slimeDark', -0.2, 0.85, 0.62),
    pt('slimeEye', 'slimeDark', 0.2, 0.85, 0.62),
    pt('slimeMouth', 'slimeDark', 0, 0.5, 0.62),
  ],
  ender_dragon: [
    // 末影龙 Boss：黑紫长躯 + 双翼展开 + 紫眼；部件以体心为原点
    pt('dragonBody', 'dragonBody', 0, 0, 0),
    pt('dragonNeck', 'dragonBody', 0, 0.3, 2.3),
    pt('dragonHead', 'dragonBody', 0, 0.45, 3.1),
    pt('dragonSnout', 'dragonBody', 0, 0.3, 3.9),
    pt('dragonEyeBand', 'dragonEye', 0, 0.65, 3.45),
    pt('dragonHorn', 'dragonWing', -0.25, 1.05, 2.9),
    pt('dragonHorn', 'dragonWing', 0.25, 1.05, 2.9),
    pt('dragonTail', 'dragonBody', 0, -0.1, -2.8),
    pt('dragonTailTip', 'dragonBody', 0, -0.05, -4.6),
    pt('dragonWing', 'dragonWing', -2.1, 0.7, 0.4, 0.5),
    pt('dragonWing', 'dragonWing', 2.1, 0.7, 0.4, -0.5),
  ],
  ghast: [
    // 恶魂：雪白巨体 + 下垂触手（MC 下界空中巨怪）
    pt('ghastBody', 'ghast', 0, 1.2, 0),
    ...([
      [-0.7, -0.7], [0, -0.7], [0.7, -0.7], [-0.7, 0],
      [0.7, 0], [-0.7, 0.7], [0, 0.7], [0.7, 0.7],
    ] as const).map(([tx, tz]) => pt('ghastTentacle', 'ghastTear', tx, -0.15, tz)),
  ],
  ghastling: [
    // 小恶魂（1.21.6）：雪白小方体 + 短触手 + 闭眼小脸（脸朝 +z，与整体朝向约定一致）
    pt('ghastlingBody', 'ghastling', 0, 0.6, 0),
    ...([[-0.25, -0.25], [0.25, -0.25], [-0.25, 0.25], [0.25, 0.25]] as const).map(([tx, tz]) => pt('ghastlingTentacle', 'ghastling', tx, 0.15, tz)),
    pt('slimeEye', 'ghastDark', -0.18, 0.72, 0.46),
    pt('slimeEye', 'ghastDark', 0.18, 0.72, 0.46),
    pt('slimeMouth', 'ghastDark', 0, 0.48, 0.46),
  ],
  chicken: [
    pt('chickenBody', 'chicken', 0, 0.35, 0),
    pt('chickenHead', 'chicken', 0, 0.62, 0.2),
    pt('beak', 'beak', 0, 0.58, 0.38),
  ],
  iron_golem: [
    // 铁傀儡：宽肩厚背 + 过膝垂臂 + 大扁头与大鼻子 + 藤蔓斑（MC 2.7 格村庄守卫）
    pt('golemLeg', 'golemIron', -0.18, 0.55, 0),
    pt('golemLeg', 'golemIron', 0.18, 0.55, 0),
    pt('golemBody', 'golemIron', 0, 1.6, 0),
    pt('golemArm', 'golemIronDark', -0.6, 1.35, 0),
    pt('golemArm', 'golemIronDark', 0.6, 1.35, 0),
    pt('golemHead', 'golemIron', 0, 2.35, 0),
    pt('golemNose', 'golemIronDark', 0, 2.26, 0.29),
    pt('golemVine', 'golemVine', 0.34, 1.7, 0.28),
  ],
  phantom: [
    // 幻翼：扁平灰身 + 双翼展开微翘 + 尾鳍（MC 鳐形；盘旋姿态由整体朝向表达）
    pt('phantomBody', 'phantomBody', 0, 0.1, 0),
    pt('phantomEye', 'phantomEye', -0.18, 0.18, 0.26),
    pt('phantomEye', 'phantomEye', 0.18, 0.18, 0.26),
    pt('phantomWing', 'phantomWing', -1.1, 0.15, -0.1, 0.18),
    pt('phantomWing', 'phantomWing', 1.1, 0.15, -0.1, -0.18),
    pt('phantomTail', 'phantomWing', 0, 0.12, -0.5),
  ],
  copper_golem: [
    // 铜傀儡（1.21.9）：铜色小傀儡——短腿细臂、方头小鼻、发光黄眼（MC 铜灯质感）、头顶短避雷针。
    // Java 另有 4 氧化级变色（变绿）与涂蜡，本项目从简只做未氧化态（差异见 mobs.ts 铜傀儡注释）
    pt('pigLeg', 'copperGolemDark', -0.09, 0.15, 0),
    pt('pigLeg', 'copperGolemDark', 0.09, 0.15, 0),
    pt('copperBody', 'copperGolem', 0, 0.53, 0),
    pt('copperArm', 'copperGolemDark', -0.26, 0.55, 0),
    pt('copperArm', 'copperGolemDark', 0.26, 0.55, 0),
    pt('copperHead', 'copperGolem', 0, 0.92, 0),
    pt('copperNose', 'copperGolemDark', 0, 0.86, 0.2),
    pt('enderEye', 'copperGolemEye', -0.08, 0.97, 0.17),
    pt('enderEye', 'copperGolemEye', 0.08, 0.97, 0.17),
    pt('copperRod', 'copperGolemLight', 0, 1.2, 0),
  ],
};

/**
 * 变体键：同键共享一组实例池。
 * 羊按毛色×剪毛、狼按驯服（项圈有无）、村民按职业（袍色）分变体；
 * 牛/猪/鸡按群系变种（1.21.5：cold/temperate/warm，部件同色不同料）；
 * 快乐恶魂按鞍具有无（1.21.6：有鞍加鞍座/护目镜部件）；
 * 史莱姆体型/幼体/苦力怕引爆膨胀是逐生物根矩阵缩放，不占变体。
 */
export function variantKeyOf(m: Mob): string {
  switch (m.type) {
    case 'sheep':
      return `sheep:${m.woolColor ?? 'white'}:${m.sheared ? 1 : 0}`;
    case 'wolf':
      return `wolf:${m.tamed ? 1 : 0}`;
    case 'villager':
      return `villager:${professionOf(m.id)}`;
    case 'happy_ghast':
      // 快乐恶魂（1.21.6）：无鞍 / 有鞍两变体——有鞍加鞍座与护目镜部件（Java 被骑时护目镜放下，从简有鞍即显示）
      return `happy_ghast:${m.harnessed ? 1 : 0}`;
    case 'cow':
    case 'pig':
    case 'chicken':
      return `${m.type}:${m.variant ?? 'temperate'}`;
    default:
      return m.type;
  }
}

/** 按变体键取部件表（动态变体在此展开；静态变体查 BASE_PARTS） */
export function partsForVariant(vkey: string): PartDef[] {
  const [type, a, b] = vkey.split(':');
  switch (type) {
    case 'sheep': {
      // 羊：毛壳（按毛色）+ 头；剪过毛的只剩瘦脸与细身
      const sheared = b === '1';
      return [
        pt('pigLeg', 'sheepFace', -0.2, 0.15, -0.2),
        pt('pigLeg', 'sheepFace', 0.2, 0.15, -0.2),
        pt('pigLeg', 'sheepFace', -0.2, 0.15, 0.2),
        pt('pigLeg', 'sheepFace', 0.2, 0.15, 0.2),
        sheared ? pt('sheepSlim', 'sheepFace', 0, 0.5, 0) : pt('sheepWool', `wool_${a}`, 0, 0.62, 0),
        pt('sheepHead', 'sheepFace', 0, sheared ? 0.72 : 0.78, 0.5),
      ];
    }
    case 'wolf': {
      // 狼：四足 + 头 + 竖耳 + 尾；驯服的有红项圈（MC）
      const parts = [
        pt('pigLeg', 'wolfDark', -0.18, 0.15, -0.2),
        pt('pigLeg', 'wolfDark', 0.18, 0.15, -0.2),
        pt('pigLeg', 'wolfDark', -0.18, 0.15, 0.2),
        pt('pigLeg', 'wolfDark', 0.18, 0.15, 0.2),
        pt('wolfBody', 'wolf', 0, 0.55, 0),
        pt('wolfHead', 'wolf', 0, 0.72, 0.45),
        pt('wolfEar', 'wolfDark', -0.12, 0.95, 0.42),
        pt('wolfEar', 'wolfDark', 0.12, 0.95, 0.42),
        pt('wolfTail', 'wolf', 0, 0.68, -0.5),
      ];
      if (a === '1') parts.push(pt('collar', 'collar', 0, 0.62, 0.28));
      return parts;
    }
    case 'villager': {
      // 长袍身体 + MC 大扁头 + 前垂大鼻子 + 抱臂（横袖）；袍色随职业
      const robe = `robe_${a}`;
      return [
        pt('leg', robe, -0.13, 0.375, 0),
        pt('leg', robe, 0.13, 0.375, 0),
        pt('body', robe, 0, 1.1, 0),
        pt('villagerHead', 'villagerSkin', 0, 1.64, 0),
        // 大鼻子：面中部前垂（MC 村民标志）
        pt('villagerNose', 'villagerSkin', 0, 1.52, 0.27),
        // 抱臂横袖（MC 村民双手交叠于袍前）
        pt('villagerArms', robe, 0, 1.12, 0.2),
      ];
    }
    case 'happy_ghast': {
      // 快乐恶魂（1.21.6）：雪白巨体（比恶魂更大）+ 长触手 + 小脸；有鞍变体加鞍座与放下的护目镜
      const parts = [
        pt('happyGhastBody', 'ghast', 0, 1.7, 0),
        ...([
          [-0.9, -0.9], [0, -0.9], [0.9, -0.9], [-0.9, 0],
          [0.9, 0], [-0.9, 0.9], [0, 0.9], [0.9, 0.9],
        ] as const).map(([tx, tz]) => pt('happyGhastTentacle', 'ghast', tx, 0, tz)),
        pt('ghastEye', 'ghastDark', -0.6, 2.3, 1.51),
        pt('ghastEye', 'ghastDark', 0.6, 2.3, 1.51),
        pt('ghastMouth', 'ghastDark', 0, 1.8, 1.51),
      ];
      if (a === '1') {
        parts.push(pt('harnessSeat', 'harnessLeather', 0, 3.3, 0)); // 鞍座（体顶 3.2 之上）
        parts.push(pt('harnessGoggles', 'harnessGoggles', 0, 2.4, 1.6)); // 护目镜放下（Java 被骑时放下；从简有鞍即显示）
      }
      return parts;
    }
    case 'cow':
    case 'pig':
    case 'chicken': {
      // 群系变种（1.21.5）：温带沿用 BASE_PARTS 原配色；寒带/热带同形换料（材质键 <原料>_<变种>，
      // 寒带更深、热带更浅）；鸡另加鸡冠部件做外观区分（温带沿用原 3 部件简模，MC 鸡冠差异）
      const v = a === 'cold' || a === 'warm' ? a : 'temperate';
      const base = BASE_PARTS[type];
      if (v === 'temperate') return base;
      const parts = base.map((p) => ({ ...p, mat: p.mat === 'beak' ? p.mat : `${p.mat}_${v}` }));
      if (type === 'chicken') parts.push(pt('horn', `comb_${v}`, 0, 0.78, 0.2));
      return parts;
    }
    default: {
      const parts = BASE_PARTS[type];
      if (!parts) throw new Error(`unknown mob variant: ${vkey}`);
      return parts;
    }
  }
}

/** 敌对生物类型（朝向玩家；其余朝移动方向） */
export const HOSTILE_TYPES: ReadonlySet<MobType> = new Set(['zombie', 'skeleton', 'spider', 'creeper', 'phantom', 'iron_golem']);
/** 受击红闪阈值（秒）：hurtImmune 从 0.5 倒数，剩余 > 0.25 期间显示红壳 ≈ 受击后 0.25s 红闪（Java hurt flash） */
export const HURT_FLASH_LEFT = 0.25;
/** 距离门（格²）：水平距玩家超 48 格的生物只同步位置，朝向/缩放/红闪冻结在上次近距同步值（远景不可辨） */
export const FAR_SYNC_DIST_SQ = 48 * 48;
/** 实例池初始容量（按生物数；超出时倍增重建该池的 InstancedMesh，摊销罕见） */
export const INITIAL_CAPACITY = 16;

/** 每生物每帧的渲染位姿（近距生物逐帧重算；远距生物冻结缓存、只跟位置） */
export interface MobRenderState {
  yaw: number;
  scale: number;
  /** 死亡倒地：绕 z 轴倾倒角（存活为 0） */
  rotZ: number;
  /** 死亡缓沉量（从 m.y 减去；仅近距生物施加，远距用原始 m.y） */
  sink: number;
  /** 受击红闪/死亡全程红壳 */
  flash: boolean;
}

/**
 * 由生物状态算渲染位姿（与原 useFrame 内联逻辑逐项一致）：
 * 朝向（敌对朝玩家/被动朝移动方向）、苦力怕引爆膨胀、幼体 0.55、史莱姆体型档、
 * 受击红闪（死亡态全程红）与死亡倒地（绕 z 倒 90° + 缓沉）。
 */
export function computeMobRenderState(m: Mob, px: number, pz: number, now: number): MobRenderState {
  const def = m.fleeTimer > 0 || !HOSTILE_TYPES.has(m.type);
  const yaw = def && m.wanderMoving
    ? Math.atan2(Math.cos(m.wanderDir), Math.sin(m.wanderDir))
    : Math.atan2(px - m.x, pz - m.z);
  let scale: number;
  if (m.type === 'creeper' && m.ignite >= 0) {
    scale = 1 + 0.08 * Math.sin(now / 50);
  } else if (m.type === 'slime') {
    scale = (m.slimeSize ?? 4) * 0.35;
  } else {
    // 小恶魂的 baby 标记只用于成长计时（growUp 长成快乐恶魂），几何体本身已按小型建模，不再叠 0.55 幼体缩放
    scale = m.baby && m.type !== 'ghastling' ? 0.55 : 1;
  }
  const dying = m.deathTimer !== undefined;
  const flash = dying || (m.hurtImmune ?? 0) > HURT_FLASH_LEFT;
  let rotZ = 0;
  let sink = 0;
  if (dying) {
    const p = 1 - Math.max(0, m.deathTimer ?? 0) / MOB_DEATH_DURATION; // 进度 0 → 1
    rotZ = -(Math.PI / 2) * Math.min(1, p * 1.5); // 前 2/3 时间倒完，余下躺地
    sink = p * 0.3; // 缓沉，配合结束白烟掩盖消失
  }
  return { yaw, scale, rotZ, sink, flash };
}

/** 部件局部矩阵 = T(x,y,z)·Rz(rz)（对应原 Mesh.position + rotation.z，Object3D 默认 T·R·S 且 S=1） */
function partLocalMatrix(p: PartDef): Matrix4 {
  const m = new Matrix4();
  if (p.rz) m.makeRotationZ(p.rz);
  m.setPosition(p.x, p.y, p.z);
  return m;
}

/** 红闪壳局部矩阵 = T(包围盒中心)·S(尺寸+0.12)，对应原 flash.position/flash.scale */
function flashLocalMatrix(parts: PartDef[]): Matrix4 {
  const bb = new Box3();
  const partBox = new Box3();
  for (const p of parts) {
    const g = MOB_GEOS[p.geo];
    g.computeBoundingBox();
    partBox.copy(g.boundingBox!).applyMatrix4(partLocalMatrix(p));
    bb.union(partBox);
  }
  const center = new Vector3();
  const size = new Vector3();
  bb.getCenter(center);
  bb.getSize(size);
  size.addScalar(0.12);
  return new Matrix4().compose(center, new Quaternion(), size);
}

/** 测试用：按变体键取红闪壳局部矩阵（与池内 flashLocal 同算法） */
export function flashLocalMatrixForTest(vkey: string): Matrix4 {
  return flashLocalMatrix(partsForVariant(vkey));
}

/** 同（几何×材质）的部件合并为一个实例层（僵尸双腿/蜘蛛八腿共用一层，进一步压 draw call） */
interface LayerDef {
  geo: string;
  mat: string;
  locals: Matrix4[];
}

function groupLayers(parts: PartDef[]): LayerDef[] {
  const layers: LayerDef[] = [];
  const index = new Map<string, LayerDef>();
  for (const p of parts) {
    const k = `${p.geo}|${p.mat}`;
    let l = index.get(k);
    if (!l) {
      l = { geo: p.geo, mat: p.mat, locals: [] };
      index.set(k, l);
      layers.push(l);
    }
    l.locals.push(partLocalMatrix(p));
  }
  return layers;
}

interface Layer {
  mesh: InstancedMesh;
  locals: Matrix4[];
}

interface VariantPool {
  layers: Layer[];
  flashLocal: Matrix4;
  /** 容量（按生物数） */
  capacity: number;
  /** 本帧已写入的生物数 */
  cursor: number;
}

/**
 * 实例池管理器：按变体惰性建池，每帧 sync 重写全部实例矩阵（槽位按帧内顺序分配——
 * 反正每帧全量重写，无需跨帧稳定槽位/空闲链表；生物消失由 count 截断隐藏）。
 * 红闪壳全变体共用一个 InstancedMesh（同几何同材质），不占位写零缩放矩阵。
 */
export class MobInstancePools {
  /** 挂到场景图的根节点（所有实例网格为其子节点） */
  readonly root = new Group();
  private pools = new Map<string, VariantPool>();
  private flashMesh: InstancedMesh | null = null;
  private flashCapacity = 0;
  private flashCursor = 0;
  /** 远距生物冻结的位姿（键 = mob.id；生物移除后剪除） */
  private stateCache = new Map<number, MobRenderState>();
  private seenScratch = new Set<number>();
  /** 远距生物复用的位姿暂存（writeInstance 立即消费，可安全复用） */
  private farScratch: MobRenderState = { yaw: 0, scale: 1, rotZ: 0, sink: 0, flash: false };
  // 帧循环复用的合成暂存（避免每帧分配）
  private rootM = new Matrix4();
  private tmpM = new Matrix4();
  private posV = new Vector3();
  private scaleV = new Vector3();
  private quat = new Quaternion();
  private euler = new Euler();

  constructor(readonly materials: Record<string, Material>) {}

  /** 每帧同步：重写所有实例矩阵并裁剪 count。mobs 为 lib 生物数组（含死亡动画中的个体）。 */
  sync(mobs: readonly Mob[], px: number, pz: number, now: number): void {
    this.ensureFlash();
    for (const pool of this.pools.values()) pool.cursor = 0;
    this.flashCursor = 0;
    const seen = this.seenScratch;
    seen.clear();
    for (const m of mobs) {
      seen.add(m.id);
      // 距离门：>48 格只跟位置，位姿冻结在上次近距同步值（与原逐网格逻辑一致）
      const pdx = m.x - px;
      const pdz = m.z - pz;
      let st: MobRenderState;
      if (pdx * pdx + pdz * pdz > FAR_SYNC_DIST_SQ) {
        // 距离门：>48 格只跟位置（原始 m.y，缓沉不施加——对齐原 position.set 后 continue 的行为），
        // 朝向/缩放/倒地角/红闪冻结在上次近距同步值；从未近距过的用默认位姿
        const c = this.stateCache.get(m.id);
        st = this.farScratch;
        st.yaw = c?.yaw ?? 0;
        st.scale = c?.scale ?? 1;
        st.rotZ = c?.rotZ ?? 0;
        st.flash = c?.flash ?? false;
        st.sink = 0;
      } else {
        st = computeMobRenderState(m, px, pz, now);
        this.stateCache.set(m.id, st);
      }
      this.writeInstance(this.poolFor(variantKeyOf(m)), m, st);
    }
    for (const id of this.stateCache.keys()) {
      if (!seen.has(id)) this.stateCache.delete(id);
    }
    for (const pool of this.pools.values()) {
      for (const l of pool.layers) {
        l.mesh.count = pool.cursor * l.locals.length;
        l.mesh.instanceMatrix.needsUpdate = true;
      }
    }
    const fm = this.flashMesh!;
    fm.count = this.flashCursor;
    fm.instanceMatrix.needsUpdate = true;
  }

  /** 释放实例缓冲（几何/材质为模块级共享，不在此 dispose） */
  dispose(): void {
    for (const pool of this.pools.values()) {
      for (const l of pool.layers) l.mesh.dispose();
    }
    this.flashMesh?.dispose();
    this.root.removeFromParent();
    this.root.clear();
    this.pools.clear();
    this.stateCache.clear();
    this.flashMesh = null;
    this.flashCapacity = 0;
  }

  /** 材质解析（保留原回退：wool_* 缺色回退 wolf，robe_* 缺职业回退 robe） */
  private resolveMat(key: string): Material {
    const m = this.materials[key]
      ?? (key.startsWith('wool_') ? this.materials.wolf : key.startsWith('robe_') ? this.materials.robe : undefined);
    if (!m) throw new Error(`mob material missing: ${key}`);
    return m;
  }

  private makeInstanced(geoKey: string, mat: Material, capacity: number): InstancedMesh {
    const im = new InstancedMesh(MOB_GEOS[geoKey], mat, capacity);
    im.instanceMatrix.setUsage(DynamicDrawUsage);
    // 实例散布世界各处，几何自身包围球不涵盖实例位置，必须禁用视锥剔除（标准处理）
    im.frustumCulled = false;
    im.count = 0;
    this.root.add(im);
    return im;
  }

  private ensureFlash(): void {
    if (!this.flashMesh) {
      this.flashCapacity = INITIAL_CAPACITY * 2;
      this.flashMesh = this.makeInstanced('flash', this.materials.hurtFlash, this.flashCapacity);
    }
  }

  private poolFor(vkey: string): VariantPool {
    let pool = this.pools.get(vkey);
    if (!pool) {
      const parts = partsForVariant(vkey);
      pool = {
        layers: groupLayers(parts).map((d) => ({
          locals: d.locals,
          mesh: this.makeInstanced(d.geo, this.resolveMat(d.mat), INITIAL_CAPACITY * d.locals.length),
        })),
        flashLocal: flashLocalMatrix(parts),
        capacity: INITIAL_CAPACITY,
        cursor: 0,
      };
      this.pools.set(vkey, pool);
    }
    return pool;
  }

  /** 容量倍增：重建该池各层 InstancedMesh 并拷贝已写入的前缀（本帧内安全，摊销罕见） */
  private grow(pool: VariantPool): void {
    pool.capacity *= 2;
    for (const l of pool.layers) {
      const old = l.mesh;
      const im = this.makeInstanced(geoKeyOf(old.geometry), old.material as Material, pool.capacity * l.locals.length);
      im.instanceMatrix.array.set(old.instanceMatrix.array);
      this.root.remove(old);
      old.dispose();
      l.mesh = im;
    }
  }

  private growFlash(): void {
    const old = this.flashMesh!;
    this.flashCapacity *= 2;
    const im = this.makeInstanced('flash', old.material as Material, this.flashCapacity);
    im.instanceMatrix.array.set(old.instanceMatrix.array);
    this.root.remove(old);
    old.dispose();
    this.flashMesh = im;
  }

  private writeInstance(pool: VariantPool, m: Mob, st: MobRenderState): void {
    const i = pool.cursor++;
    if (i >= pool.capacity) this.grow(pool);
    // 根矩阵 = T(位置-缓沉)·Ry(yaw)·Rz(死亡倒地)·S(缩放)（与 Object3D compose(position, quaternion, scale) 一致，欧拉序 XYZ）
    this.euler.set(0, st.yaw, st.rotZ);
    this.quat.setFromEuler(this.euler);
    this.posV.set(m.x, m.y - st.sink, m.z);
    this.scaleV.setScalar(st.scale);
    this.rootM.compose(this.posV, this.quat, this.scaleV);
    for (const l of pool.layers) {
      const base = i * l.locals.length;
      for (let j = 0; j < l.locals.length; j++) {
        this.tmpM.multiplyMatrices(this.rootM, l.locals[j]);
        l.mesh.setMatrixAt(base + j, this.tmpM);
      }
    }
    // 红闪壳：不占位写零缩放矩阵隐藏（共享纯色材质无法逐实例调透明，零缩放为常规做法）
    const f = this.flashCursor++;
    if (f >= this.flashCapacity) this.growFlash();
    if (st.flash) this.tmpM.multiplyMatrices(this.rootM, pool.flashLocal);
    else this.tmpM.makeScale(0, 0, 0);
    this.flashMesh!.setMatrixAt(f, this.tmpM);
  }
}

/** 几何对象反查注册键（grow 重建层时用；注册表外几何返回空串并行异常） */
function geoKeyOf(g: unknown): string {
  for (const [k, v] of Object.entries(MOB_GEOS)) {
    if (v === g) return k;
  }
  throw new Error('geometry not in MOB_GEOS registry');
}
