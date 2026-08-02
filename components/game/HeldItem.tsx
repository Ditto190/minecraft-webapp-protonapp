'use client';

// 第一人称手持物渲染与挥动动画（Java 观感）：
// 容器 group 每帧对齐相机（position+quaternion），手持物在相机空间视野右下；
// 方块槽渲染小立方体（顶/侧贴图，几何同 ItemDrops），材料/工具/装备槽渲染贴图面片。
// 动画五套：攻击/放置单击挥下（读 handSwing 时间戳）、挖掘长按往复挥动（随 digState 启停）、
// 进食举到嘴边咀嚼（随 eatState）、切槽/换物再装备（降下再升起）、弓拉弦移向准星（读 bowState.draw，优先于挥动/挖掘/进食）。
// 附魔工具/装备叠紫色 additive 呼吸光泽罩层（模式同 ItemDrops，材质关深度测试跟随手部 pass）。帧循环零分配。

import { useEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { AdditiveBlending, BufferAttribute, BufferGeometry, Group, Mesh, MeshBasicMaterial, PerspectiveCamera, type Material } from 'three';
import { EAT_DURATION, eatState } from '@/lib/actions';
import { armorDefOf } from '@/lib/armor';
import { atlasUV } from '@/lib/blocks';
import { bowState, digState, handSwing, touchInput } from '@/lib/game';
import { materialTile } from '@/lib/materials';
import { buildBlockGeometry } from '@/lib/mesher';
import type { Slot } from '@/lib/slots';
import { useGameStore } from '@/lib/store';
import { getAtlasMaterials } from '@/lib/textures';
import { TOOLS } from '@/lib/tools';
import { toGeometry } from './ChunkMesh';
import { useRendererKind } from './renderer-kind';
import { slotEnchanted } from './slotDisplay';

/** 手部基准偏移（相机空间，视野右下）：Java 第一人称手部位置的手调近似 */
const HAND_X = 0.56;
const HAND_Y = -0.52;
const HAND_Z = -0.9;
/** 攻击/放置挥动时长（ms）：快速挥下再回（与 Player 对准空气按住时的挥动重触发节奏一致） */
const SWING_MS = 250;
/** 切槽/换物再装备时长（ms）：物品快速降下再升起（Java re-equip 的加速版） */
const EQUIP_MS = 150;
/** 挖掘长按往复挥动周期（秒） */
const DIG_PERIOD = 0.3;
/** 手持物最后绘制（配合材质关深度测试：不穿模，等效 Java 第一人称手部独立深度 pass） */
const HAND_RENDER_ORDER = 999;

/** 弓拉弦进度 0→1（lib/game.ts 的 bowState，拉弦逻辑写入；钳制到 [0,1] 防越界） */
function bowDrawAmount(): number {
  return Math.min(Math.max(bowState.draw, 0), 1);
}

/**
 * 材料/工具/装备的手持面片几何：1×1 平面（中心原点）。
 * 简化为单平面双面（Java 为逐像素挤出厚度）——正反两副三角成对发射，兼容 FrontSide 的 atlas 材质（同 mesher addCross）。
 * UV 水平镜像：工具贴图剑尖朝右上，镜像后朝左上，配合 itemGroup 的 y 轴旋转对齐 Java 持械朝向。
 */
function buildFlatGeometry(tile: number): BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  for (const flip of [false, true]) {
    const ndx = positions.length / 3;
    for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]] as const) {
      positions.push(u - 0.5, v - 0.5, 0);
      normals.push(0, 0, flip ? -1 : 1);
      uvs.push(...atlasUV(tile, 1 - u, v));
      // 满亮度顶点色（atlas 材质开 vertexColors，必须提供颜色属性；面片不做 AO）
      colors.push(1, 1, 1);
    }
    if (flip) indices.push(ndx, ndx + 2, ndx + 1, ndx, ndx + 3, ndx + 2);
    else indices.push(ndx, ndx + 1, ndx + 2, ndx, ndx + 2, ndx + 3);
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  geo.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  geo.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
  geo.setIndex(indices);
  return geo;
}

