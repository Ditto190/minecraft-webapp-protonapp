// 浏览器端把贴图拼成 atlas（CanvasTexture + NearestFilter 保持像素风）
// 默认贴图为内置的 public/textures/pack/（Faithful 32x，许可见 pack/LICENSE.txt）；
// 设置里导入的自定义包（lib/texturepack.ts，localStorage）可整格覆盖对应 tile，分辨率随包

// three 仅作类型静态引入：主菜单（MainMenu→getAtlasMaterials 预热 atlas）也会加载本模块，
// 运行时 three 改在 build() 内动态 import，避免 three 全家进入主菜单首屏 chunk（见 page.tsx 代码分割）
import type * as THREE from 'three';
import {
  ATLAS_CELL_RATIO,
  ATLAS_COLS,
  ATLAS_PAD_RATIO,
  ATLAS_ROWS,
  ICON_TILE_COUNT,
  ICON_TILE_START,
  TILE_STEMS,
  TILE_PX as DEFAULT_TILE_PX,
  tileOf,
} from './blocks';
import { mulberry32 } from './noise';
import { loadCustomPack } from './texturepack';
import { withBase } from './basepath';

/** 当前 atlas 的单格分辨率（默认 32，随导入的自定义贴图包变化） */
export let tilePx = DEFAULT_TILE_PX;

const LEATHER = '#a06830';
const LEATHER_DARK = '#6b4420';

// ——— 灰度贴图染色（MC 生物群系着色的简化：固定平原绿） ———
// Faithful/原版中草顶、树叶、草类是灰度图，游戏里靠群系着色；这里在拼 atlas 时统一染绿
const GRASS_TINT = '#91bd59'; // MC 平原草色
const FOLIAGE_TINT = '#77ab2f'; // MC 平原树叶色
const SPRUCE_TINT = '#619961'; // MC 云杉叶色（偏灰绿）
const TILE_TINTS: Record<string, string> = {
  grass_block_top: GRASS_TINT,
  short_grass: GRASS_TINT,
  fern: GRASS_TINT,
  oak_leaves: FOLIAGE_TINT,
  birch_leaves: '#80a755', // MC 白桦叶固定色（不随群系变）
  jungle_leaves: FOLIAGE_TINT,
  acacia_leaves: FOLIAGE_TINT,
  dark_oak_leaves: FOLIAGE_TINT,
  mangrove_leaves: FOLIAGE_TINT,
  spruce_leaves: SPRUCE_TINT,
  lily_pad: FOLIAGE_TINT,
};

/** 填充 16×16 底色 + 确定性噪点 */
function speckle(ctx: CanvasRenderingContext2D, dx: number, dy: number, base: string, dark: string, seed: number): void {
  ctx.fillStyle = base;
  ctx.fillRect(dx, dy, 16, 16);
  const rand = mulberry32(seed);
  ctx.fillStyle = dark;
  for (let i = 0; i < 24; i++) {
    ctx.fillRect(dx + Math.floor(rand() * 16), dy + Math.floor(rand() * 16), 2, 1);
  }
}

/** 肉块图标：主体色块 + 深色噪点 + 白色骨头尖 */
function drawMeat(ctx: CanvasRenderingContext2D, dx: number, dy: number, base: string, dark: string, seed: number): void {
  ctx.fillStyle = base;
  ctx.fillRect(dx + 3, dy + 5, 9, 8);
  ctx.fillRect(dx + 4, dy + 4, 7, 10);
  const rand = mulberry32(seed);
  ctx.fillStyle = dark;
  for (let i = 0; i < 8; i++) {
    ctx.fillRect(dx + 3 + Math.floor(rand() * 8), dy + 5 + Math.floor(rand() * 7), 2, 1);
  }
  ctx.fillStyle = '#e8e8e8';
  ctx.fillRect(dx + 11, dy + 2, 3, 3);
  ctx.fillRect(dx + 12, dy + 4, 2, 2);
}

