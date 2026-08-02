// 活塞：推出（≤12 格）、不可推表、收回、粘性拉回、孤儿头清理、放置朝向、QC 半连接性（BUD）、1-tick 短脉冲丢块

import { beforeEach, describe, expect, it } from 'vitest';
import { AIR, BLOCK_BY_KEY, STONE } from '../blocks';
import { VOID_TERRAIN } from '../noise';
import { cleanupOrphanHeads, isExtended, isPistonId, pistonIdFor, tryExtend } from '../pistons';
import { clearRedstone, tickRedstone, toggleLever } from '../redstone';
import { RECIPES } from '../recipes';
import { World } from '../world';

const K = (k: string) => BLOCK_BY_KEY[k].id;
const HEAD = () => K('piston_head');

function setup(): World {
  clearRedstone();
  return new World('piston-test', undefined, VOID_TERRAIN);
}

/** 放个拉杆并供能（经红石链路驱动活塞） */
function power(w: World, x: number, y: number, z: number, on: boolean): void {
  if (w.getBlock(x, y, z) !== BLOCK_BY_KEY.lever.id && w.getBlock(x, y, z) !== BLOCK_BY_KEY.lever_on.id) {
    w.setBlock(x, y, z, BLOCK_BY_KEY.lever.id);
  }
  const isOn = w.getBlock(x, y, z) === BLOCK_BY_KEY.lever_on.id;
  if (isOn !== on) toggleLever(w, x, y, z);
}

beforeEach(clearRedstone);

describe('推出与收回（红石驱动）', () => {
  it('朝上活塞推出：前方一行整体前移 + 头部占位；断供收回不拉回', () => {
    const w = setup();
    w.setBlock(4, 30, 4, pistonIdFor(false, 4)); // 朝上
    w.setBlock(4, 31, 4, STONE);
    w.setBlock(4, 32, 4, K('dirt'));
    power(w, 3, 30, 4, true);
    expect(w.getBlock(4, 31, 4)).toBe(HEAD());
    expect(w.getBlock(4, 32, 4)).toBe(STONE); // 石头被顶上一格
    expect(w.getBlock(4, 33, 4)).toBe(K('dirt'));
    expect(isExtended(w, 4, 30, 4)).toBe(true);
    // 断供收回：头消失，推上去的块留在高处（普通活塞不拉回，MC 一致）
    power(w, 3, 30, 4, false);
    expect(w.getBlock(4, 31, 4)).toBe(AIR);
    expect(w.getBlock(4, 32, 4)).toBe(STONE);
    expect(isExtended(w, 4, 30, 4)).toBe(false);
  });

  it('粘性活塞断供拉回前块', () => {
    const w = setup();
    w.setBlock(4, 30, 4, pistonIdFor(true, 4));
    w.setBlock(4, 31, 4, STONE);
    power(w, 3, 30, 4, true);
    expect(w.getBlock(4, 31, 4)).toBe(HEAD());
    expect(w.getBlock(4, 32, 4)).toBe(STONE);
    power(w, 3, 30, 4, false);
    expect(w.getBlock(4, 31, 4)).toBe(STONE); // 被拉回头部位置
    expect(w.getBlock(4, 32, 4)).toBe(AIR);
  });

  it('朝南活塞沿 z 推出', () => {
    const w = setup();
    w.setBlock(4, 30, 4, pistonIdFor(false, 2)); // 朝南 +z
    w.setBlock(4, 30, 5, STONE);
    power(w, 3, 30, 4, true);
    expect(w.getBlock(4, 30, 5)).toBe(HEAD());
    expect(w.getBlock(4, 30, 6)).toBe(STONE);
  });
});

