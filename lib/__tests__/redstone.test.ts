// 红石供能：电源/粉传播衰减/灯亮灭/拉杆/门开关/TNT 引爆/火把反相/弱充能

import { beforeEach, describe, expect, it } from 'vitest';
import { AIR, BLOCK_BY_KEY, STONE } from '../blocks';
import { VOID_TERRAIN } from '../noise';
import { clearRedstone, dustPowerAt, poweredAt, rescanSources, tickRedstone, toggleLever } from '../redstone';
import { clearTnt, primedTnt } from '../tnt';
import { World } from '../world';

const K = (k: string) => BLOCK_BY_KEY[k].id;

function setup(): World {
  clearRedstone();
  clearTnt();
  return new World('rs-test', undefined, VOID_TERRAIN);
}

beforeEach(() => {
  clearRedstone();
  clearTnt();
});

describe('红石粉传播', () => {
  it('红石火把供能邻接粉 15 级，沿粉逐级衰减', () => {
    const w = setup();
    w.setBlock(4, 30, 4, STONE);
    w.setBlock(4, 31, 4, K('redstone_torch'));
    // 粉链：(5..9, 31, 4)，下方垫石头（放粉规则无关，直接写）
    for (let x = 5; x <= 9; x++) {
      w.setBlock(x, 30, 4, STONE);
      w.setBlock(x, 31, 4, K('redstone_dust'));
    }
    expect(dustPowerAt(5, 31, 4)).toBe(15);
    expect(dustPowerAt(6, 31, 4)).toBe(14);
    expect(dustPowerAt(9, 31, 4)).toBe(11);
  });

  it('粉断开后功率清零', () => {
    const w = setup();
    w.setBlock(4, 30, 4, STONE);
    w.setBlock(4, 31, 4, K('redstone_torch'));
    for (let x = 5; x <= 9; x++) {
      w.setBlock(x, 30, 4, STONE);
      w.setBlock(x, 31, 4, K('redstone_dust'));
    }
    expect(dustPowerAt(7, 31, 4)).toBeGreaterThan(0);
    w.setBlock(6, 31, 4, AIR); // 截断粉链
    expect(dustPowerAt(7, 31, 4)).toBe(0);
    expect(dustPowerAt(5, 31, 4)).toBe(15); // 火把侧仍在
  });
});

describe('红石灯', () => {
  it('粉供能点亮，断能熄灭', () => {
    const w = setup();
    w.setBlock(4, 30, 4, STONE);
    w.setBlock(4, 31, 4, K('redstone_torch'));
    w.setBlock(5, 30, 4, STONE);
    w.setBlock(5, 31, 4, K('redstone_dust'));
    w.setBlock(6, 31, 4, K('redstone_lamp'));
    expect(w.getBlock(6, 31, 4)).toBe(K('redstone_lamp_lit'));
    w.setBlock(4, 31, 4, AIR); // 挖掉火把
    expect(w.getBlock(6, 31, 4)).toBe(K('redstone_lamp'));
  });

  it('红石块邻接直接点亮', () => {
    const w = setup();
    w.setBlock(6, 31, 4, K('redstone_lamp'));
    w.setBlock(5, 31, 4, K('redstone_block'));
    expect(w.getBlock(6, 31, 4)).toBe(K('redstone_lamp_lit'));
  });
});

describe('拉杆', () => {
  it('右击切换供能，灯随之亮灭', () => {
    const w = setup();
    w.setBlock(4, 31, 4, K('lever'));
    w.setBlock(5, 31, 4, K('redstone_lamp'));
    expect(w.getBlock(5, 31, 4)).toBe(K('redstone_lamp')); // 关着不供能
    expect(toggleLever(w, 4, 31, 4)).toBe(true);
    expect(w.getBlock(5, 31, 4)).toBe(K('redstone_lamp_lit'));
    expect(toggleLever(w, 4, 31, 4)).toBe(false);
    expect(w.getBlock(5, 31, 4)).toBe(K('redstone_lamp'));
  });
});

