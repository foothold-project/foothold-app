// 관제 4분할 내용 + 실행 대상 고르기(실기 Go2 | 시뮬 보조). 대상 전환 = link.setProvider(입력 폐기·hidden·명령 0·세대+1·영상/길 비움).
// 실기(go2_direct): 지금 판엔 연결 없음 → 4칸 모두 빈 상태 + 이유(가짜 값 0). Go2Direct 계약(mobile docs/GO2DIRECT-CONTRACT.md) 문구 그대로.
// 시뮬: 지도(MapCanvas) · RGB(Gazebo 렌더) · 외부 3인칭(Gazebo 렌더, «지도 열기» 외부카메라 체크 때만) · 3D 점군 누적(시각화, SLAM 3D 지도 아님).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { stopOn } from './shell';
import { camURL, linkView, setProvider, useLink } from '../data/link';
import { CLOUD, usePull, viewKey, viewWhy } from '../data/views';
import { camChip } from './status';
import { Cloud3D, LidarTop } from './Cloud3D';
import { QEmpty, Quad, type QSize, type QTile } from './Quad';

const go2Plugin = () => !!(window as any).Capacitor?.isPluginAvailable?.('Go2Direct');
export const REAL_STAGE = '실기 직접 연결 기초만: 탐색 응답·등록·시그널링의 순수 처리까지. 네트워크·RTC·조종 연결은 추가 개발 필요.';
let chosen = false;   // 사용자가 대상을 한 번 고르면 자동 선택 안 함
/** 실기 우선: Go2Direct 플러그인이 있는 앱 판에서만 처음 한 번 실기를 자동 표시(연결·명령은 여전히 0) */
export function autoProvider() { if (!chosen && go2Plugin() && useLink.getState().provider === 'simulation_gate') setProvider('go2_direct'); }

export function ModePick() {
  const p = useLink((x) => x.provider), pick = (k: 'go2_direct' | 'simulation_gate') => { chosen = true; setProvider(k); };
  return <div className="qmode" role="group" aria-label="실행 대상">
    <button type="button" aria-pressed={p === 'go2_direct'} title={`실기 Go2 — 준비 중(조종·영상 연결 없음) · ${REAL_STAGE}`} onClick={() => pick('go2_direct')}>실기 Go2 · 준비 중</button>
    <button type="button" aria-pressed={p === 'simulation_gate'} onClick={() => pick('simulation_gate')}>시뮬(보조)</button></div>;
}