describe('不可推与上限', () => {
  it('黑曜石/基岩/容器不可推（整行不动）', () => {
    const w = setup();
    w.setBlock(4, 30, 4, pistonIdFor(false, 4));
    w.setBlock(4, 31, 4, K('obsidian'));
    tryExtend(w, 4, 30, 4);
    expect(w.getBlock(4, 31, 4)).toBe(K('obsidian'));
    const w2 = setup();
    w2.setBlock(4, 30, 4, pistonIdFor(false, 4));
    w2.setBlock(4, 31, 4, K('chest'));
    tryExtend(w2, 4, 30, 4);
    expect(w2.getBlock(4, 31, 4)).toBe(K('chest'));
  });

  it('远古残骸可推（MC；不按镐层级误判为黑曜石类）', () => {
    const w = setup();
    w.setBlock(4, 30, 4, pistonIdFor(false, 4));
    w.setBlock(4, 31, 4, K('ancient_debris'));
    power(w, 3, 30, 4, true);
    expect(w.getBlock(4, 31, 4)).toBe(HEAD());
    expect(w.getBlock(4, 32, 4)).toBe(K('ancient_debris')); // 被推上一格
    expect(isExtended(w, 4, 30, 4)).toBe(true);
  });

  it('12 块+空位可推、13 块不可推（MC 上限恰为推 12 块）', () => {
    // 12 格石头、第 13 格空气：恰达 Java 上限，应能推出
    const w = setup();
    w.setBlock(4, 30, 4, pistonIdFor(false, 4));
    for (let y = 31; y <= 42; y++) w.setBlock(4, y, 4, STONE); // 12 格石头（y=43 为空位）
    power(w, 3, 30, 4, true);
    expect(w.getBlock(4, 31, 4)).toBe(HEAD());
    expect(w.getBlock(4, 43, 4)).toBe(STONE); // 整行 12 块前推一格
    expect(isExtended(w, 4, 30, 4)).toBe(true);
    // 13 格石头：超过上限，推不出
    const w2 = setup();
    w2.setBlock(4, 30, 4, pistonIdFor(false, 4));
    for (let y = 31; y <= 43; y++) w2.setBlock(4, y, 4, STONE); // 13 格石头
    tryExtend(w2, 4, 30, 4);
    expect(w2.getBlock(4, 31, 4)).toBe(STONE); // 没推出
    expect(isExtended(w2, 4, 30, 4)).toBe(false);
    // 11 格更可以（供能后正常推出）
    const w3 = setup();
    w3.setBlock(4, 30, 4, pistonIdFor(false, 4));
    for (let y = 31; y <= 41; y++) w3.setBlock(4, y, 4, STONE);
    power(w3, 3, 30, 4, true);
    expect(isExtended(w3, 4, 30, 4)).toBe(true);
  });

  it('孤儿活塞头自动消失', () => {
    const w = setup();
    w.setBlock(4, 31, 4, HEAD()); // 无活塞的头
    cleanupOrphanHeads(w, 4, 31, 4);
    expect(w.getBlock(4, 31, 4)).toBe(AIR);
    // 有活塞背向支撑且处于供能态的头保留
    w.setBlock(4, 30, 4, pistonIdFor(false, 4));
    power(w, 3, 30, 4, true);
    w.setBlock(4, 31, 4, HEAD());
    cleanupOrphanHeads(w, 4, 31, 4);
    expect(w.getBlock(4, 31, 4)).toBe(HEAD());
  });

  it('侧向贴着的无关活塞不保护孤儿头（facing 须指向头格）', () => {
    // 头贴在朝上活塞的东侧：活塞 facing 向上、未指向头格 → 头应消失
    const w = setup();
    w.setBlock(4, 30, 4, pistonIdFor(false, 4)); // 朝上
    w.setBlock(5, 30, 4, HEAD());
    cleanupOrphanHeads(w, 5, 30, 4);
    expect(w.getBlock(5, 30, 4)).toBe(AIR);
    // facing 指向头格的供能活塞（朝东）保护头 → 保留
    const w2 = setup();
    w2.setBlock(4, 30, 4, pistonIdFor(false, 1)); // 朝东
    power(w2, 3, 30, 4, true); // 供能推出：头在 (5,30,4)
    expect(w2.getBlock(5, 30, 4)).toBe(HEAD());
    cleanupOrphanHeads(w2, 5, 30, 4);
    expect(w2.getBlock(5, 30, 4)).toBe(HEAD());
  });

  it('isPistonId 覆盖全部朝向变体', () => {
    for (let f = 0; f <= 5; f++) {
      expect(isPistonId(pistonIdFor(false, f))).toBe(true);
      expect(isPistonId(pistonIdFor(true, f))).toBe(true);
    }
  });
});