describe('门与 TNT', () => {
  it('供能开门、断能关门（上下两格同步）', () => {
    const w = setup();
    w.setBlock(4, 30, 4, STONE);
    const base = K('oak_door_bottom_n');
    w.setBlock(4, 31, 4, base);
    w.setBlock(4, 32, 4, base + 1);
    w.setBlock(3, 31, 4, K('redstone_torch'));
    expect(w.getBlock(4, 31, 4)).toBe(base + 2); // open_bottom
    expect(w.getBlock(4, 32, 4)).toBe(base + 3); // open_top
    w.setBlock(3, 31, 4, AIR);
    expect(w.getBlock(4, 31, 4)).toBe(base);
    expect(w.getBlock(4, 32, 4)).toBe(base + 1);
  });

  it('供能引爆 TNT（方块消失，生成引信实体）', () => {
    const w = setup();
    w.setBlock(4, 31, 4, K('tnt'));
    w.setBlock(3, 31, 4, K('redstone_torch'));
    expect(w.getBlock(4, 31, 4)).toBe(AIR);
    expect(primedTnt.length).toBe(1);
  });

  it('poweredAt 判定：邻接电源或有功率粉', () => {
    const w = setup();
    w.setBlock(4, 30, 4, STONE);
    w.setBlock(4, 31, 4, K('redstone_torch'));
    expect(poweredAt(5, 31, 4)).toBe(true);
    expect(poweredAt(8, 31, 8)).toBe(false);
  });
});

describe('中继器定向供电', () => {
  it('on 态中继器只对输出面朝的邻位供电（MC）；火把/红石块全向', () => {
    const w = setup();
    w.setBlock(4, 31, 4, K('repeater_on_e')); // 输出朝 +x
    expect(poweredAt(5, 31, 4)).toBe(true); // 输出面
    expect(poweredAt(3, 31, 4)).toBe(false); // 背面不供
    expect(poweredAt(4, 31, 5)).toBe(false); // 侧面不供
    expect(poweredAt(4, 32, 4)).toBe(false); // 顶面不供
    // 全向电源对照：红石块 6 邻位都供电
    w.setBlock(10, 31, 4, K('redstone_block'));
    expect(poweredAt(10, 32, 4)).toBe(true);
    expect(poweredAt(10, 31, 5)).toBe(true);
  });
});

describe('长链路', () => {
  it('按建造顺序布 30 格链（粉15+中继器+粉15）：远端不被误清；上游断开后远端清零（无幽灵信号）', () => {
    const w = setup();
    w.setBlock(0, 30, 4, STONE);
    w.setBlock(0, 31, 4, K('redstone_torch'));
    for (let x = 1; x <= 15; x++) {
      w.setBlock(x, 30, 4, STONE);
      w.setBlock(x, 31, 4, K('redstone_dust'));
    }
    w.setBlock(16, 30, 4, STONE);
    w.setBlock(16, 31, 4, K('repeater_e'));
    for (let x = 17; x <= 31; x++) {
      w.setBlock(x, 30, 4, STONE);
      w.setBlock(x, 31, 4, K('redstone_dust'));
    }
    for (let i = 0; i < 4; i++) tickRedstone(w, 0.1);
    // 远端功率不被局部重算误清：中继器正常翻开，末端带电
    expect(w.getBlock(16, 31, 4)).toBe(K('repeater_on_e'));
    expect(dustPowerAt(31, 31, 4)).toBeGreaterThan(0);
    // 上游断开：功率沿链路级联清零，远端不留幽灵信号
    w.setBlock(0, 31, 4, AIR);
    for (let i = 0; i < 6; i++) tickRedstone(w, 0.1);
    expect(dustPowerAt(15, 31, 4)).toBe(0);
    expect(dustPowerAt(31, 31, 4)).toBe(0);
  });
});

describe('电源重扫持久化', () => {
  it('clearRedstone 后 rescanSources 重建登记：火把/拉杆/中继器恢复供能', () => {
    const w = setup();
    w.setBlock(4, 30, 4, STONE);
    w.setBlock(4, 31, 4, K('redstone_torch'));
    w.setBlock(5, 30, 4, STONE);
    w.setBlock(5, 31, 4, K('redstone_dust'));
    w.setBlock(6, 31, 4, K('redstone_lamp'));
    w.setBlock(8, 31, 4, K('lever'));
    toggleLever(w, 8, 31, 4);
    expect(w.getBlock(6, 31, 4)).toBe(K('redstone_lamp_lit'));
    expect(poweredAt(9, 31, 4)).toBe(true);
    // 模拟换维度/读档：内存供能态清空，方块仍在
    clearRedstone();
    expect(dustPowerAt(5, 31, 4)).toBe(0);
    expect(poweredAt(9, 31, 4)).toBe(false);
    rescanSources(w);
    // 电源恢复登记，粉网络与灯恢复供能
    expect(dustPowerAt(5, 31, 4)).toBe(15);
    expect(poweredAt(9, 31, 4)).toBe(true);
    expect(w.getBlock(6, 31, 4)).toBe(K('redstone_lamp_lit'));
    // 再挖掉火把，灯正常熄灭（登记表在正常工作）
    w.setBlock(4, 31, 4, AIR);
    expect(w.getBlock(6, 31, 4)).toBe(K('redstone_lamp'));
  });
});