/** 部分 tile 在贴图基础上用 canvas 叠加绘制（工作台/熔炉/皮革/装备/食物图标，格号见 ICON_TILE_START） */
const TEXTURE_OVERLAYS: Record<number, (ctx: CanvasRenderingContext2D, dx: number, dy: number) => void> = {
  // 工作台顶：深色边框 + 2×2 网格
  [ICON_TILE_START + 0]: (ctx, dx, dy) => {
    ctx.fillStyle = '#5a4326';
    ctx.fillRect(dx, dy, 16, 2);
    ctx.fillRect(dx, dy + 14, 16, 2);
    ctx.fillRect(dx, dy, 2, 16);
    ctx.fillRect(dx + 14, dy, 2, 16);
    ctx.fillRect(dx + 7, dy + 2, 2, 12);
    ctx.fillRect(dx + 2, dy + 7, 12, 2);
  },
  // 工作台侧：深色边框 + 中央凹槽
[ICON_TILE_START + 1]: (ctx, dx, dy) => {
    ctx.fillStyle = '#5a4326';
    ctx.fillRect(dx, dy, 16, 2);
    ctx.fillRect(dx, dy + 14, 16, 2);
    ctx.fillRect(dx, dy, 2, 16);
    ctx.fillRect(dx + 14, dy, 2, 16);
    ctx.fillRect(dx + 4, dy + 4, 8, 8);
    ctx.fillStyle = '#7a5c33';
    ctx.fillRect(dx + 5, dy + 5, 6, 6);
  },
  // 熔炉：深色边框 + 黑色炉口 + 底部亮条
[ICON_TILE_START + 2]: (ctx, dx, dy) => {
    ctx.fillStyle = '#3a3a3a';
    ctx.fillRect(dx, dy, 16, 2);
    ctx.fillRect(dx, dy + 14, 16, 2);
    ctx.fillRect(dx, dy, 2, 16);
    ctx.fillRect(dx + 14, dy, 2, 16);
    ctx.fillStyle = '#141414';
    ctx.fillRect(dx + 4, dy + 5, 8, 6);
    ctx.fillStyle = '#7a7a7a';
    ctx.fillRect(dx + 4, dy + 12, 8, 2);
  },
  // 皮革
[ICON_TILE_START + 3]: (ctx, dx, dy) => speckle(ctx, dx, dy, LEATHER, LEATHER_DARK, 16),
  // 皮革头盔：顶部帽檐 + 两侧护耳
[ICON_TILE_START + 4]: (ctx, dx, dy) => {
    ctx.fillStyle = LEATHER;
    ctx.fillRect(dx + 3, dy + 3, 10, 5);
    ctx.fillRect(dx + 3, dy + 8, 2, 5);
    ctx.fillRect(dx + 11, dy + 8, 2, 5);
    ctx.fillStyle = LEATHER_DARK;
    ctx.fillRect(dx + 3, dy + 7, 10, 1);
  },
  // 皮革胸甲：躯干 + 短袖
[ICON_TILE_START + 5]: (ctx, dx, dy) => {
    ctx.fillStyle = LEATHER;
    ctx.fillRect(dx + 4, dy + 3, 8, 10);
    ctx.fillRect(dx + 2, dy + 3, 2, 5);
    ctx.fillRect(dx + 12, dy + 3, 2, 5);
    ctx.fillStyle = LEATHER_DARK;
    ctx.fillRect(dx + 4, dy + 6, 8, 1);
  },
  // 皮革护腿：两条腿 + 腰带
[ICON_TILE_START + 6]: (ctx, dx, dy) => {
    ctx.fillStyle = LEATHER;
    ctx.fillRect(dx + 4, dy + 2, 8, 3);
    ctx.fillRect(dx + 4, dy + 5, 3, 9);
    ctx.fillRect(dx + 9, dy + 5, 3, 9);
    ctx.fillStyle = LEATHER_DARK;
    ctx.fillRect(dx + 4, dy + 4, 8, 1);
  },
  // 皮革靴子：两只靴子
[ICON_TILE_START + 7]: (ctx, dx, dy) => {
    ctx.fillStyle = LEATHER;
    ctx.fillRect(dx + 3, dy + 7, 5, 7);
    ctx.fillRect(dx + 8, dy + 7, 5, 7);
    ctx.fillStyle = LEATHER_DARK;
    ctx.fillRect(dx + 3, dy + 12, 5, 2);
    ctx.fillRect(dx + 8, dy + 12, 5, 2);
  },
  // 木棍：两条斜棍
[ICON_TILE_START + 8]: (ctx, dx, dy) => {
    ctx.strokeStyle = LEATHER_DARK;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(dx + 4, dy + 13);
    ctx.lineTo(dx + 12, dy + 3);
    ctx.stroke();
    ctx.strokeStyle = '#9a7a4a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(dx + 5, dy + 13);
    ctx.lineTo(dx + 13, dy + 3);
    ctx.stroke();
  },
  // 木炭：黑色块 + 灰点
[ICON_TILE_START + 9]: (ctx, dx, dy) => speckle(ctx, dx, dy, '#1a1a1a', '#5a5a5a', 22),
  // 生/熟 猪排、牛肉、鸡肉
[ICON_TILE_START + 10]: (ctx, dx, dy) => drawMeat(ctx, dx, dy, '#e88a94', '#c05a64', 23),
[ICON_TILE_START + 11]: (ctx, dx, dy) => drawMeat(ctx, dx, dy, '#8a5a2b', '#6b4420', 24),
[ICON_TILE_START + 12]: (ctx, dx, dy) => drawMeat(ctx, dx, dy, '#c04848', '#903030', 25),
[ICON_TILE_START + 13]: (ctx, dx, dy) => drawMeat(ctx, dx, dy, '#7a4a22', '#5a3416', 26),
[ICON_TILE_START + 14]: (ctx, dx, dy) => drawMeat(ctx, dx, dy, '#e8d0b0', '#c0a880', 27),
[ICON_TILE_START + 15]: (ctx, dx, dy) => drawMeat(ctx, dx, dy, '#c09040', '#987028', 28),
  // 箱子侧：深色包边 + 盖缝 + 锁扣（底座为木板）
  [ICON_TILE_START + 16]: (ctx, dx, dy) => {
    ctx.fillStyle = '#4a3418';
    ctx.fillRect(dx, dy, 16, 2);
    ctx.fillRect(dx, dy + 14, 16, 2);
    ctx.fillRect(dx, dy, 2, 16);
    ctx.fillRect(dx + 14, dy, 2, 16);
    ctx.fillRect(dx + 2, dy + 5, 12, 1); // 盖缝
    ctx.fillStyle = '#26241f';
    ctx.fillRect(dx + 7, dy + 4, 2, 4); // 锁扣
    ctx.fillStyle = '#b8b8b8';
    ctx.fillRect(dx + 7, dy + 5, 2, 1);
  },
  // 凋灵骷髅头：黑底三脸（每脸双目，MC 凋灵骷髅标志）
  [ICON_TILE_START + 17]: (ctx, dx, dy) => {
    ctx.fillStyle = '#161616';
    ctx.fillRect(dx, dy, 16, 16);
    ctx.fillStyle = '#3a3a3a';
    for (const fx of [2, 6, 10]) {
      ctx.fillRect(dx + fx, dy + 5, 2, 2); // 左眼
      ctx.fillRect(dx + fx + 2, dy + 5, 2, 2); // 右眼
      ctx.fillRect(dx + fx + 1, dy + 8, 2, 3); // 鼻
      ctx.fillRect(dx + fx, dy + 12, 4, 1); // 颌
    }
  },
  // 末地传送门：黑底星空（MC 为程序生成纹理，此处固定星点图案）
  [ICON_TILE_START + 18]: (ctx, dx, dy) => {
    ctx.fillStyle = '#05060f';
    ctx.fillRect(dx, dy, 16, 16);
    const stars: [number, number, string][] = [
      [2, 3, '#c8d4ff'], [7, 1, '#ffffff'], [12, 4, '#8fa2e8'], [4, 8, '#ffffff'],
      [10, 10, '#c8d4ff'], [14, 13, '#8fa2e8'], [1, 12, '#c8d4ff'], [8, 14, '#ffffff'], [13, 8, '#e8ecff'],
    ];
    for (const [sx, sy, c] of stars) {
      ctx.fillStyle = c;
      ctx.fillRect(dx + sx, dy + sy, 1, 1);
    }
  },
  // 鸡蛋：白色椭圆蛋 + 左上高光（materials.ts egg 图标）
  [ICON_TILE_START + 19]: (ctx, dx, dy) => {
    ctx.fillStyle = '#e8e4d8';
    ctx.fillRect(dx + 6, dy + 3, 4, 1);
    ctx.fillRect(dx + 5, dy + 4, 6, 2);
    ctx.fillRect(dx + 4, dy + 6, 8, 5);
    ctx.fillRect(dx + 5, dy + 11, 6, 1);
    ctx.fillRect(dx + 6, dy + 12, 4, 1);
    ctx.fillStyle = '#c8c4b4'; // 右下阴影
    ctx.fillRect(dx + 10, dy + 6, 2, 5);
    ctx.fillRect(dx + 8, dy + 11, 3, 1);
    ctx.fillRect(dx + 8, dy + 12, 2, 1);
    ctx.fillStyle = '#ffffff'; // 高光
    ctx.fillRect(dx + 6, dy + 4, 2, 2);
  },
  // 河豚：黄绿色带刺圆鱼（materials.ts pufferfish 图标）
  [ICON_TILE_START + 20]: (ctx, dx, dy) => {
    ctx.fillStyle = '#b8b040'; // 圆身
    ctx.fillRect(dx + 5, dy + 3, 6, 1);
    ctx.fillRect(dx + 4, dy + 4, 8, 2);
    ctx.fillRect(dx + 3, dy + 6, 10, 4);
    ctx.fillRect(dx + 4, dy + 10, 8, 2);
    ctx.fillRect(dx + 5, dy + 12, 6, 1);
    ctx.fillStyle = '#d8d870'; // 腹部亮色
    ctx.fillRect(dx + 4, dy + 9, 8, 1);
    ctx.fillRect(dx + 5, dy + 10, 6, 1);
    ctx.fillStyle = '#e8e8c8'; // 周身尖刺
    ctx.fillRect(dx + 6, dy + 2, 1, 1);
    ctx.fillRect(dx + 9, dy + 2, 1, 1);
    ctx.fillRect(dx + 2, dy + 7, 1, 1);
    ctx.fillRect(dx + 13, dy + 7, 1, 1);
    ctx.fillRect(dx + 3, dy + 4, 1, 1);
    ctx.fillRect(dx + 12, dy + 4, 1, 1);
    ctx.fillRect(dx + 6, dy + 13, 1, 1);
    ctx.fillRect(dx + 9, dy + 13, 1, 1);
    ctx.fillStyle = '#26221a'; // 眼
    ctx.fillRect(dx + 5, dy + 6, 2, 2);
    ctx.fillStyle = '#8a7828'; // 尾鳍
    ctx.fillRect(dx + 12, dy + 6, 2, 1);
    ctx.fillRect(dx + 13, dy + 5, 1, 1);
    ctx.fillRect(dx + 13, dy + 9, 1, 1);
    ctx.fillRect(dx + 12, dy + 9, 2, 1);
  },
  // 蜘蛛眼：暗红眼 + 黑色瞳仁（materials.ts spider_eye 图标）
  [ICON_TILE_START + 21]: (ctx, dx, dy) => {
    ctx.fillStyle = '#8a1e1e';
    ctx.fillRect(dx + 4, dy + 5, 8, 1);
    ctx.fillRect(dx + 3, dy + 6, 10, 4);
    ctx.fillRect(dx + 4, dy + 10, 8, 1);
    ctx.fillStyle = '#5a1010'; // 边缘深色
    ctx.fillRect(dx + 3, dy + 6, 1, 4);
    ctx.fillRect(dx + 12, dy + 6, 1, 4);
    ctx.fillRect(dx + 4, dy + 10, 8, 1);
    ctx.fillStyle = '#1a0a0a'; // 瞳仁
    ctx.fillRect(dx + 7, dy + 6, 3, 4);
    ctx.fillStyle = '#c84838'; // 高光
    ctx.fillRect(dx + 5, dy + 6, 2, 1);
  },
  // 金粒：不规则小金块 + 高光（materials.ts gold_nugget 图标）
  [ICON_TILE_START + 22]: (ctx, dx, dy) => {
    ctx.fillStyle = '#e8c83a';
    ctx.fillRect(dx + 5, dy + 7, 6, 4);
    ctx.fillRect(dx + 6, dy + 6, 4, 1);
    ctx.fillRect(dx + 7, dy + 11, 3, 1);
    ctx.fillStyle = '#b0901f'; // 右下阴影
    ctx.fillRect(dx + 10, dy + 7, 1, 4);
    ctx.fillRect(dx + 7, dy + 11, 3, 1);
    ctx.fillStyle = '#f8e878'; // 高光
    ctx.fillRect(dx + 6, dy + 7, 2, 1);
  },
  // 金苹果：金黄苹果 + 棕色果柄 + 高光（materials.ts golden_apple 图标）
  [ICON_TILE_START + 23]: (ctx, dx, dy) => {
    ctx.fillStyle = '#7a5a2a'; // 果柄
    ctx.fillRect(dx + 8, dy + 2, 1, 3);
    ctx.fillStyle = '#e8c83a';
    ctx.fillRect(dx + 5, dy + 5, 7, 1);
    ctx.fillRect(dx + 4, dy + 6, 9, 5);
    ctx.fillRect(dx + 5, dy + 11, 7, 1);
    ctx.fillRect(dx + 6, dy + 12, 5, 1);
    ctx.fillStyle = '#b0901f'; // 右下阴影
    ctx.fillRect(dx + 11, dy + 6, 2, 5);
    ctx.fillRect(dx + 9, dy + 12, 2, 1);
    ctx.fillStyle = '#f8e878'; // 高光
    ctx.fillRect(dx + 5, dy + 6, 2, 2);
  },
  // 藏宝图：羊皮纸 + 折痕地形线 + 红色 X 标记（materials.ts treasure_map 图标）
  [ICON_TILE_START + 24]: (ctx, dx, dy) => {
    ctx.fillStyle = '#d8c493'; // 纸面
    ctx.fillRect(dx + 3, dy + 4, 10, 9);
    ctx.fillStyle = '#b09c6b'; // 上下卷边
    ctx.fillRect(dx + 3, dy + 4, 10, 1);
    ctx.fillRect(dx + 3, dy + 12, 10, 1);
    ctx.fillStyle = '#c4ad7c'; // 竖折痕
    ctx.fillRect(dx + 6, dy + 5, 1, 7);
    ctx.fillStyle = '#9a8858'; // 地形等高线
    ctx.fillRect(dx + 4, dy + 6, 2, 1);
    ctx.fillRect(dx + 7, dy + 8, 3, 1);
    ctx.fillRect(dx + 4, dy + 10, 3, 1);
    ctx.fillStyle = '#c02818'; // 红 X（宝藏标记）
    ctx.fillRect(dx + 9, dy + 9, 3, 1);
    ctx.fillRect(dx + 10, dy + 8, 1, 3);
    ctx.fillRect(dx + 9, dy + 8, 1, 1);
    ctx.fillRect(dx + 11, dy + 8, 1, 1);
  },
};