describe('红石驱动与配方', () => {
  it('拉杆供能推出、断供收回（红石链路端到端）', async () => {
    const { toggleLever } = await import('../redstone');
    const w = setup();
    w.setBlock(4, 30, 4, pistonIdFor(true, 4));
    w.setBlock(4, 31, 4, STONE);
    w.setBlock(3, 30, 4, K('lever'));
    toggleLever(w, 3, 30, 4); // 开
    expect(w.getBlock(4, 31, 4)).toBe(HEAD());
    expect(w.getBlock(4, 32, 4)).toBe(STONE);
    toggleLever(w, 3, 30, 4); // 关
    expect(w.getBlock(4, 31, 4)).toBe(STONE); // 粘性拉回
  });

  it('活塞/粘性活塞配方（MC 一致）', () => {
    const p = RECIPES.find((r) => r.id === 'piston')!;
    expect(p.cost).toContainEqual({ item: 'material:redstone', count: 1 });
    expect(p.cost).toContainEqual({ item: 'material:iron_ingot', count: 1 });
    expect(RECIPES.find((r) => r.id === 'piston_sticky')).toBeDefined();
  });
});

describe('QC 半连接性（quasi-connectivity）', () => {
  it('对角上方供电：QC 供能但不立即动作（BUD 态），邻近方块更新后补推出', () => {
    const w = setup();
    w.setBlock(4, 30, 4, pistonIdFor(false, 4)); // 朝上
    w.setBlock(4, 31, 4, STONE);
    // 火把在活塞对角上方 (5,31,4)：是「门位置」(4,31,4) 的邻居但不是活塞的邻居；
    // 火把只充能自己正上方（强充能，但正上方是空气），不会经充能变成常规供电
    w.setBlock(5, 31, 4, K('redstone_torch'));
    expect(isExtended(w, 4, 30, 4)).toBe(false); // BUD：QC 供能存在，无方块更新不动作
    // 非邻近的变动（半径内但距活塞 2 格）也不触发
    w.setBlock(4, 30, 6, K('redstone_torch'));
    expect(isExtended(w, 4, 30, 4)).toBe(false);
    // 邻近方块更新（MC Java 的 BUD 触发）：活塞旁放个普通方块
    w.setBlock(4, 30, 5, K('dirt'));
    expect(w.getBlock(4, 31, 4)).toBe(HEAD());
    expect(w.getBlock(4, 32, 4)).toBe(STONE);
    expect(isExtended(w, 4, 30, 4)).toBe(true);
  });

  it('正上方两格电源：同样 QC 供能（BUD），更新后推出', () => {
    const w = setup();
    w.setBlock(4, 30, 4, pistonIdFor(false, 4));
    w.setBlock(4, 31, 4, STONE);
    w.setBlock(4, 32, 4, K('redstone_torch')); // y+2：门位置 (4,31,4) 的正上方邻居
    expect(isExtended(w, 4, 30, 4)).toBe(false);
    w.setBlock(4, 29, 4, K('dirt')); // 活塞下方邻格更新
    expect(w.getBlock(4, 31, 4)).toBe(HEAD());
    expect(w.getBlock(4, 32, 4)).toBe(STONE);
  });

  it('QC 断能后收回（简化：不做收回侧 BUD 延迟，随重算即时收回）', () => {
    const w = setup();
    w.setBlock(4, 30, 4, pistonIdFor(false, 4));
    w.setBlock(4, 31, 4, STONE);
    w.setBlock(5, 31, 4, K('redstone_torch'));
    w.setBlock(4, 30, 5, K('dirt')); // 邻近更新 → QC 推出
    expect(isExtended(w, 4, 30, 4)).toBe(true);
    w.setBlock(5, 31, 4, AIR); // 撤掉 QC 电源 → 收回（普通活塞不拉回）
    expect(w.getBlock(4, 31, 4)).toBe(AIR);
    expect(w.getBlock(4, 32, 4)).toBe(STONE);
    expect(isExtended(w, 4, 30, 4)).toBe(false);
  });

  it('常规供电不回归：邻格拉杆即时推出，无需方块更新', () => {
    const w = setup();
    w.setBlock(4, 30, 4, pistonIdFor(false, 4));
    w.setBlock(4, 31, 4, STONE);
    power(w, 3, 30, 4, true);
    expect(isExtended(w, 4, 30, 4)).toBe(true); // 常规供电立即动作（无 BUD 延迟）
  });
});