describe('红石火把反相（NOT 门）', () => {
  it('附着方块被拉杆充能时火把熄灭断供，失去充能复亮（MC）', () => {
    const w = setup();
    w.setBlock(4, 30, 4, STONE); // 火把的支撑块
    w.setBlock(4, 31, 4, K('redstone_torch'));
    w.setBlock(5, 30, 4, STONE);
    w.setBlock(5, 31, 4, K('redstone_dust'));
    w.setBlock(3, 30, 4, K('lever')); // 拉杆贴着支撑块
    expect(dustPowerAt(5, 31, 4)).toBe(15); // 初始火把供电
    toggleLever(w, 3, 30, 4); // 开：支撑块被充能 → 火把反相熄灭
    expect(w.getBlock(4, 31, 4)).toBe(K('redstone_torch_off'));
    tickRedstone(w, 0.1); // 结算重播：下游粉断供（等价 MC 火把延迟）
    expect(dustPowerAt(5, 31, 4)).toBe(0);
    toggleLever(w, 3, 30, 4); // 关：支撑块失能 → 火把复亮
    expect(w.getBlock(4, 31, 4)).toBe(K('redstone_torch'));
    tickRedstone(w, 0.1);
    expect(dustPowerAt(5, 31, 4)).toBe(15);
  });

  it('附着块被带电粉充能同样反相（粉驱动的 NOT 门）', () => {
    const w = setup();
    w.setBlock(0, 30, 4, K('redstone_torch')); // 火把 A（悬空直接写）
    w.setBlock(1, 30, 4, K('redstone_dust'));
    w.setBlock(2, 30, 4, STONE); // 火把 B 的支撑，贴着带电粉
    w.setBlock(2, 31, 4, K('redstone_torch')); // 火把 B
    expect(w.getBlock(0, 30, 4)).toBe(K('redstone_torch')); // A 支撑是空气，不受影响
    expect(w.getBlock(2, 31, 4)).toBe(K('redstone_torch_off')); // B 反相熄灭
    w.setBlock(1, 30, 4, AIR); // 撤粉
    expect(w.getBlock(2, 31, 4)).toBe(K('redstone_torch')); // B 复亮
  });

  it('火把塔交替：下火把充能正上方块，坐在上面的火把熄灭（MC 弱充能上传）', () => {
    const w = setup();
    w.setBlock(4, 30, 4, STONE);
    w.setBlock(4, 31, 4, K('redstone_torch')); // T1
    w.setBlock(4, 32, 4, STONE); // T1 正上方块（被弱充能）
    w.setBlock(4, 33, 4, K('redstone_torch')); // T2 坐在其上 → 熄灭
    expect(w.getBlock(4, 33, 4)).toBe(K('redstone_torch_off'));
    expect(w.getBlock(4, 31, 4)).toBe(K('redstone_torch')); // T1 支撑未被充能，保持亮
  });
});

