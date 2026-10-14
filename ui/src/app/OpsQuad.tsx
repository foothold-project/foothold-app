// 관제 4분할 내용 + 실행 대상 고르기(실기 Go2 | 시뮬 보조). 대상 전환 = link.setProvider(입력 폐기·hidden·명령 0·세대+1·영상/길 비움).
// 실기(go2_direct): 지금 판엔 연결 없음 → 4칸 모두 빈 상태 + 이유(가짜 값 0). Go2Direct 계약(mobile docs/GO2DIRECT-CONTRACT.md) 문구 그대로.
// 시뮬: 지도(MapCanvas) · RGB(Gazebo 렌더) · 외부 3인칭(Gazebo 렌더, «지도 열기» 외부카메라 체크 때만) · 3D 점군 누적(시각화, SLAM 3D 지도 아님).
import type { ReactNode } from 'react';
import { camURL, setProvider, useLink } from '../data/link';
import { usePull, viewKey, viewWhy } from '../data/views';
import { Cloud3D } from './Cloud3D';
import { QEmpty, Quad, type QSize, type QTile } from './Quad';

const go2Plugin = () => !!(window as any).Capacitor?.isPluginAvailable?.('Go2Direct');
export const REAL_STAGE = '실기 직접 연결 기초만: 탐색 응답·등록·시그널링의 순수 처리까지. 네트워크·RTC·조종 연결은 추가 개발 필요.';
let chosen = false;   // 사용자가 대상을 한 번 고르면 자동 선택 안 함
/** 실기 우선: Go2Direct 플러그인이 있는 앱 판에서만 처음 한 번 실기를 자동 표시(연결·명령은 여전히 0) */
export function autoProvider() { if (!chosen && go2Plugin() && useLink.getState().provider === 'simulation_gate') setProvider('go2_direct'); }

export function ModePick() {
  const p = useLink((x) => x.provider), pick = (k: 'go2_direct' | 'simulation_gate') => { chosen = true; setProvider(k); };
  return <div className="qmode" role="group" aria-label="실행 대상">
    <button type="button" aria-pressed={p === 'go2_direct'} onClick={() => pick('go2_direct')}>실기 Go2</button>
    <button type="button" aria-pressed={p === 'simulation_gate'} onClick={() => pick('simulation_gate')}>시뮬(보조)</button></div>;
}

export function OpsQuad({ map, camOk, camTxt, rgbExtra }: { map: (s: QSize) => ReactNode; camOk: boolean; camTxt: string; rgbExtra?: ReactNode }) {
  const p = useLink((x) => x.provider), st = useLink((x) => x.st);
  const sim = p === 'simulation_gate', follow = usePull('follow', sim); usePull('points', sim);
  const fKey = useLink((x) => viewKey(x, 'follow')), pKey = useLink((x) => viewKey(x, 'points'));   // 지금 보여도 되는 결속(끊김·대상·epoch·오래됨이면 '')
  if (!sim) {
    const why = go2Plugin() ? `지원 안 함(이 판 Go2Direct capabilities false) · ${REAL_STAGE}` : '실기 직접 연결: 준비 중(이 앱 판엔 없음)';
    const t = (id: string, label: string): QTile => ({ id, label, body: () => <QEmpty text={`${label} · ${why}`} /> });
    return <Quad label="실기 관제 4분할" tiles={[t('rmap', '지도'), t('rrgb', 'RGB'), t('rdepth', 'Depth'), t('rpts', '3D 라이다 점군')]} />;
  }
  const vWhy = (k: 'follow' | 'points') => viewWhy(st, k);   // 실행 중인 것·외부카메라 켬/끔·발행 쪽 이유 코드 구분(data/views.ts)
  const tiles: QTile[] = [
    { id: 'map', label: '지도', body: map },
    { id: 'rgb', label: 'RGB · Gazebo 렌더(실카메라 아님)', body: (s) => <>
      <img data-live-cam="" alt="Gazebo 렌더 카메라" src={camURL || undefined} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', visibility: camOk ? 'visible' : 'hidden' }} />
      {!camOk && <QEmpty text={`카메라 ${camTxt}`} />}{s !== 'thumb' && rgbExtra}</> },
    { id: 'follow', label: '외부 3인칭 · Gazebo 렌더', body: () => follow && fKey && follow.bind === fKey
      ? <img alt="Gazebo 렌더 3인칭 카메라" src={follow.url} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain' }} />
      : <QEmpty text={vWhy('follow')} /> },
    { id: 'pts', label: '3D 점군 누적 · 시각화(SLAM 3D 지도 아님)', body: (s) => <Cloud3D small={s === 'thumb'} big={s === 'big'} bind={pKey} empty={vWhy('points')} /> },
  ];
  return <Quad label="시뮬 관제 4분할" tiles={tiles} />;
}