describe('粘性活塞 1-tick 短脉冲丢块', () => {
  /** 侦测器 0.1s（1 红石刻）脉冲直接供能活塞：observer_n 检测 -z、向 +z 输出到活塞 */
  function observerPiston(w: World, sticky: boolean): void {
    w.setBlock(4, 30, 4, K('observer_n'));
    w.setBlock(4, 30, 5, pistonIdFor(sticky, 1)); // 朝东
    w.setBlock(5, 30, 5, STONE);
  }

  it('1-tick 脉冲（侦测器）：粘性活塞推出后不拉回，方块留在推到位', () => {
    const w = setup();
    observerPiston(w, true);
    w.setBlock(4, 30, 3, K('dirt')); // 侦测器面朝格变化
    tickRedstone(w, 0.1); // tick 比对发现变化 → 调度脉冲（Java：延迟 1 红石刻发出）
    tickRedstone(w, 0.1); // 脉冲发出 → 推出
    expect(w.getBlock(5, 30, 5)).toBe(HEAD());
    expect(w.getBlock(6, 30, 5)).toBe(STONE);
    tickRedstone(w, 0.1); // 脉冲到期断供（持续 1 红石刻）→ 收回但丢块（MC Java）
    expect(w.getBlock(5, 30, 5)).toBe(AIR); // 头收回
    expect(w.getBlock(6, 30, 5)).toBe(STONE); // 方块留在推到位，未被拉回
    expect(isExtended(w, 4, 30, 5)).toBe(false);
  });

  it('≥2 tick 脉冲（拉杆供能 0.3s）：粘性活塞正常拉回', () => {
    const w = setup();
    w.setBlock(4, 30, 4, pistonIdFor(true, 4)); // 朝上
    w.setBlock(4, 31, 4, STONE);
    power(w, 3, 30, 4, true);
    expect(w.getBlock(4, 31, 4)).toBe(HEAD());
    for (let i = 0; i < 3; i++) tickRedstone(w, 0.1); // 供能 0.3s（3 红石刻）
    power(w, 3, 30, 4, false);
    expect(w.getBlock(4, 31, 4)).toBe(STONE); // 正常拉回
    expect(w.getBlock(4, 32, 4)).toBe(AIR);
  });

  it('普通活塞 1-tick 脉冲不受影响：收头不拉回（本就不拉回）', () => {
    const w = setup();
    observerPiston(w, false);
    w.setBlock(4, 30, 3, K('dirt'));
    tickRedstone(w, 0.1); // 发现变化 → 调度脉冲（延迟 1 红石刻，Java）
    tickRedstone(w, 0.1); // 脉冲发出 → 推出
    expect(w.getBlock(5, 30, 5)).toBe(HEAD());
    expect(w.getBlock(6, 30, 5)).toBe(STONE);
    tickRedstone(w, 0.1); // 脉冲到期
    expect(w.getBlock(5, 30, 5)).toBe(AIR); // 头收回
    expect(w.getBlock(6, 30, 5)).toBe(STONE); // 普通活塞本就不拉回
  });
});