describe('固体方块弱充能', () => {
  it('拉杆→方块→粉 不导通（MC Java：拉杆是弱充能，弱充能块不驱动粉）；拉杆直供邻接粉不受影响', () => {
    // 旧断言把「拉杆→方块→粉导通」标注为 (MC)，标注是错的：Java 中拉杆只弱充能支撑块，
    // 弱充能块激活邻接元件但不驱动邻接粉（只有强充能块才驱动粉）
    const w = setup();
    w.setBlock(4, 30, 4, STONE); // 拉杆的支撑块
    w.setBlock(4, 31, 4, K('lever'));
    w.setBlock(5, 29, 4, STONE);
    w.setBlock(5, 30, 4, K('redstone_dust')); // 贴着石块，不贴着拉杆
    w.setBlock(6, 29, 4, STONE);
    w.setBlock(6, 30, 4, K('redstone_dust'));
    expect(dustPowerAt(5, 30, 4)).toBe(0);
    toggleLever(w, 4, 31, 4);
    expect(dustPowerAt(5, 30, 4)).toBe(0); // 石块被弱充能 → 不驱动粉（MC Java）
    expect(dustPowerAt(6, 30, 4)).toBe(0);
    // 对照：拉杆直接邻接的粉仍被供能 15（电源直接供粉，不经方块中转）
    w.setBlock(5, 30, 4, AIR);
    w.setBlock(5, 31, 4, K('redstone_dust'));
    expect(dustPowerAt(5, 31, 4)).toBe(15);
    toggleLever(w, 4, 31, 4);
    expect(dustPowerAt(5, 31, 4)).toBe(0);
  });

  it('弱充能方块驱动邻接元件（灯），且弱充能不链式外传（方块→方块不传）', () => {
    const w = setup();
    w.setBlock(4, 30, 4, STONE); // A：拉杆支撑
    w.setBlock(4, 31, 4, K('lever'));
    w.setBlock(4, 29, 4, STONE); // B：贴着 A
    w.setBlock(5, 28, 4, STONE);
    w.setBlock(5, 29, 4, K('redstone_dust')); // 贴着 B，不贴着 A
    w.setBlock(3, 30, 4, K('redstone_lamp')); // 贴着 A，不贴着拉杆
    toggleLever(w, 4, 31, 4);
    expect(w.getBlock(3, 30, 4)).toBe(K('redstone_lamp_lit')); // A 弱充能 → 灯亮
    expect(dustPowerAt(5, 29, 4)).toBe(0); // B 不被充能：弱充能只一层（MC 简化）
    expect(poweredAt(3, 30, 4)).toBe(true);
    toggleLever(w, 4, 31, 4);
    expect(w.getBlock(3, 30, 4)).toBe(K('redstone_lamp'));
  });

  it('中继器输出充能前方实心块，块外粉导通（MC 强充能：强充能块驱动邻接粉）', () => {
    const w = setup();
    w.setBlock(4, 31, 4, K('repeater_on_e')); // 输出 +x
    w.setBlock(5, 31, 4, STONE); // 被强充能
    w.setBlock(6, 30, 4, STONE);
    w.setBlock(6, 31, 4, K('redstone_dust')); // 贴着石块
    expect(dustPowerAt(6, 31, 4)).toBe(15);
    expect(poweredAt(5, 32, 4)).toBe(true); // 石块邻位视为供能
  });
});

describe('粉跨高度对角连接', () => {
  it('上坡连接：粉沿对角爬坡每步只衰减 1 级；本格上方实心切断（Java 压线规则），移除后恢复', () => {
    const w = setup();
    w.setBlock(4, 30, 4, STONE);
    w.setBlock(4, 31, 4, K('redstone_torch'));
    w.setBlock(5, 30, 4, STONE);
    w.setBlock(5, 31, 4, K('redstone_dust')); // 15
    w.setBlock(6, 30, 4, STONE);
    w.setBlock(6, 31, 4, STONE); // 高一格的台阶
    w.setBlock(6, 32, 4, K('redstone_dust')); // 上坡粉
    expect(dustPowerAt(5, 31, 4)).toBe(15);
    expect(dustPowerAt(6, 32, 4)).toBe(14); // 对角上坡只衰减 1 级
    w.setBlock(5, 32, 4, STONE); // (5,31,4) 上方变实心 → 切断上坡（Java 压线规则）
    expect(dustPowerAt(6, 32, 4)).toBe(0);
    w.setBlock(5, 32, 4, AIR); // 移除后连接恢复
    expect(dustPowerAt(6, 32, 4)).toBe(14);
  });

  it('下坡连接：角格实心不切断（Java：上方块实心才切断上坡，下坡保持连接）', () => {
    const w = setup();
    w.setBlock(4, 31, 4, STONE);
    w.setBlock(4, 32, 4, K('redstone_torch'));
    w.setBlock(5, 31, 4, STONE);
    w.setBlock(5, 32, 4, K('redstone_dust')); // 15，与火把同层
    w.setBlock(6, 30, 4, STONE);
    w.setBlock(6, 31, 4, K('redstone_dust')); // 下坡粉
    expect(dustPowerAt(6, 31, 4)).toBe(14);
    w.setBlock(6, 32, 4, STONE); // 下坡角格（与上方粉同层）实心：Java 不切断下坡
    expect(dustPowerAt(6, 31, 4)).toBe(14);
  });

  it('功率沿坡道逐级上行（低端电源经连续上坡供到高端，每步 -1）', () => {
    const w = setup();
    w.setBlock(4, 30, 4, STONE);
    w.setBlock(4, 31, 4, K('redstone_torch'));
    w.setBlock(5, 30, 4, STONE);
    w.setBlock(5, 31, 4, K('redstone_dust')); // 15 低端
    w.setBlock(6, 30, 4, STONE);
    w.setBlock(6, 31, 4, STONE);
    w.setBlock(6, 32, 4, K('redstone_dust')); // 14
    w.setBlock(7, 31, 4, STONE);
    w.setBlock(7, 32, 4, STONE);
    w.setBlock(7, 33, 4, K('redstone_dust')); // 13
    expect(dustPowerAt(6, 32, 4)).toBe(14);
    expect(dustPowerAt(7, 33, 4)).toBe(13);
  });
});