export function OpsQuad({ map, camOk, camTxt, rgbExtra }: { map: (s: QSize) => ReactNode; camOk: boolean; camTxt: string; rgbExtra?: ReactNode }) {
  const p = useLink((x) => x.provider), st = useLink((x) => x.st), [open, setOpen] = useState(false), touched = useRef(false);
  const sim = p === 'simulation_gate', follow = usePull('follow', sim), lidar = usePull('lidar', sim), pHave = usePull('points', sim);
  const fKey = useLink((x) => viewKey(x, 'follow')), pKey = useLink((x) => viewKey(x, 'points')), lKey = useLink((x) => viewKey(x, 'lidar'));   // 지금 보여도 되는 결속(끊김·대상·epoch·오래됨이면 '')
  // 점군 칸 = 지도 누적 | 센서 기준 1 scan 중 하나만(동시 그림·섞기 0). 지도 누적은 «같은 현재 키로 실제 점이 쌓였을 때»(CLOUD.n>0)만 — bound metadata 만으로 raw 를 끄지 않음.
  //   그 전엔 유효한 최신 raw(현재 run·epoch·2 s 안)를 센서 기준 라벨로. 층/epoch 경계에서 옛 누적은 usePull('points') 가 즉시 비움
  const mapPts = !!pKey && pHave === pKey && CLOUD.bind === pKey && CLOUD.n > 0, lOk = sim && !!(lidar && lKey && lidar.bind === lKey), raw = !mapPts && lOk;
  // fOk = 받은 3인칭 프레임이 지금 결속과 같음 · pOk = viewKey(발행 상태 metadata 유효)만 — 점이 실제로 쌓였는지는 Cloud3D 칸이 판단(«수신됨» 단정 0)
  const fOk = sim && !!(follow && fKey && follow.bind === fKey), pOk = sim && (!!pKey || lOk);
  // 10-15 ③: 보조 뷰가 한 번 보이면 펼침 고정 — 층 이동 등으로 잠시 비어도 4칸 배치 유지(빈 칸은 이유 글, 옛 층 그림 재사용 0). 사용자가 직접 접으면 그 뒤 자동 펼침 0.
  //   훅은 모두 아래 조건 return(실기) 앞 — 대상 왕복에도 훅 수 동일
  useEffect(() => { if (sim && (fOk || pOk) && !touched.current) setOpen(true); }, [sim, fOk, pOk]);
  if (!sim) {
    const why = go2Plugin() ? `지원 안 함(이 판 Go2Direct capabilities false) · ${REAL_STAGE}` : '실기 직접 연결: 준비 중(이 앱 판엔 없음)';
    // B2 R16: 빈 칸 4개 대신 한 줄(가짜 값 0 · 이유 그대로)
    return <p className="qd-line" role="status" data-qd-real="1">{`실기 관제(지도·RGB·Depth·3D 라이다 점군) — 연결되면 보임 · ${why}`}</p>;
  }
  const vWhy = (k: 'follow' | 'points' | 'lidar') => viewWhy(st, k);
  const ptsWhy = `지도 누적: ${vWhy('points')} · 실시간 라이다: ${vWhy('lidar')}`;   // 둘 다 못 보이면 두 이유 모두
  // B2 R16: 보조 뷰 2칸이 둘 다 «보일 수 있는 상태 아님»이면 접고 이유 한 줄 + 펼치기 버튼. 접기 = 표시만(usePull 구독·누적은 위에서 그대로).
  const tiles: QTile[] = [
    { id: 'map', label: '지도', body: map },
    { id: 'rgb', label: 'RGB · 시뮬 카메라', body: (s) => <>
      <img data-live-cam="" alt="시뮬 카메라 영상" src={camURL || undefined} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', visibility: camOk ? 'visible' : 'hidden' }} />
      {!camOk && <QEmpty text={camChip({ camOk, camTxt }).text} />}{s !== 'thumb' && rgbExtra}</> },
    { id: 'follow', label: '외부 3인칭 · 시뮬 카메라', body: () => follow && fKey && follow.bind === fKey
      ? <img alt="Gazebo 렌더 3인칭 카메라" src={follow.url} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain' }} />
      : <QEmpty text={vWhy('follow')} /> },
    raw && lidar
      ? { id: 'pts', label: '실시간 라이다 · 센서 기준(누적 없음)', body: (s) => <LidarTop scan={lidar} small={s === 'thumb'} /> }
      : { id: 'pts', label: '3D 점군 누적 그림', body: (s) => <Cloud3D small={s === 'thumb'} big={s === 'big'} bind={pKey} empty={ptsWhy} /> },
  ];
  // Quad 는 늘 같은 자리·같은 형제 순서 — tiles 만 바꿔 remount 0(크게 본 칸·PIP 선택 유지). 이유 줄은 둘 다 비었을 때만 Quad 뒤에
  const shown = open || fOk || pOk;
  return <><Quad label={shown ? '시뮬 관제 4분할' : '시뮬 관제'} tiles={shown ? tiles : tiles.slice(0, 2)}
    fs={<FsStop />} />
    {!fOk && !pOk && <AuxLine open={open} onClick={() => { touched.current = true; setOpen(!open); }} f={vWhy('follow')} p={ptsWhy} />}</>;
}

/** 보조 뷰 이유 줄(둘 다 비었을 때만): 두 칸의 지금 이유 + 펼치기/접기 */
const AuxLine = ({ open, onClick, f, p }: { open: boolean; onClick: () => void; f: string; p: string }) =>
  <div className="qd-line" role="status" data-qd-aux={open ? 'open' : 'closed'}>
    <span>{`보조 뷰 ${open ? '펼침' : '접힘'} · 외부 3인칭: ${f} · 3D 점군: ${p}`}</span>
    <button type="button" className="lv-btn" aria-expanded={open} onClick={onClick}>{open ? '보조 뷰 접기' : '보조 뷰 2칸 펼치기'}</button></div>;

/** 전체화면 안 STOP + 링크·잠금 한 줄 — 알림(toast)·확인창은 shell InFs 로 전체화면 안에 뜨지만 사라지므로, 지속 서버 상태는 이 줄로. 끊김·상태 미확인이면 «미확인»(잠김/안 잠김 단정 0) */
function FsStop() {
  const L = useLink(), v = linkView(L), sure = v.linkOk && !L.bad && !!L.st && L.stGen === L.gen;   // 이 연결에서 받은 유효 상태일 때만 잠금 여부를 말함
  return <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
    <button type="button" className="lv-stop" aria-label="비상 정지(전체화면)" {...stopOn}>STOP</button>
    <span role="status" style={{ padding: '4px 8px', borderRadius: 6, background: 'rgba(5,8,10,.8)', color: !sure ? '#FF5A52' : v.latch ? '#FFB547' : '#E6EBEF', fontSize: 13, fontWeight: 600 }}>
      {!v.linkOk ? `링크 ${v.linkTxt} — STOP 전달·잠금 미확인` : !sure ? 'STOP 잠금 미확인(상태 확인 전)' : v.latch ? '서버 상태: STOP 잠김' : `서버 상태: STOP 잠금 아님 · ${v.roleTxt}`}</span></div>;
}
