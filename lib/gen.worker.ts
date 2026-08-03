// 地形生成 Worker：后台线程按种子重建确定性管线，输出 chunk 方块数据（transferable，不复制）
// 入口仅被 lib/genPool.ts 以 new Worker(new URL(...)) 方式加载

import { generateChunkData, type ChestLoot, type DimKind } from './genCore';
import { CHUNK_VOLUME } from './grid';

export interface GenRequest {
  key: string;
  seed: string;
  kind: DimKind;
  cx: number;
  cz: number;
}

export interface GenResponse {
  key: string;
  cx: number;
  cz: number;
  data: Uint16Array;
  /** 生成期登记的结构战利品（fillChest 副作用的回传镜像，主线程落地时并回 storages） */
  chests: ChestLoot[];
}

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<GenRequest>) => void) | null;
  postMessage(message: GenResponse, transfer: Transferable[]): void;
};

ctx.onmessage = (e) => {
  const { key, seed, kind, cx, cz } = e.data;
  const data = new Uint16Array(CHUNK_VOLUME);
  const chests = generateChunkData(seed, kind, cx, cz, data);
  const response: GenResponse = { key, cx, cz, data, chests };
  ctx.postMessage(response, [data.buffer]);
};