describe('粉按指向供能', () => {
  it('一字形粉只供两端方向：中段侧面与正上方不供能，正下方块被弱充能（MC Java）', () => {
    const w = setup();
    w.setBlock(4, 30, 4, STONE);
    w.setBlock(4, 31, 4, K('redstone_torch'));
    w.setBlock(5, 30, 4, STONE);
    w.setBlock(5, 31, 4, K('redstone_dust'));
    w.setBlock(6, 30, 4, STONE);
    w.setBlock(6, 31, 4, K('redstone_dust')); // 一字形 (5)-(6)，指向 ±x
    w.setBlock(5, 31, 5, K('redstone_lamp')); // 中段北侧：一字形不供侧向
    w.setBlock(6, 32, 4, K('redstone_lamp')); // 正上方：任何形态都不供
    w.setBlock(7, 30, 4, K('redstone_lamp')); // (6,31,4) 正下方块被弱充能 → 激活 6 邻元件
    expect(w.getBlock(5, 31, 5)).toBe(K('redstone_lamp'));
    expect(w.getBlock(6, 32, 4)).toBe(K('redstone_lamp'));
    expect(w.getBlock(7, 30, 4)).toBe(K('redstone_lamp_lit'));
  });

  it('点状粉供水平四向（MC Java）', () => {
    const w = setup();
    w.setBlock(4, 30, 4, STONE);
    w.setBlock(4, 31, 4, K('redstone_torch'));
    w.setBlock(5, 30, 4, STONE);
    w.setBlock(5, 31, 4, K('redstone_dust')); // 点状（火把不是粉，无连接）
    w.setBlock(5, 31, 5, K('redstone_lamp'));
    w.setBlock(5, 31, 3, K('redstone_lamp'));
    w.setBlock(6, 31, 4, K('redstone_lamp'));
    expect(w.getBlock(5, 31, 5)).toBe(K('redstone_lamp_lit'));
    expect(w.getBlock(5, 31, 3)).toBe(K('redstone_lamp_lit'));
    expect(w.getBlock(6, 31, 4)).toBe(K('redstone_lamp_lit'));
  });

  it('粉弱充能指向的实心块：激活 6 邻元件但不驱动邻接粉（MC Java）', () => {
    const w = setup();
    w.setBlock(4, 30, 4, STONE);
    w.setBlock(4, 31, 4, K('redstone_torch'));
    w.setBlock(5, 30, 4, STONE);
    w.setBlock(5, 31, 4, K('redstone_dust')); // 点状 15，指向水平四向
    w.setBlock(6, 31, 4, STONE); // 被粉弱充能
    w.setBlock(7, 30, 4, STONE);
    w.setBlock(7, 31, 4, K('redstone_dust')); // 贴着被弱充能的块：不得电（弱充能不驱动粉）
    w.setBlock(6, 31, 5, K('redstone_lamp')); // 被充能块的邻接元件 → 亮
    expect(dustPowerAt(7, 31, 4)).toBe(0);
    expect(w.getBlock(6, 31, 5)).toBe(K('redstone_lamp_lit'));
  });
});

