// bt.js 형(웹 apps/web 임무 편집이 import). 실행기 동작은 bt.js 가 정본 — 여기는 웹이 쓰는 것만
export type BtPoint = { x: number; y: number; yaw?: number };
export type BtNode = {
  type: string; children?: BtNode[]; child?: BtNode; points?: BtPoint[]; point?: BtPoint | 'current';
  message?: string; level?: string; seconds?: number; times?: number; max_seconds?: number; remaining?: boolean; finish?: boolean;
};
export type BtTree = { format: string; max_seconds: number; root: BtNode };
export const TREE_FORMAT: 'fh_mission_tree/1';
export const RESULTS: readonly string[];
export const ACTION_SECONDS: Readonly<Record<string, number>>;
export function validateTree<T extends BtTree>(tree: T): T;
export function treeFromScenario(s: { points: BtPoint[] }): BtTree;
export function treeRows(tree: BtTree): { node: BtNode; path: string; depth: number }[];