describe('黏液块/蜂蜜块粘连推拉', () => {
  it('黏液块带侧面相邻石头一起推（垂直于运动方向的面也粘）', () => {
    const w = setup();
    w.setBlock(4, 30, 4, pistonIdFor(false, 4)); // 朝上
    w.setBlock(4, 31, 4, K('slime_block'));
    w.setBlock(5, 31, 4, STONE); // 侧面贴着的石头
    power(w, 3, 30, 4, true);
    expect(w.getBlock(4, 31, 4)).toBe(HEAD());
    expect(w.getBlock(4, 32, 4)).toBe(K('slime_block'));
    expect(w.getBlock(5, 32, 4)).toBe(STONE); // 被粘连带上一格
    expect(w.getBlock(5, 31, 4)).toBe(AIR);
  });

  it('递归连带：黏液-黏液-石头链（被带动的黏液块继续连带）', () => {
    const w = setup();
    w.setBlock(4, 30, 4, pistonIdFor(false, 4)); // 朝上
    w.setBlock(4, 31, 4, K('slime_block'));
    w.setBlock(5, 31, 4, K('slime_block')); // 侧面黏液（被第一个连带）
    w.setBlock(6, 31, 4, STONE); // 贴在第二个黏液侧面的石头（被第二个连带）
    power(w, 3, 30, 4, true);
    expect(w.getBlock(4, 32, 4)).toBe(K('slime_block'));
    expect(w.getBlock(5, 32, 4)).toBe(K('slime_block'));
    expect(w.getBlock(6, 32, 4)).toBe(STONE);
    expect(w.getBlock(6, 31, 4)).toBe(AIR);
  });

  it('12 上限计入被粘连方块：恰 12 可推、13 拒推', () => {
    // 推线 11 块（黏液+10 石头）+ 侧面被粘连 1 块 = 12：恰达上限，可推
    const w = setup();
    w.setBlock(4, 30, 4, pistonIdFor(false, 4)); // 朝上
    w.setBlock(4, 31, 4, K('slime_block'));
    for (let y = 32; y <= 41; y++) w.setBlock(4, y, 4, STONE); // 10 格石头
    w.setBlock(5, 31, 4, STONE); // 被黏液粘连的第 12 块
    power(w, 3, 30, 4, true);
    expect(isExtended(w, 4, 30, 4)).toBe(true);
    expect(w.getBlock(4, 42, 4)).toBe(STONE); // 推线顶端到位
    expect(w.getBlock(5, 32, 4)).toBe(STONE); // 粘连块到位
    // 同样布局再多一块被粘连 = 13：整次拒推
    const w2 = setup();
    w2.setBlock(4, 30, 4, pistonIdFor(false, 4));
    w2.setBlock(4, 31, 4, K('slime_block'));
    for (let y = 32; y <= 41; y++) w2.setBlock(4, y, 4, STONE);
    w2.setBlock(5, 31, 4, STONE);
    w2.setBlock(3, 31, 4, STONE); // 另一侧再粘一块 → 第 13 块
    tryExtend(w2, 4, 30, 4);
    expect(w2.getBlock(4, 31, 4)).toBe(K('slime_block')); // 没推出
    expect(w2.getBlock(4, 32, 4)).toBe(STONE); // 推线原样
    expect(isExtended(w2, 4, 30, 4)).toBe(false);
  });

  it('黏液与蜂蜜相邻：互不粘（各走各的），但各自仍粘普通方块', () => {
    // 推黏液，侧面蜂蜜留在原地
    const w = setup();
    w.setBlock(4, 30, 4, pistonIdFor(false, 4));
    w.setBlock(4, 31, 4, K('slime_block'));
    w.setBlock(5, 31, 4, K('honey_block'));
    power(w, 3, 30, 4, true);
    expect(w.getBlock(4, 32, 4)).toBe(K('slime_block'));
    expect(w.getBlock(5, 31, 4)).toBe(K('honey_block')); // 未被带走
    // 推蜂蜜，侧面黏液留在原地；蜂蜜仍粘住另一侧石头
    const w2 = setup();
    w2.setBlock(4, 30, 4, pistonIdFor(false, 4));
    w2.setBlock(4, 31, 4, K('honey_block'));
    w2.setBlock(5, 31, 4, K('slime_block'));
    w2.setBlock(3, 31, 4, STONE);
    power(w2, 3, 30, 4, true);
    expect(w2.getBlock(4, 32, 4)).toBe(K('honey_block'));
    expect(w2.getBlock(5, 31, 4)).toBe(K('slime_block')); // 未被带走
    expect(w2.getBlock(3, 32, 4)).toBe(STONE); // 蜂蜜粘普通方块正常
  });

  it('不粘连例外：侧面黑曜石/火把不被带走（推仍成功）', () => {
    const w = setup();
    w.setBlock(4, 30, 4, pistonIdFor(false, 4));
    w.setBlock(4, 31, 4, K('slime_block'));
    w.setBlock(5, 31, 4, K('obsidian')); // 不可推块不粘
    w.setBlock(3, 31, 4, K('torch')); // 附着类不粘
    power(w, 3, 30, 4, true);
    expect(w.getBlock(4, 32, 4)).toBe(K('slime_block'));
    expect(w.getBlock(5, 31, 4)).toBe(K('obsidian')); // 留原地
    expect(w.getBlock(3, 31, 4)).toBe(K('torch')); // 留原地
  });

  it('粘性活塞收回把粘连块一并拉回', () => {
    const w = setup();
    w.setBlock(4, 30, 4, pistonIdFor(true, 4)); // 朝上粘性
    w.setBlock(4, 31, 4, K('slime_block'));
    w.setBlock(5, 31, 4, STONE); // 粘连的石头
    power(w, 3, 30, 4, true);
    expect(w.getBlock(4, 32, 4)).toBe(K('slime_block'));
    expect(w.getBlock(5, 32, 4)).toBe(STONE);
    power(w, 3, 30, 4, false);
    expect(w.getBlock(4, 31, 4)).toBe(K('slime_block')); // 拉回头部位置
    expect(w.getBlock(4, 32, 4)).toBe(AIR);
    expect(w.getBlock(5, 31, 4)).toBe(STONE); // 粘连块一并拉回
    expect(w.getBlock(5, 32, 4)).toBe(AIR);
  });

  it('被粘连带动的侦测器仍发脉冲（回归：飞行器原理）', () => {
    // 朝东活塞推黏液块，侦测器粘在黏液顶面被一并带走（不经推线，纯粘连路径）
    const w = setup();
    w.setBlock(4, 30, 4, pistonIdFor(false, 1)); // 朝东
    w.setBlock(5, 30, 4, K('slime_block'));
    w.setBlock(5, 31, 4, K('observer_w')); // 面朝 -x 检测、向 +x 输出；粘在黏液顶面
    w.setBlock(7, 31, 4, K('redstone_lamp')); // 推到 (6,31,4) 后输出端正对灯
    power(w, 3, 30, 4, true);
    expect(w.getBlock(6, 30, 4)).toBe(K('slime_block'));
    expect(w.getBlock(6, 31, 4)).toBe(K('observer_w')); // 被粘连推到新位置
    expect(w.getBlock(7, 31, 4)).toBe(K('redstone_lamp')); // 推动当帧不输出（经 tick 调度）
    tickRedstone(w, 0.1); // tick 消费 pushedObservers → 调度脉冲
    expect(w.getBlock(7, 31, 4)).toBe(K('redstone_lamp'));
    tickRedstone(w, 0.1); // 脉冲发出（延迟 1 红石刻）→ 灯亮
    expect(w.getBlock(7, 31, 4)).toBe(K('redstone_lamp_lit'));
    tickRedstone(w, 0.1); // 到期（持续 1 红石刻）→ 灯灭
    expect(w.getBlock(7, 31, 4)).toBe(K('redstone_lamp'));
  });
});