describe('强充能驱动粉', () => {
  it('红石火把正上方块被强充能：驱动邻接粉 15 并沿粉衰减；挖掉即断供（MC Java）', () => {
    const w = setup();
    w.setBlock(4, 30, 4, STONE);
    w.setBlock(4, 31, 4, K('redstone_torch'));
    w.setBlock(4, 32, 4, STONE); // 火把正上方块 → 强充能
    w.setBlock(5, 31, 4, STONE);
    w.setBlock(5, 32, 4, K('redstone_dust')); // 贴着强充能块 → 15
    w.setBlock(6, 31, 4, STONE);
    w.setBlock(6, 32, 4, K('redstone_dust')); // 14
    expect(dustPowerAt(5, 32, 4)).toBe(15);
    expect(dustPowerAt(6, 32, 4)).toBe(14);
    w.setBlock(4, 32, 4, AIR); // 挖掉正上方块 → 强充能消失
    expect(dustPowerAt(5, 32, 4)).toBe(0);
    expect(dustPowerAt(6, 32, 4)).toBe(0);
  });
});

describe('红石火把烧毁（burnout，MC Java：60 游戏刻=3s 内切换 8 次烧毁，收到方块更新才重燃）', () => {
  /** 自反馈环：火把 → 粉 → 弱充能火把支撑块 → 火把反相（奇数反相 = 振荡） */
  function torchRing(w: World): void {
    w.setBlock(0, 29, 4, STONE); // 火把支撑块
    w.setBlock(0, 30, 4, K('redstone_torch'));
    w.setBlock(1, 30, 4, K('redstone_dust')); // 15（火把直供）
    w.setBlock(2, 30, 4, K('redstone_dust')); // 14
    w.setBlock(1, 29, 4, K('redstone_dust')); // 13（(2,30,4) 下坡对角）
    w.setBlock(0, 28, 4, K('redstone_dust')); // 12（尾巴：让 (1,29,4) 成一字形指向 ±x，弱充能支撑块 (0,29,4)）
  }

  it('自反馈环疯狂闪烁后烧毁恒灭；邻近方块更新后重燃并可再次烧毁', () => {
    const w = setup();
    torchRing(w);
    // 确实在振荡：逐 tick 观察 ON/OFF 都出现
    const seen = new Set<number>();
    for (let i = 0; i < 4; i++) {
      tickRedstone(w, 0.1);
      seen.add(w.getBlock(0, 30, 4));
    }
    expect(seen.size).toBe(2);
    // 3s 窗口内切满 8 次 → 烧毁：恒灭
    for (let i = 0; i < 20; i++) tickRedstone(w, 0.1);
    expect(w.getBlock(0, 30, 4)).toBe(K('redstone_torch_off'));
    // 再跑 4s（超出 3s 窗口，旧翻转全过期）仍灭——烧毁态不自动解除
    for (let i = 0; i < 40; i++) tickRedstone(w, 0.1);
    expect(w.getBlock(0, 30, 4)).toBe(K('redstone_torch_off'));
    // 邻近方块更新（火把正上方放方块）→ 清除烧毁态，重算重燃
    w.setBlock(0, 31, 4, STONE);
    expect(w.getBlock(0, 30, 4)).toBe(K('redstone_torch'));
    // 振荡恢复，翻转计数已重置 → 再次切满 8 次又烧毁
    for (let i = 0; i < 20; i++) tickRedstone(w, 0.1);
    expect(w.getBlock(0, 30, 4)).toBe(K('redstone_torch_off'));
  });

  it('慢速切换不烧毁：3s 窗口外的翻转不计（拉杆慢拨 8 次，火把照常响应）', () => {
    const w = setup();
    w.setBlock(4, 30, 4, STONE);
    w.setBlock(4, 31, 4, K('redstone_torch'));
    w.setBlock(3, 30, 4, K('lever')); // 拉杆贴着支撑块：开 → 火把反相熄灭
    for (let i = 0; i < 8; i++) {
      toggleLever(w, 3, 30, 4);
      tickRedstone(w, 0.5); // 每次翻转间隔 0.5s，8 次跨 3.5s > 3s 窗口
    }
    // 未烧毁：第 9/10 次仍能正常翻转
    toggleLever(w, 3, 30, 4);
    expect(w.getBlock(4, 31, 4)).toBe(K('redstone_torch_off'));
    toggleLever(w, 3, 30, 4);
    expect(w.getBlock(4, 31, 4)).toBe(K('redstone_torch'));
  });
});