/** atlas 画布的 dataURL（HUD 图标裁剪用），build 完成后可用。
 * 图标渲染经 CSS 变量 `--mc-atlas` 共享这一份字符串（见 build 末尾），避免每个 TileIcon 的
 * inline style 各存一份超长 base64（BlockPicker 一次渲染 ~291 个图标，DOM 内存放大数百倍） */
export let atlasDataUrl = '';

/** atlas 画布本体（lib/blockIcon3d.ts 等轴 3D 图标从画布裁面，免解码 dataURL；build 完成后可用） */
export let atlasCanvas: HTMLCanvasElement | null = null;
/** atlas 构建版本号：每次 build（含贴图包重载）+1，3D 图标缓存据此失效重建 */
export let atlasVersion = 0;

/** 渲染器类型（由 renderer-kind.tsx 的 Context 下发） */
export type RendererKind = 'webgl' | 'webgpu';

export interface MaterialOptions {
  color?: string;
  map?: THREE.Texture | null;
  transparent?: boolean;
  opacity?: number;
  alphaTest?: number;
  vertexColors?: boolean;
  depthWrite?: boolean;
  fog?: boolean;
  side?: THREE.Side;
}

export interface AtlasMaterials {
  kind: RendererKind;
  texture: THREE.Texture;
  /** 水面动画纹理（32 帧竖排条带，帧 0 在底部；offset 驱动） */
  waterTex: THREE.Texture;
  /**
   * chunk 不透明材质（alphaTest 镂空 + 顶点色 AO）。
   * 块单位 UV + 逐顶点 aTile 新约定（注入 tileBase + fract 拼装），仅可用于 buildFromGrid 输出的
   * chunk 几何；单方块几何（buildBlockGeometry/buildTileGeometry，atlas 终值 UV 旧约定）须走 lambert() 工厂材质
   */
  solid: THREE.Material;
  /** chunk 半透明水（同 solid 的块单位 UV 约定，仅用于 chunk 水几何） */
  water: THREE.Material;
  /** Lambert 纯色材质（生物模型、掉落物/手持物等单方块 atlas 材质——旧 UV 约定） */
  lambert: (opts?: MaterialOptions) => THREE.Material;
  /** Basic 材质（裂纹/云/粒子） */
  basic: (opts?: MaterialOptions) => THREE.Material;
  /** Sprite 材质（太阳/月亮） */
  sprite: (opts?: MaterialOptions) => THREE.Material;
  /** Line 材质（选框高亮） */
  line: (opts?: MaterialOptions) => THREE.Material;
}