/** 第一人称手持物：须在 Player 之后挂载（同优先级 useFrame 按挂载序执行，读到当帧最终相机位姿） */
export function HeldItem() {
  const camGroupRef = useRef<Group>(null); // 对齐相机的容器
  const handRef = useRef<Group>(null); // 手部基准偏移 + 全部动画（每帧写）
  const itemGroupRef = useRef<Group>(null); // 物品自身朝向（切槽时设置一次）
  const meshRef = useRef<Mesh | null>(null);
  const geoCache = useRef(new Map<string, BufferGeometry>());
  const heldMatRef = useRef<Material | null>(null);
  /** 附魔光泽材质（additive 紫，全部附魔手持物共享一份，useFrame 里整体脉动；同 ItemDrops） */
  const glintMatRef = useRef<MeshBasicMaterial | null>(null);
  /** 上一帧手持物标识（逐字段比较，帧循环零分配；变化 = 切槽/换物/附魔增减 → 重建 mesh + 再装备动画） */
  const prevRef = useRef({ sel: -1, kind: '', key: '' as string | number, sub: '', ench: false });
  const equipAt = useRef(-1000);
  const digPhase = useRef(0);
  const eatBlend = useRef(0);
  const drawBlend = useRef(0); // 弓拉弦权重平滑跟随 draw（起弦快、松手指数回弹）
  const sneakBlend = useRef(0);
  /** 潜行输入（桌面 Shift；Player 的 keys 不导出，自持一份——纯视觉小偏移，从简） */
  const sneakKey = useRef(false);
  const kind = useRendererKind();

  // 手持物专用材质：与 ItemDrops 同一条 lambert(atlas) 路径（webgl/webgpu 通用），
  // 但关深度测试/写入——手部永远画在世界之上不穿墙（等效 Java 的第一人称手部独立渲染 pass）
  useEffect(() => {
    let disposed = false;
    const geos = geoCache.current;
    const prev = prevRef.current;
    // 附魔光泽材质：同 ItemDrops 的 additive 紫，但关深度测试——跟随手部 pass 画在世界之上，否则被世界挡住
    const glint = new MeshBasicMaterial({
      color: '#b26bff',
      transparent: true,
      opacity: 0.3,
      blending: AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      fog: false,
    });
    glintMatRef.current = glint;
    void getAtlasMaterials(kind).then((mats) => {
      if (disposed) return;
      const mat = mats.lambert({ map: mats.texture, alphaTest: 0.5, vertexColors: true });
      mat.depthTest = false;
      mat.depthWrite = false;
      heldMatRef.current = mat;
      prev.sel = -1; // 材质就绪：强制重建当前手持物 mesh
    });
    return () => {
      disposed = true;
      glint.dispose();
      glintMatRef.current = null;
      heldMatRef.current?.dispose();
      heldMatRef.current = null;
      for (const g of geos.values()) g.dispose(); // 几何缓存卸载时释放 GPU 资源
      geos.clear();
      prev.sel = -1; // effect 重跑（StrictMode/渲染器切换重建）后强制重建
    };
  }, [kind]);

  // 潜行键（桌面 Shift；触屏读 touchInput.sneak 开关）
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') sneakKey.current = true;
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') sneakKey.current = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  /** 切槽/换物时重建手持 mesh：几何按内容缓存（方块 id / 图标 tile），材质共享手持专用 atlas 材质；空手移除不渲染 */
  function syncMesh(slot: Slot): void {
    if (meshRef.current) {
      meshRef.current.removeFromParent();
      meshRef.current = null;
    }
    const itemGroup = itemGroupRef.current;
    const mat = heldMatRef.current;
    if (!slot || !mat || !itemGroup) return;
    let geoKey: string;
    let build: () => BufferGeometry | null;
    if (slot.kind === 'block') {
      const blockId = slot.id; // 提前取值，TS 无法把窄化带进闭包（同 ItemDrops）
      geoKey = `b:${blockId}`;
      build = () => {
        // 顶/侧/底贴图 + 顶点色明暗，与 ItemDrops 同款几何；水/岩浆等流体无几何内容，按空手处理
        const g = toGeometry(buildBlockGeometry(blockId));
        g?.translate(-0.5, -0.5, -0.5); // [0,1]³ 原点几何移到中心：旋转/缩放围绕中心
        return g;
      };
    } else {
      // 工具/材料/装备各自取对应的图标 tile（同 ItemDrops geometryForDrop）
      const tile =
        slot.kind === 'tool' ? TOOLS[slot.tool].iconTile : slot.kind === 'material' ? materialTile(slot.material) : armorDefOf(slot).iconTile;
      geoKey = `t:${tile}`;
      build = () => buildFlatGeometry(tile);
    }
    let geo = geoCache.current.get(geoKey);
    if (!geo) {
      const built = build();
      if (!built) return;
      geoCache.current.set(geoKey, built);
      geo = built;
    }
    // 物品自身朝向（静态，切槽才设置；动画都作用在外层 hand 上）
    if (slot.kind === 'block') {
      // 小立方体：y 45° 展示两侧面、略前倾展示顶面
      itemGroup.position.set(0, 0.03, 0);
      itemGroup.rotation.set(0.18, Math.PI / 4, 0);
      itemGroup.scale.setScalar(0.36);
    } else {
      // 面片：y 左旋 45°（剑尖朝前上方，Java 持械观感），略前倾
      itemGroup.position.set(0, 0.06, 0);
      itemGroup.rotation.set(-0.08, -Math.PI / 4, 0);
      itemGroup.scale.setScalar(0.62);
    }
    const mesh = new Mesh(geo, mat);
    mesh.renderOrder = HAND_RENDER_ORDER;
    mesh.frustumCulled = false; // 跟随相机的小物件：包围球剔除无意义且可能误剔
    // 附魔工具/装备：略大的紫色 additive 罩层（复用同一几何，子节点随手持动画；模式同 ItemDrops）
    const glintMat = glintMatRef.current;
    if (glintMat && slotEnchanted(slot)) {
      const glow = new Mesh(geo, glintMat);
      glow.scale.setScalar(1.12);
      glow.renderOrder = HAND_RENDER_ORDER + 1; // 紧跟手持物之后叠加
      glow.frustumCulled = false;
      mesh.add(glow);
    }
    itemGroup.add(mesh);
    meshRef.current = mesh;
  }

  useFrame((state, delta) => {
    const camGroup = camGroupRef.current;
    const hand = handRef.current;
    if (!camGroup || !hand) return;
    // 每帧把容器对齐到相机：视角摆动/落地下顿/受伤倾斜/爆炸震动/冲刺 FOV 变化都随相机，手持物在视野内位置稳定
    camGroup.position.copy(state.camera.position);
    camGroup.quaternion.copy(state.camera.quaternion);
    const s = useGameStore.getState();
    if (s.paused) return; // 暂停时相机静止、游戏逻辑冻结（同 ItemDrops：动画一并冻结）
    const dt = Math.min(delta, 0.05);
    const now = performance.now();

    // 附魔光泽整体呼吸：透明度 + 色相缓慢摆动（共享材质一次更新，同 ItemDrops）
    const glintMat = glintMatRef.current;
    if (glintMat) {
      const t = state.clock.elapsedTime;
      glintMat.opacity = 0.24 + Math.sin(t * 2.2) * 0.1;
      glintMat.color.setHSL(0.76 + Math.sin(t * 0.8) * 0.03, 0.85, 0.62);
    }

    // —— 切槽/换物检测（逐字段比较，不含数量：进食/放置消耗不触发再装备） ——
    const slot = s.hotbarSlots[s.selectedSlot];
    const prev = prevRef.current;
    const sKind = slot?.kind ?? '';
    const sKey = slot
      ? slot.kind === 'block'
        ? slot.id
        : slot.kind === 'material'
          ? slot.material
          : slot.kind === 'tool'
            ? slot.tool
            : slot.piece
      : '';
    const sSub = slot?.kind === 'armor' ? (slot.material ?? '') : '';
    const sEnch = slotEnchanted(slot); // 附魔获得/洗去也触发重建（光泽罩层增减）
    if (s.selectedSlot !== prev.sel || sKind !== prev.kind || sKey !== prev.key || sSub !== prev.sub || sEnch !== prev.ench) {
      prev.sel = s.selectedSlot;
      prev.kind = sKind;
      prev.key = sKey;
      prev.sub = sSub;
      prev.ench = sEnch;
      equipAt.current = now; // 再装备动画：物品快速降下再升起（Java re-equip 观感）
      syncMesh(slot);
    }

    // —— 位姿合成：基准 → 潜行 → 再装备 → 挥动/挖掘（进食/拉弓时淡出）→ 进食（拉弓时淡出）→ 拉弓 ——
    // 窄屏（竖屏）按可视半宽内收 x，保证手持物在画面内；用设置基准 FOV（非冲刺放大后的实时 FOV），冲刺时位置稳定
    const cam = state.camera as PerspectiveCamera;
    const halfW = Math.tan((s.settings.fov * Math.PI) / 360) * cam.aspect * -HAND_Z;
    let px = Math.min(HAND_X, halfW * 0.62);
    let py = HAND_Y;
    let pz = HAND_Z;
    let rx = 0;
    let ry = 0;

    // 潜行时手持物略降（可选近似：Shift/触屏 sneak + 非飞行；未像 Player 那样排除水中——纯视觉小偏移）
    const sneakTarget = (sneakKey.current || touchInput.sneak) && !s.flying ? 1 : 0;
    sneakBlend.current += (sneakTarget - sneakBlend.current) * Math.min(1, dt * 10);
    py -= 0.05 * sneakBlend.current;

    // 再装备：降下再升起（切槽/换物触发）
    const et = (now - equipAt.current) / EQUIP_MS;
    if (et < 1) {
      const k = Math.sin(Math.PI * et);
      py -= 0.42 * k;
      rx -= 0.85 * k;
    }

    // 弓拉弦权重：draw 平滑跟随（起弦快、松手指数回弹）；拉弓优先——挥动/挖掘/进食随之淡出
    drawBlend.current += (bowDrawAmount() - drawBlend.current) * Math.min(1, dt * 12);
    const nd = 1 - drawBlend.current;

    // 进食权重：eatState.active 期间趋近 1（举到嘴边），挥动/挖掘随之淡出（Java：进食中手臂动作被吃姿取代）
    eatBlend.current += ((eatState.active ? 1 : 0) - eatBlend.current) * Math.min(1, dt * 14);
    const ne = (1 - eatBlend.current) * nd;

    // 攻击/放置挥动：handSwing.at 时间戳触发，快速挥下再回（包络峰值 ~40%：前冲快、回落缓）
    const st = (now - handSwing.at) / SWING_MS;
    if (st < 1 && ne > 0.01) {
      const k = Math.sin(Math.PI * Math.pow(Math.max(st, 0), 0.75)) * ne;
      rx -= 1.0 * k; // 向前下方挥下
      ry -= 0.3 * k;
      py -= 0.16 * k;
      pz -= 0.1 * k;
    }

    // 挖掘长按：持续往复挥动（随 digState 激活启停；松手/挖碎/移开准星中断时相位归零，下次从头起挥）
    if (digState.target && ne > 0.01) {
      digPhase.current += (dt * Math.PI * 2) / DIG_PERIOD;
      const k = Math.sin(digPhase.current) * ne;
      rx -= 0.42 * k;
      py += 0.03 * k;
      pz -= 0.06 * Math.max(0, k);
    } else {
      digPhase.current = 0;
    }

    // 进食：举到嘴边 + 小幅咀嚼抖动（与 Player 的进食碎屑同频：0.2s 一口；拉弓时淡出）
    const e = eatBlend.current * nd;
    if (e > 0.001) {
      px += (0.15 - px) * e;
      py += (-0.3 - py) * e;
      pz += (-0.78 - pz) * e;
      rx += 0.55 * e; // 上端倾向嘴边
      if (eatState.active) {
        const chew = eatState.progress * (EAT_DURATION / 0.2) * Math.PI * 2;
        py += Math.sin(chew) * 0.025 * e;
        rx += Math.sin(chew * 2 + 1) * 0.045 * e;
      }
    }

    // 拉弓：弓移向准星附近并随 draw 加深、略放大（Java 第一人称拉弓观感）；位姿在最后合成，压过前面的偏移
    const dw = drawBlend.current;
    if (dw > 0.001) {
      px += (0.12 - px) * dw;
      py += (-0.33 - py) * dw;
      pz += (-0.72 - pz) * dw;
      rx += 0.12 * dw; // 上端略抬平，对准准星
    }

    hand.position.set(px, py, pz);
    hand.rotation.set(rx, ry, 0);
    hand.scale.setScalar(1 + 0.18 * dw); // 拉弓略放大；未拉时恒 1（每帧写，零分配）
  });

  return (
    <group ref={camGroupRef}>
      <group ref={handRef}>
        <group ref={itemGroupRef} />
      </group>
    </group>
  );
}
