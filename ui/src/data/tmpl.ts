// 임무 양식(서버 문서 kind 'tmpl') — web/live.js 1111–1121 과 같은 규칙.
// 지금 앱으로 실제 할 수 있는 모듈만 저장·진행: 사진·운영자 확인·대기. 가스·AI·음성은 원본 자리에 «미연결»로 둔다.
import type { Tmpl, TmplMod } from '@contracts';
import { docsOf, type Docs } from './shared';
import { WHY } from './facts';

export type ModType = TmplMod['type'];
export const LIVE_MODS: ModType[] = ['사진', '운영자 확인', '대기'];
export const MOD_DEF: Record<string, string> = { '사진': '전방 1장', '운영자 확인': '현장 확인 뒤 확인·보류·제외 기록', '대기': '30초 멈춤(운영자가 지킴 · 자동 타이머 아님)' };
export const MOD_OFF: Record<string, string> = { 'AI 탐지': `AI 탐지 — ${WHY['AI 탐지·발견물 판독']}`, '가스 측정': `가스 측정 — ${WHY['가스·측정값·통신 품질']}`, '음성 방송': '음성 방송 — 미연결: 현재 v2 연결에 스피커 출력 없음' };
export const RULE_WHY = '경보 규칙 자동 실행 미연결 — 측정값·AI 탐지가 현재 v2 연결에 없어 규칙을 저장·실행하지 않습니다';
export const GOTO_WHY = `이 지점으로 이동 — ${WHY['자동 목적지 이동·자동 복귀']} · 직접 조종하세요`;

export type T = Tmpl & { id: string; kind: '기본' | '팀'; locked: boolean; by?: string; at?: string; rev?: number };
export const BASE_T: T = { id: 'base', kind: '기본', locked: true, name: '지점 확인 다녀오기', desc: '지점에 가서 직접 조종·영상으로 확인하고 기록합니다',
  mods: [{ type: '사진', detail: MOD_DEF['사진'] }, { type: '운영자 확인', detail: MOD_DEF['운영자 확인'] }] };
export const tmpls = (D: Docs): T[] => [BASE_T, ...docsOf(D, 'tmpl').map((d) => ({ id: d.id, kind: '팀' as const, locked: false, by: d.by, at: d.at, rev: d.rev, ...d.doc }))];
export const tmplOf = (D: Docs, id: string | null) => tmpls(D).find((t) => t.id === id) || BASE_T;
export const defMods = (D: Docs, tid: string | null) => [...new Set(tmplOf(D, tid).mods.map((m) => m.type))].filter((t) => LIVE_MODS.includes(t)).slice(0, 3);
export const modDetail = (D: Docs, tid: string | null, ty: string) => (tmplOf(D, tid).mods.find((m) => m.type === ty) || { detail: MOD_DEF[ty] }).detail;
/** 서버에 보낼 꼴만(id·잠금 같은 화면 값 빼고) */
export const plain = (t: Tmpl): Tmpl => ({ name: t.name, desc: t.desc || '', mods: t.mods.map((m) => ({ type: m.type, detail: m.detail })) });