// ——— chunk 网格专用 UV 注入（贪心合并配套；mesher 块单位 UV + 逐顶点 aTile 约定）———
// shader 内 finalUV = tileBase + fract(blockUV) × 格内容，跨格重复采样不串到相邻 tile。
// fract 的不连续会让隐式导数在拼缝处误判到最低 mip（远处出现网格缝），故用连续块单位 UV
// 的显式梯度采样（WebGL textureGrad / WebGPU TSL .grad）。水走独立 strip 纹理：fract 后缩到单帧
const WATER_FRAMES = 32;
const glslFloat = (n: number): string => (Number.isInteger(n) ? `${n}.0` : String(n));
const ATLAS_UW = ATLAS_COLS * ATLAS_CELL_RATIO;
const ATLAS_VW = ATLAS_ROWS * ATLAS_CELL_RATIO;

/**
 * WebGL Lambert 注入（onBeforeCompile）：顶点 UV 原样透传（块单位），fragment 拼装最终 UV。
 * solid：atlas 格基址 + fract；water：strip 单帧 + mapTransform（offset 帧动画）。
 * customProgramCacheKey 必须区分——否则与同类的未注入 Lambert 共享编译程序
 */
function injectChunkUVWebGL(mat: THREE.Material, water: boolean): void {
  mat.onBeforeCompile = (shader) => {
    if (water) {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <uv_vertex>',
        '#include <uv_vertex>\n#ifdef USE_MAP\n\tvMapUv = MAP_UV;\n#endif',
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        `#ifdef USE_MAP
	vec2 mcUv = vec2( fract( vMapUv.x ), fract( vMapUv.y ) / ${glslFloat(WATER_FRAMES)} );
	vec4 sampledDiffuseColor = textureGrad( map, ( mapTransform * vec3( mcUv, 1.0 ) ).xy, dFdx( vMapUv ) * vec2( 1.0, ${glslFloat(1 / WATER_FRAMES)} ), dFdy( vMapUv ) * vec2( 1.0, ${glslFloat(1 / WATER_FRAMES)} ) );
	diffuseColor *= sampledDiffuseColor;
#endif`,
      );
    } else {
      shader.vertexShader = shader.vertexShader
        .replace('#include <uv_pars_vertex>', '#include <uv_pars_vertex>\nattribute float aTile;\nvarying float vMcTile;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\n\tvMapUv = MAP_UV;\n\tvMcTile = aTile;\n#endif');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <uv_pars_fragment>', '#include <uv_pars_fragment>\nvarying float vMcTile;')
        .replace(
          '#include <map_fragment>',
          `#ifdef USE_MAP
	vec2 mcF = fract( vMapUv );
	float mcCol = mod( vMcTile, ${glslFloat(ATLAS_COLS)} );
	float mcRow = floor( vMcTile / ${glslFloat(ATLAS_COLS)} );
	vec2 mcUv = vec2(
		( mcCol * ${glslFloat(ATLAS_CELL_RATIO)} + ${glslFloat(ATLAS_PAD_RATIO)} + mcF.x ) / ${glslFloat(ATLAS_UW)},
		1.0 - ( mcRow * ${glslFloat(ATLAS_CELL_RATIO)} + ${glslFloat(ATLAS_PAD_RATIO)} + ( 1.0 - mcF.y ) ) / ${glslFloat(ATLAS_VW)} );
	vec4 sampledDiffuseColor = textureGrad( map, mcUv, dFdx( vMapUv ) * vec2( ${glslFloat(1 / ATLAS_UW)}, ${glslFloat(1 / ATLAS_VW)} ), dFdy( vMapUv ) * vec2( ${glslFloat(1 / ATLAS_UW)}, ${glslFloat(1 / ATLAS_VW)} ) );
	diffuseColor *= sampledDiffuseColor;
#endif`,
        );
    }
  };
  mat.customProgramCacheKey = () => (water ? 'mc-chunk-water' : 'mc-chunk-solid');
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // 超时兜底：网络挂起时 onload/onerror 都可能长时间不触发，15s 后按失败处理（走 loadError 界面而非无限转圈）
    const timer = setTimeout(() => {
      img.src = '';
      reject(new Error(`加载贴图超时（15s）: ${src}`));
    }, 15000);
    img.onload = () => {
      clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`加载贴图失败: ${src}`));
    };
    img.src = src;
  });
}

