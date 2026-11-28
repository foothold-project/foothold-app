import type { Plugin } from 'vite';

/** 준비된 시뮬 폴더(prepare_sim.py 결과의 sim). FH_SIM_DIR 이 상대 경로면 apps/web 기준, 없으면 apps/web/dist/sim */
export function simDir(env: Record<string, string | undefined>): string;
/** 개발 서버(serve)에만. /sim/ 을 그 폴더에서 주고, 폴더가 없으면 만드는 법 안내(404) */
export function localSim(dir: string): Plugin;
/** 시안 자산 폴더(FH_ASSET_DIR). 상대 경로면 apps/web 기준, 없으면 null */
export function assetDir(env: Record<string, string | undefined>): string | null;
/** 개발 서버(serve)에만. /proto-assets/ 를 그 폴더 안 실제 파일로만 준다 */
export function localAssets(dir: string | null): Plugin;