const cache = new Map<RendererKind, Promise<AtlasMaterials>>();

/** 当前生效的水面条带纹理（AtlasMaterials 构建后可用） */
let waterStrip: THREE.Texture | null = null;

/** 水面动画：每 ~62ms 前进一帧（32 帧循环；DayNight 每帧调用） */
export function tickWaterTexture(ms: number): void {
  if (waterStrip) waterStrip.offset.y = Math.floor(ms / 62 % 32) / 32;
}

export function getAtlasMaterials(kind: RendererKind = 'webgl'): Promise<AtlasMaterials> {
  let p = cache.get(kind);
  if (!p) {
    p = build(kind);
    cache.set(kind, p);
    // 失败不缓存：拒绝的 promise 留在 cache 会让「重试」永远命中同一失败（贴图加载失败的恢复路径）
    p.catch(() => {
      if (cache.get(kind) === p) cache.delete(kind);
    });
  }
  return p;
}

async function build(kind: RendererKind): Promise<AtlasMaterials> {
  // 运行时 three 动态加载（模块顶部仅类型引入）：首次构建 atlas 时才下载/解析 three
  const THREE = await import('three');
  const pack = loadCustomPack();
  // 先定分辨率（自定义包 > 默认 32），再建画布（格距含挤出）
  const custom: Partial<Record<string, HTMLImageElement>> = {};
  if (pack) {
    tilePx = pack.tilePx;
    await Promise.all(
      Object.entries(pack.tiles).map(async ([stem, url]) => {
        custom[stem] = await loadImage(url);
      }),
    );
  } else {
    tilePx = DEFAULT_TILE_PX;
  }
  // 整格覆盖贴图（按 stem 匹配）：设置里导入的包（localStorage）> 内置默认 pack/（Faithful 32x）

  // 预载全部贴图：默认从单文件 atlas 裁格（一次请求）；导入包按 stem 整格覆盖
  const atlas = await loadImage(withBase('/textures/atlas.png'));
  // stem → 文件 atlas 格号（build-pack 构建顺序清单）。运行时注册顺序取决于模块图（armor 先于 materials 等），
  // 与构建顺序可能不同——无清单时按序号对齐会让全部物品图标错位（见 atlas.json 注释）
  let fileStems: string[] = [];
  try {
    fileStems = (await (await fetch(withBase('/textures/atlas.json'))).json()) as string[];
  } catch {
    fileStems = [];
  }
  const fileIdxOf = new Map<string, number>(fileStems.map((s, idx) => [s, idx]));
  // atlas 格距 = 内容 + 两侧挤出（mipmap 防跨格混色；挤出比例 1/8）
  const padPx = Math.max(1, Math.round(tilePx * ATLAS_PAD_RATIO));
  const cellPx = tilePx + padPx * 2;
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_COLS * cellPx;
  canvas.height = ATLAS_ROWS * cellPx;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 canvas 2d 上下文');
  const drawTile = (i: number, dx: number, dy: number) => {
    const stem = TILE_STEMS[i];
    const img = custom[stem];
    let sx = 0;
    let sy = 0;
    // 内容画在格中心（dx+pad, dy+pad）
    if (img) {
      ctx.drawImage(img, dx + padPx, dy + padPx, tilePx, tilePx);
    } else {
      // 按 stem 名从清单查文件格号；清单缺失（旧部署/未重建）退回按运行时序号（旧行为）
      const bi = fileIdxOf.get(stem) ?? i;
      sx = (bi % ATLAS_COLS) * DEFAULT_TILE_PX;
      sy = Math.floor(bi / ATLAS_COLS) * DEFAULT_TILE_PX;
      ctx.drawImage(atlas, sx, sy, DEFAULT_TILE_PX, DEFAULT_TILE_PX, dx + padPx, dy + padPx, tilePx, tilePx);
    }
    // 灰度贴图染绿：multiply 上色后按原图 alpha 裁回（树叶镂空不被填色）。
    // 必须 clip 到本格——destination-in 会把源图透明区外的整个画布清掉
    const tint = TILE_TINTS[stem];
    if (tint) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(dx + padPx, dy + padPx, tilePx, tilePx);
      ctx.clip();
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = tint;
      ctx.fillRect(dx + padPx, dy + padPx, tilePx, tilePx);
      ctx.globalCompositeOperation = 'destination-in';
      if (img) ctx.drawImage(img, dx + padPx, dy + padPx, tilePx, tilePx);
      else ctx.drawImage(atlas, sx, sy, DEFAULT_TILE_PX, DEFAULT_TILE_PX, dx + padPx, dy + padPx, tilePx, tilePx);
      ctx.restore();
    }
    // 挤出：四边 1px 拉伸到 pad 宽 + 四角复制（同画布复制，防 mipmap 跨格混色）
    const P = padPx;
    const T = tilePx;
    const cx = dx + P;
    const cy = dy + P;
    ctx.drawImage(canvas, cx, cy, T, 1, cx, dy, T, P); // 上边
    ctx.drawImage(canvas, cx, cy + T - 1, T, 1, cx, cy + T, T, P); // 下边
    ctx.drawImage(canvas, cx, cy, 1, T, dx, cy, P, T); // 左边
    ctx.drawImage(canvas, cx + T - 1, cy, 1, T, cx + T, cy, P, T); // 右边
    ctx.drawImage(canvas, cx, cy, 1, 1, dx, dy, P, P); // 四角
    ctx.drawImage(canvas, cx + T - 1, cy, 1, 1, cx + T, dy, P, P);
    ctx.drawImage(canvas, cx, cy + T - 1, 1, 1, dx, cy + T, P, P);
    ctx.drawImage(canvas, cx + T - 1, cy + T - 1, 1, 1, cx + T, cy + T, P, P);
  };
  for (let i = 0; i < TILE_STEMS.length; i++) {
    drawTile(i, (i % ATLAS_COLS) * cellPx, Math.floor(i / ATLAS_COLS) * cellPx);
  }

  // 图标格（ICON_TILE_START..+24）：工作台/熔炉先铺木板/圆石底座，再叠加绘制
  ctx.imageSmoothingEnabled = false;
  for (let k = 0; k < ICON_TILE_COUNT; k++) {
    const cell = ICON_TILE_START + k;
    const dx = (cell % ATLAS_COLS) * cellPx;
    const dy = Math.floor(cell / ATLAS_COLS) * cellPx;
    const baseStem = k <= 1 || k === 16 ? 'oak_planks' : k === 2 ? 'cobblestone' : null;
    if (baseStem) drawTile(tileOf(baseStem), dx, dy);
    else {
      // 无底座图标也要挤出（先画内容再补边）
    }
    // 叠加绘制（工作台/熔炉/装备/食物图标）按 16px 坐标系编写，随分辨率缩放
    const overlay = TEXTURE_OVERLAYS[cell];
    if (overlay) {
      ctx.save();
      ctx.translate(dx + padPx, dy + padPx);
      ctx.scale(tilePx / 16, tilePx / 16);
      overlay(ctx, 0, 0);
      ctx.restore();
      // 叠加后对图标格做同样的挤出（无底座时图标即全部内容）
      if (!baseStem) {
        const P = padPx;
        const T = tilePx;
        const cx = dx + P;
        const cy = dy + P;
        ctx.drawImage(canvas, cx, cy, T, 1, cx, dy, T, P);
        ctx.drawImage(canvas, cx, cy + T - 1, T, 1, cx, cy + T, T, P);
        ctx.drawImage(canvas, cx, cy, 1, T, dx, cy, P, T);
        ctx.drawImage(canvas, cx + T - 1, cy, 1, T, cx + T, cy, P, T);
        ctx.drawImage(canvas, cx, cy, 1, 1, dx, dy, P, P);
        ctx.drawImage(canvas, cx + T - 1, cy, 1, 1, cx + T, dy, P, P);
        ctx.drawImage(canvas, cx, cy + T - 1, 1, 1, dx, cy + T, P, P);
        ctx.drawImage(canvas, cx + T - 1, cy + T - 1, 1, 1, cx + T, cy + T, P, P);
      }
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  // minFilter 走 mipmap（Nearest 双线性）：近处保持像素风，远处消除闪烁/摩尔纹
  texture.minFilter = THREE.NearestMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 16; // 高各向异性：斜视地表不糊（配合格间挤出，杜绝跨格混色条纹）
  texture.colorSpace = THREE.SRGBColorSpace;
  atlasDataUrl = canvas.toDataURL();
  atlasCanvas = canvas;
  atlasVersion += 1;
  // 全量 dataURL 只挂一份到 :root 的 CSS 变量，TileIcon 用 background-image: var(--mc-atlas) 共享；
  // 贴图包重建（getAtlasMaterials 重新 build）走到这里时变量随之更新
  document.documentElement.style.setProperty('--mc-atlas', `url("${atlasDataUrl}")`);

  // 水面动画条带：帧倒序重排（帧 0 在底部，对应 mesher 写出的 v∈[0,1/32]）
  const stripImg = await loadImage(withBase('/textures/water_still.png'));
  const frames = Math.floor(stripImg.height / DEFAULT_TILE_PX);
  const stripCanvas = document.createElement('canvas');
  stripCanvas.width = DEFAULT_TILE_PX;
  stripCanvas.height = stripImg.height;
  const sctx = stripCanvas.getContext('2d');
  if (!sctx) throw new Error('无法创建 canvas 2d 上下文');
  for (let f = 0; f < frames; f++) {
    sctx.drawImage(stripImg, 0, f * DEFAULT_TILE_PX, DEFAULT_TILE_PX, DEFAULT_TILE_PX, 0, (frames - 1 - f) * DEFAULT_TILE_PX, DEFAULT_TILE_PX, DEFAULT_TILE_PX);
  }
  waterStrip = new THREE.CanvasTexture(stripCanvas);
  waterStrip.magFilter = THREE.NearestFilter;
  waterStrip.minFilter = THREE.NearestMipmapLinearFilter;
  waterStrip.generateMipmaps = true;
  waterStrip.colorSpace = THREE.SRGBColorSpace;
  waterStrip.wrapS = THREE.RepeatWrapping;
  waterStrip.wrapT = THREE.RepeatWrapping;

  if (kind === 'webgpu') {
    // WebGPU 节点材质（three/webgpu 动态加载，不进默认包）
    const webgpu = await import('three/webgpu');
    const tsl = await import('three/tsl');
    const lambert = (o: MaterialOptions = {}) =>
      new webgpu.MeshLambertNodeMaterial({
        color: o.color ?? '#ffffff',
        map: o.map ?? null,
        transparent: o.transparent ?? false,
        opacity: o.opacity ?? 1,
        alphaTest: o.alphaTest ?? 0,
        vertexColors: o.vertexColors ?? false,
        depthWrite: o.depthWrite ?? true,
        side: o.side ?? THREE.FrontSide,
        fog: o.fog ?? true,
      }) as unknown as THREE.Material;
    const basic = (o: MaterialOptions = {}) =>
      new webgpu.MeshBasicNodeMaterial({
        color: o.color ?? '#ffffff',
        map: o.map ?? null,
        transparent: o.transparent ?? false,
        opacity: o.opacity ?? 1,
        alphaTest: o.alphaTest ?? 0,
        vertexColors: o.vertexColors ?? false,
        depthWrite: o.depthWrite ?? true,
        side: o.side ?? THREE.FrontSide,
        fog: o.fog ?? true,
      }) as unknown as THREE.Material;
    const sprite = (o: MaterialOptions = {}) =>
      new webgpu.SpriteNodeMaterial({
        color: o.color ?? '#ffffff',
        map: o.map ?? null,
        transparent: o.transparent ?? true,
        opacity: o.opacity ?? 1,
        depthWrite: o.depthWrite ?? true,
        fog: o.fog ?? true,
      }) as unknown as THREE.Material;
    const line = (o: MaterialOptions = {}) =>
      new webgpu.LineBasicNodeMaterial({ color: o.color ?? '#ffffff' }) as unknown as THREE.Material;
    // chunk 不透明材质：colorNode 覆盖默认 color×map(uv) 路径，等效 WebGL 注入（块单位 UV + aTile 拼装 + 显式梯度）
    const solid = new webgpu.MeshLambertNodeMaterial({
      color: '#ffffff',
      map: texture,
      transparent: false,
      opacity: 1,
      alphaTest: 0.5,
      vertexColors: true,
      depthWrite: true,
      side: THREE.FrontSide,
      fog: true,
    });
    {
      const aTile = tsl.attribute<'float'>('aTile', 'float');
      const buv = tsl.uv();
      const bf = tsl.fract(buv);
      const colT = tsl.floor(tsl.mod(aTile, ATLAS_COLS));
      const rowT = tsl.floor(tsl.div(aTile, ATLAS_COLS));
      const u = tsl.div(tsl.mul(colT, ATLAS_CELL_RATIO).add(ATLAS_PAD_RATIO).add(bf.x), ATLAS_UW);
      const v = tsl.float(1).sub(tsl.div(tsl.mul(rowT, ATLAS_CELL_RATIO).add(ATLAS_PAD_RATIO).add(tsl.float(1).sub(bf.y)), ATLAS_VW));
      const grad = tsl.vec2(1 / ATLAS_UW, 1 / ATLAS_VW);
      solid.colorNode = tsl.texture(texture, tsl.vec2(u, v)).grad(tsl.mul(tsl.dFdx(buv), grad), tsl.mul(tsl.dFdy(buv), grad));
    }
    // 水：MC 群系水色蓝调（#3f76e4 乘算），不透明度 0.85 对齐 MC 观感；
    // strip 单帧 fract + setUpdateMatrix 保留 offset 帧动画（tickWaterTexture 驱动）
    const water = new webgpu.MeshLambertNodeMaterial({
      color: '#3f76e4',
      map: waterStrip,
      transparent: true,
      opacity: 0.85,
      alphaTest: 0,
      vertexColors: true,
      depthWrite: false,
      side: THREE.FrontSide,
      fog: true,
    });
    {
      const buv = tsl.uv();
      const wuv = tsl.vec2(tsl.fract(buv.x), tsl.div(tsl.fract(buv.y), WATER_FRAMES));
      const grad = tsl.vec2(1, 1 / WATER_FRAMES);
      const tex = tsl.texture(waterStrip!, wuv).grad(tsl.mul(tsl.dFdx(buv), grad), tsl.mul(tsl.dFdy(buv), grad));
      // setUpdateMatrix(true)：自定义 uv 默认关矩阵，这里打开以保留 offset 帧动画（类型定义未暴露该方法，同名字段等效）
      tex.updateMatrix = true;
      water.colorNode = tsl.vec4(tex.rgb.mul(tsl.uniform(water.color)), tex.a);
    }
    return {
      kind,
      texture,
      waterTex: waterStrip!,
      solid: solid as unknown as THREE.Material,
      water: water as unknown as THREE.Material,
      lambert,
      basic,
      sprite,
      line,
    };
  }

  const lambert = (o: MaterialOptions = {}) =>
    new THREE.MeshLambertMaterial({
      color: o.color ?? '#ffffff',
      map: o.map ?? null,
      transparent: o.transparent ?? false,
      opacity: o.opacity ?? 1,
      alphaTest: o.alphaTest ?? 0,
      vertexColors: o.vertexColors ?? false,
      depthWrite: o.depthWrite ?? true,
      side: o.side ?? THREE.FrontSide,
      fog: o.fog ?? true,
    });
  const basic = (o: MaterialOptions = {}) =>
    new THREE.MeshBasicMaterial({
      color: o.color ?? '#ffffff',
      map: o.map ?? null,
      transparent: o.transparent ?? false,
      opacity: o.opacity ?? 1,
      alphaTest: o.alphaTest ?? 0,
      vertexColors: o.vertexColors ?? false,
      depthWrite: o.depthWrite ?? true,
      side: o.side ?? THREE.FrontSide,
      fog: o.fog ?? true,
    });
  const sprite = (o: MaterialOptions = {}) =>
    new THREE.SpriteMaterial({
      color: o.color ?? '#ffffff',
      map: o.map ?? null,
      transparent: o.transparent ?? true,
      opacity: o.opacity ?? 1,
      depthWrite: o.depthWrite ?? true,
      fog: o.fog ?? true,
    });
  const line = (o: MaterialOptions = {}) => new THREE.LineBasicMaterial({ color: o.color ?? '#ffffff' });
  // chunk 材质：块单位 UV 新约定（onBeforeCompile 注入 tileBase + fract 拼装，见上方注释）
  const solid = lambert({ map: texture, alphaTest: 0.5, vertexColors: true });
  injectChunkUVWebGL(solid, false);
  // 水：MC 群系水色蓝调（#3f76e4 乘算），不透明度 0.85 对齐 MC 观感
  const water = lambert({ color: '#3f76e4', map: waterStrip, transparent: true, opacity: 0.85, depthWrite: false, vertexColors: true });
  injectChunkUVWebGL(water, true);
  return {
    kind,
    texture,
    waterTex: waterStrip!,
    solid,
    water,
    lambert,
    basic,
    sprite,
    line,
  };
}
