// 생성: scripts/dc2tsx.mjs ← web/Main.dc.html (시각 원본). 생성 뒤 손으로 실데이터 연결 — 다시 생성해 덮지 않는다.
/* eslint-disable */
import { Fragment } from 'react';
import { arr, css, fn, iv, ivs, str } from '../dc/jsx';
import { BrandLogo } from '../app/BrandLogo';   // 공식 로고(브랜드 변경)

export const PREVIEW = {"width":1440,"height":920};
export const FONTS = ["https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap"];
export const CSS = "\nbody{margin:0}\n.fh{--bg:#0B0E11;--panel:#12171C;--panel2:#182028;--line:#26313A;--line2:#34424D;--text:#E6EBEF;--muted:#9AA7B3;--accent:#38C6D9;--on-accent:#061014;--ok:#5AA9FF;--warn:#FFB547;--bad:#FF5A52;--bad-strong:#B3261E;--stop:#D7261E;--map:#0E1317;--wall:#4C5A66;--gridc:rgba(154,167,179,.07);--bad-bg:rgba(255,90,82,.13);--warn-bg:rgba(255,181,71,.12);--ok-bg:rgba(90,169,255,.10);--acc-bg:rgba(56,198,217,.12);font-family:'IBM Plex Sans KR',system-ui,sans-serif;color:var(--text);background:var(--bg);-webkit-font-smoothing:antialiased}\n.fh.light{--bg:#EDEFEA;--panel:#FFFFFF;--panel2:#F5F6F2;--line:#D7DBD3;--line2:#C2C8BF;--text:#12171C;--muted:#4F5A64;--accent:#006D7A;--on-accent:#FFFFFF;--ok:#1F5FBF;--warn:#9A5800;--bad:#B3261E;--bad-strong:#B3261E;--stop:#C8201A;--map:#F8F9F5;--wall:#7C8790;--gridc:rgba(18,23,28,.06);--bad-bg:rgba(179,38,30,.08);--warn-bg:rgba(154,88,0,.09);--ok-bg:rgba(31,95,191,.08);--acc-bg:rgba(0,109,122,.08)}\n.mono{font-family:'JetBrains Mono',ui-monospace,monospace;font-variant-numeric:tabular-nums}\nbutton{font:inherit;color:inherit;cursor:pointer}\n.chip{display:flex;align-items:center;gap:6px;height:34px;padding:0 10px;border:1px solid var(--line);border-radius:6px;font-size:13px;background:var(--panel2);white-space:nowrap}\n.chip .mk{font-size:11px}\n.chip.ok .mk{color:var(--ok)}\n.chip.warn{border-color:var(--warn)}.chip.warn .mk{color:var(--warn)}\n.chip.bad{border-color:var(--bad);background:var(--bad-bg)}.chip.bad .mk{color:var(--bad)}\n.btn{height:44px;padding:0 14px;border:1px solid var(--line2);background:var(--panel2);border-radius:8px;display:flex;align-items:center;gap:8px;font-weight:600;font-size:14px}\n.btn:hover{border-color:var(--accent)}\n.ibtn{width:36px;height:36px;border:1px solid var(--line);background:var(--panel2);border-radius:6px;display:grid;place-items:center}\n.layer{height:30px;padding:0 10px;border:1px solid var(--line);border-radius:999px;background:transparent;font-size:12px;display:flex;align-items:center;gap:6px;color:var(--muted)}\n.layer[aria-pressed=\"true\"]{background:var(--acc-bg);border-color:var(--accent);color:var(--text)}\n.tile{border:1px solid var(--line);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:6px;background:var(--panel2)}\n.tile .stl{font-size:12px;font-weight:600}\n.tile.ok .stl{color:var(--ok)}\n.tile.warn{border-color:var(--warn)}.tile.warn .stl,.tile.warn .val{color:var(--warn)}\n.tile.bad{border-color:var(--bad);background:var(--bad-bg)}.tile.bad .stl,.tile.bad .val{color:var(--bad)}\n.tile.stale{opacity:.62}\n.track{position:relative;height:6px;border-radius:3px;overflow:hidden;background:var(--line)}\n.seg{position:absolute;top:0;bottom:0}\n.seg.ok{background:var(--ok-bg)}.seg.warn{background:var(--warn-bg)}.seg.bad{background:var(--bad-bg)}\n.mark{position:absolute;top:-3px;width:3px;height:12px;border-radius:2px;background:var(--text);transform:translateX(-1px)}\n.spark{color:var(--ok)}.tile.warn .spark{color:var(--warn)}.tile.bad .spark{color:var(--bad)}\n.ev{display:grid;grid-template-columns:64px 18px 1fr;gap:8px;align-items:start;padding:8px 0;border-top:1px solid var(--line);font-size:13px;line-height:1.45}\n.ev .em.ok{color:var(--ok)}.ev .em.warn{color:var(--warn)}.ev .em.bad{color:var(--bad)}\n.step{flex:1 1 150px;min-width:0;border:1px solid var(--line);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:4px;background:var(--panel2)}\n.step.done .sn{background:var(--ok);color:var(--on-accent);border-color:var(--ok)}\n.step.now{border-color:var(--accent);background:var(--acc-bg)}\n.step.now .sn{border-color:var(--accent);color:var(--accent)}\n.step.hold{border-color:var(--warn);background:var(--warn-bg)}\n.step.hold .sn{border-color:var(--warn);color:var(--warn)}\n.sn{width:22px;height:22px;border-radius:50%;border:1.5px solid var(--line2);display:grid;place-items:center;font-size:12px;font-weight:700}\n.nav{display:flex;flex-direction:column;align-items:center;gap:4px;width:64px;padding:10px 0;border-radius:8px;font-size:11px;color:var(--muted);text-decoration:none}\n.nav:hover{color:var(--text);background:var(--panel2)}\n.nav.cur{color:var(--text);background:var(--acc-bg)}\n.nav.cur svg{color:var(--accent)}\n/* 승인 수정(10-12): 머리줄은 한 줄 — STOP 은 늘 오른쪽 위. 칩 묶음만 줄어들어 안에서 줄바꿈한다 */\nheader>*{flex-shrink:0}\n/* 승인 수정(10-12): PC 머리줄(STOP 포함)은 스크롤해도 화면 위에 남는다 — 불투명 배경(--panel)이 아래 내용을 가린 채 위에 놓임 */\nheader{position:sticky;top:0;z-index:10}\n";
/** 원본 틀이 읽는 값 이름 */
export type Vals = { [k: string]: any; themeClass?: any; siteLine?: any; stepTitle?: any; modeBg?: any; modeFg?: any; modeLabel?: any; chips?: any; isGas?: any; isDetAlarm?: any; isAsk?: any; isLost?: any; showPlan?: any; showDoneNormal?: any; showDoneAlt?: any; showRetreat?: any; showR?: any; tag1?: any; tag2?: any; showGasTag?: any; showWaitTag?: any; tag3Color?: any; tag3Mark?: any; tag3?: any; showFind?: any; rx?: any; ry?: any; rrot?: any; robotOpacity?: any; heading?: any; eta?: any; steps?: any; vidLag?: any; motion?: any; panelAsk?: any; panelDet?: any; detPerson?: any; panelGas?: any; gasSrc?: any; tiles?: any; evLink?: any; events?: any };

export function View({ v }: { v: Vals }) {
  return (
    <>
      {" "}
      {" "}
      <div className={`${str(v.themeClass)}` as any} style={{"minHeight":"100vh","display":"flex","flexDirection":"column"}}>
        {" "}
        <header style={{"display":"flex","flexWrap":"wrap","alignItems":"center","gap":"12px 16px","padding":"10px 16px","borderBottom":"1px solid var(--line)","background":"var(--panel)"}}>
          {" "}
          <div style={{"display":"flex","alignItems":"center","gap":"10px"}}>
            {" "}
            <BrandLogo h={24} />
            {" "}
          </div>
          {" "}
          <div style={{"width":"1px","height":"32px","background":"var(--line)"}} />
          {" "}
          <div style={{"display":"flex","flexDirection":"column","gap":"2px","minWidth":"0"}}>
            {" "}
            <span style={{"fontSize":"12px","color":"var(--muted)"}}>
              {v.siteNode ?? iv(v.siteLine)}
            </span>
            {" "}
            <span style={{"fontSize":"17px","fontWeight":"600"}}>
              {iv(v.stepTitle)}
            </span>
            {" "}
          </div>
          {" "}
          <span style={css(`height:26px;padding:0 10px;border-radius:999px;display:flex;align-items:center;font-size:12px;font-weight:600;background:${str(v.modeBg)};color:${str(v.modeFg)}`)}>
            {iv(v.modeLabel)}
          </span>
          {" "}
          <div style={{"flex":"1"}} />
          {" "}
          <div style={{"display":"flex","flexWrap":"wrap","gap":"6px","flex":"0 1 auto","minWidth":"0","justifyContent":"flex-end"}}>
            {" "}
            {arr(v.chips).map((c: any, i6: number) => (<Fragment key={i6}>
              {" "}
              <div className={`chip ${str(c?.st)}` as any}>
                <span className="mk">
                  {iv(c?.mark)}
                </span>
                <span style={{"color":"var(--muted)"}}>
                  {iv(c?.k)}
                </span>
                <span className="mono" style={{"fontWeight":"600"}}>
                  {iv(c?.v)}
                </span>
              </div>
              {" "}
            </Fragment>))}
            {v.head ?? null}
            {" "}
          </div>
          {" "}
          <div style={{"display":"flex","alignItems":"center","gap":"8px","padding":"0 4px"}}>
            {" "}
            <div style={{"width":"32px","height":"32px","borderRadius":"50%","background":"var(--panel2)","border":"1px solid var(--line2)","display":"grid","placeItems":"center","fontSize":"13px","fontWeight":"600"}}>
              {v.opInit ?? "A"}
            </div>
            {" "}
            <div style={{"display":"flex","flexDirection":"column","lineHeight":"1.25"}}>
              {" "}
              <span style={{"fontSize":"13px","fontWeight":"600"}}>
                {v.opName ?? "운영자 A"}
              </span>
              {" "}
              <span style={{"fontSize":"11px","color":"var(--muted)"}}>
                {v.opRole ?? "조종권 · 이 기기"}
              </span>
              {" "}
            </div>
            {" "}
          </div>
          {" "}
          <button aria-label="비상 정지" {...v.stopProps} style={{"flexShrink":"0","height":"52px","minWidth":"136px","padding":"0 18px","border":"0","borderRadius":"8px","background":"var(--stop)","color":"#FFFFFF","display":"flex","alignItems":"center","gap":"10px","boxShadow":"0 0 0 3px rgba(215,38,30,.22)"}}>
            {" "}
            <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M8 2h8l6 6v8l-6 6H8l-6-6V8z" fill="none" stroke="#FFFFFF" strokeWidth="2" />
              <rect x="8" y="8" width="8" height="8" fill="#FFFFFF" />
            </svg>
            {" "}
            <span style={{"display":"flex","flexDirection":"column","alignItems":"flex-start","lineHeight":"1.1"}}>
              <span style={{"fontWeight":"700","fontSize":"19px","letterSpacing":".08em"}}>
                {"STOP"}
              </span>
              <span style={{"fontSize":"11px"}}>
                {v.stopSub ?? "스페이스 · 명령 0·잠금"}
              </span>
            </span>
            {" "}
          </button>
          {v.stopHelp ?? null}
          {" "}
        </header>
        {" "}
        {v.isGas ? (<>
          {" "}
          <div role="alert" style={{"display":"flex","flexWrap":"wrap","alignItems":"center","gap":"10px 18px","padding":"12px 16px","background":"var(--bad-strong)","color":"#FFFFFF"}}>
            {" "}
            <span style={{"fontWeight":"700","fontSize":"17px"}}>
              {"■ 위험 · H₂S "}
              <span className="mono">
                {"12.4"}
              </span>
              {" ppm"}
            </span>
            {" "}
            <span style={{"fontSize":"14px"}}>
              {"WP3 집수정 · 기준 10 ppm 미만 초과 · "}
              <span className="mono">
                {"10:46:08"}
              </span>
            </span>
            {" "}
            <span style={{"fontSize":"14px","padding":"4px 10px","border":"1px solid rgba(255,255,255,.5)","borderRadius":"6px"}}>
              {"자동 조치: 임무 일시정지 → 후퇴 지점 R로 이동 중 · 남은 "}
              <span className="mono">
                {"9 m"}
              </span>
            </span>
            {" "}
            <div style={{"flex":"1"}} />
            {" "}
            <div style={{"display":"flex","flexWrap":"wrap","gap":"8px"}}>
              {" "}
              <button style={{"height":"40px","padding":"0 14px","border":"0","borderRadius":"6px","background":"#FFFFFF","color":"#a3342a","fontWeight":"700"}}>
                {"후퇴 계속 · 확인"}
              </button>
              {" "}
              <button style={{"height":"40px","padding":"0 14px","border":"1px solid #FFFFFF","borderRadius":"6px","background":"transparent","color":"#FFFFFF","fontWeight":"600"}}>
                {"그 자리 정지"}
              </button>
              {" "}
              <button style={{"height":"40px","padding":"0 14px","border":"1px solid #FFFFFF","borderRadius":"6px","background":"transparent","color":"#FFFFFF","fontWeight":"600"}}>
                {"직접 조종으로"}
              </button>
              {" "}
            </div>
            {" "}
          </div>
          {" "}
        </>) : null}
        {" "}
        {v.isDetAlarm ? (<>
          {" "}
          <div role="alert" style={{"display":"flex","flexWrap":"wrap","alignItems":"center","gap":"10px 18px","padding":"12px 16px","background":"var(--bad-strong)","color":"#FFFFFF"}}>
            {" "}
            <span style={{"fontWeight":"700","fontSize":"17px"}}>
              {"■ 경보 · 탐지: 쓰러진 사람 의심 "}
              <span className="mono">
                {"0.81"}
              </span>
            </span>
            {" "}
            <span style={{"fontSize":"14px"}}>
              {"집수정 입구 · "}
              <span className="mono">
                {"10:46:08"}
              </span>
            </span>
            {" "}
            <span style={{"fontSize":"14px","padding":"4px 10px","border":"1px solid rgba(255,255,255,.5)","borderRadius":"6px"}}>
              {"자동 조치: 임무 일시정지 · 운영자 확인 대기"}
            </span>
            {" "}
            <div style={{"flex":"1"}} />
            {" "}
            <div style={{"display":"flex","flexWrap":"wrap","gap":"8px"}}>
              {" "}
              <button style={{"height":"40px","padding":"0 14px","border":"0","borderRadius":"6px","background":"#FFFFFF","color":"#a3342a","fontWeight":"700"}}>
                {"맞음 · 구조 요청"}
              </button>
              {" "}
              <button style={{"height":"40px","padding":"0 14px","border":"1px solid #FFFFFF","borderRadius":"6px","background":"transparent","color":"#FFFFFF","fontWeight":"600"}}>
                {"오탐 · 임무 계속"}
              </button>
              {" "}
              <button style={{"height":"40px","padding":"0 14px","border":"1px solid #FFFFFF","borderRadius":"6px","background":"transparent","color":"#FFFFFF","fontWeight":"600"}}>
                {"가까이 가서 보기"}
              </button>
              {" "}
            </div>
            {" "}
          </div>
          {" "}
        </>) : null}
        {" "}
        {v.isAsk ? (<>
          {" "}
          <div role="alert" style={{"display":"flex","flexWrap":"wrap","alignItems":"center","gap":"10px 18px","padding":"12px 16px","background":"var(--accent)","color":"var(--on-accent)"}}>
            {" "}
            <span style={{"fontWeight":"700","fontSize":"17px"}}>
              {"확인해 주세요 · WP3에 도착했습니다"}
            </span>
            {" "}
            <span style={{"fontSize":"14px"}}>
              {"영상을 보고 골라 주세요. 답할 때까지 로봇은 멈춰 있습니다 · "}
              <span className="mono">
                {"0:42"}
              </span>
              {" 대기 중"}
            </span>
            {" "}
            <div style={{"flex":"1"}} />
            {" "}
            <div style={{"display":"flex","flexWrap":"wrap","gap":"8px"}}>
              {" "}
              <button style={{"height":"40px","padding":"0 14px","border":"0","borderRadius":"6px","background":"var(--on-accent)","color":"var(--accent)","fontWeight":"700"}}>
                {"맞음 · 다음으로"}
              </button>
              {" "}
              <button style={{"height":"40px","padding":"0 14px","border":"1.5px solid var(--on-accent)","borderRadius":"6px","background":"transparent","color":"var(--on-accent)","fontWeight":"600"}}>
                {"다시 보기"}
              </button>
              {" "}
              <button style={{"height":"40px","padding":"0 14px","border":"1.5px solid var(--on-accent)","borderRadius":"6px","background":"transparent","color":"var(--on-accent)","fontWeight":"600"}}>
                {"임무 중단"}
              </button>
              {" "}
            </div>
            {" "}
          </div>
          {" "}
        </>) : null}
        {" "}
        {v.isLost ? (<>
          {" "}
          <div role="alert" style={{"display":"flex","flexWrap":"wrap","alignItems":"center","gap":"10px 18px","padding":"12px 16px","background":"var(--warn)","color":"var(--paper)"}}>
            {" "}
            <span style={{"fontWeight":"700","fontSize":"17px"}}>
              {"▲ 로봇과 통신 끊김 · "}
              <span className="mono">
                {"8"}
              </span>
              {"초"}
            </span>
            {" "}
            <span style={{"fontSize":"14px"}}>
              {"설정한 정책대로 로봇은 마지막 통신 지점 R로 돌아오는 중일 것입니다(예상). 화면의 값은 마지막으로 받은 값입니다."}
            </span>
            {" "}
            <div style={{"flex":"1"}} />
            {" "}
            <span style={{"fontSize":"13px","fontWeight":"600"}}>
              {"다시 연결되면 자동으로 이어 가지 않고 확인을 기다립니다"}
            </span>
            {" "}
          </div>
          {" "}
        </>) : null}
        {" "}
        <div style={{"flex":"1","display":"flex","flexWrap":"wrap","minHeight":"0"}}>
          {" "}
          <nav aria-label="주 메뉴" style={{"flex":"0 0 76px","display":"flex","flexDirection":"column","alignItems":"center","gap":"4px","padding":"12px 6px","borderRight":"1px solid var(--line)","background":"var(--panel)"}}>
            {" "}
            <a className="nav cur" href="#/Main" aria-current="page">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <circle cx="12" cy="12" r="8" />
                <circle cx="12" cy="12" r="3" />
                <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
              </svg>
              {"관제"}
            </a>
            {" "}
            <a className="nav" href="#/PcMissions">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <path d="M4 19l5-14 5 9 3-4 3 9" />
                <circle cx="9" cy="5" r="1.5" />
              </svg>
              {"임무"}
            </a>
            {" "}
            <a className="nav" href="#/PcHistory">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <rect x="4" y="3" width="16" height="18" rx="2" />
                <path d="M8 8h8M8 12h8M8 16h5" />
              </svg>
              {"기록"}
            </a>
            {" "}
            <a className="nav" href="#/PcMap">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z" />
                <path d="M9 4v14M15 6v14" />
              </svg>
              {"지도"}
            </a>
            {" "}
            <a className="nav" href="#/PcRobot">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <rect x="6" y="4" width="12" height="14" rx="3" />
                <path d="M9 21h6M12 18v3M9 9h.01M15 9h.01" />
              </svg>
              {"로봇"}
            </a>
            {" "}
            <div style={{"flex":"1"}} />
            {" "}
            <a className="nav" href="#/PcSettings">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <circle cx="12" cy="12" r="3" />
                <path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1" />
              </svg>
              {"설정"}
            </a>
            {" "}
          </nav>
          {" "}
          <main style={{"flex":"999 1 600px","minWidth":"0","display":"flex","flexWrap":"wrap","gap":"12px","padding":"12px","alignContent":"flex-start"}}>
            {" "}
            <section aria-label="지도와 임무 단계" style={{"flex":"999 1 620px","minWidth":"0","display":"flex","flexDirection":"column","gap":"12px"}}>
              {" "}
              <div style={{"background":"var(--panel)","border":"1px solid var(--line)","borderRadius":"10px","overflow":"hidden","display":"flex","flexDirection":"column"}}>
                {" "}
                <div style={{"display":"flex","flexWrap":"wrap","alignItems":"center","gap":"8px 12px","padding":"10px 12px","borderBottom":"1px solid var(--line)"}}>
                  {" "}
                  <span style={{"fontWeight":"600"}}>
                    {v.cardTitle ?? "지도"}
                  </span>
                  {v.modePick ?? null}
                  {" "}
                  <span style={{"fontSize":"12px","color":"var(--muted)"}}>
                    {v.mapTitle ?? <>{"B1 · 저장 지도 "}
                    <span className="mono">
                      {"10-10 14:20"}
                    </span></>}
                  </span>
                  {" "}
                  <div style={{"flex":"1"}} />
                  {" "}
                  <div role="group" aria-label="지도 레이어" style={{"display":"flex","flexWrap":"wrap","gap":"6px"}}>
                    {" "}
                    <button className="layer" aria-pressed="true" {...v.layerP?.[0]}>
                      {"경로"}
                    </button>
                    {" "}
                    <button className="layer" aria-pressed="true" {...v.layerP?.[1]}>
                      {"측정값"}
                    </button>
                    {" "}
                    <button className="layer" aria-pressed="true" {...v.layerP?.[2]}>
                      {"발견물 "}
                      <span className="mono" style={{"padding":"0 6px","borderRadius":"999px","background":"var(--warn)","color":"var(--paper)","fontWeight":"700"}}>
                        {v.findCnt ?? "2"}
                      </span>
                    </button>
                    {" "}
                    <button className="layer" aria-pressed="true" {...v.layerP?.[3]}>
                      {"통신 품질"}
                    </button>
                    {" "}
                    <button className="layer" aria-pressed="true" {...v.layerP?.[4]}>
                      {"금지 구역"}
                    </button>
                    {" "}
                    <button className="layer" aria-pressed="false" {...v.layerP?.[5]}>
                      {"3D 점군"}
                    </button>
                    {" "}
                  </div>
                  {" "}
                  <div style={{"display":"flex","gap":"4px"}}>
                    {" "}
                    <button className="ibtn" aria-label="로봇 따라가기" {...v.folP}>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                        <circle cx="12" cy="12" r="3" />
                        <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
                      </svg>
                    </button>
                    {" "}
                    <button className="ibtn" aria-label="확대" {...v.zinP}>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                        <path d="M12 5v14M5 12h14" />
                      </svg>
                    </button>
                    {" "}
                    <button className="ibtn" aria-label="축소" {...v.zoutP}>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                        <path d="M5 12h14" />
                      </svg>
                    </button>
                    {" "}
                  </div>
                  {" "}
                </div>
                {" "}
                {v.map ?? (<svg viewBox="0 0 1000 620" style={{"width":"100%","height":"auto","display":"block"}} role="img" aria-label="지하 펌프실 지도: 로봇 위치, 지나온 경로, 남은 경로, 측정 지점 4곳, 발견물 2건, 진입 금지 구역, 통신 약함 구역">
                  <defs>
                    <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
                      <path d="M20 0H0V20" fill="none" style={{"stroke":"var(--gridc)"}} strokeWidth="1" />
                    </pattern>
                    <pattern id="hb" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                      <line x1="0" y1="0" x2="0" y2="10" style={{"stroke":"var(--bad)"}} strokeWidth="2" strokeOpacity=".4" />
                    </pattern>
                    <pattern id="hw" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
                      <line x1="0" y1="0" x2="0" y2="10" style={{"stroke":"var(--warn)"}} strokeWidth="2" strokeOpacity=".32" />
                    </pattern>
                  </defs>
                  <rect width="1000" height="620" style={{"fill":"var(--map)"}} />
                  <rect width="1000" height="620" fill="url(#grid)" />
                  <rect x="43" y="43" width="254" height="194" fill="url(#hb)" />
                  <rect x="690" y="420" width="267" height="157" fill="url(#hw)" />
                  <g style={{"stroke":"var(--wall)"}} strokeWidth="6" fill="none" strokeLinecap="square">
                    <rect x="40" y="40" width="920" height="540" />
                    <path d="M40 240H200M260 240H300M300 40V300M300 300H440M500 300H770M830 300H960M640 40V300" />
                    <path d="M40 380H120M180 380H330M380 380H750M810 380H960M240 380V580M600 380V580" />
                  </g>
                  <g style={{"stroke":"var(--wall)"}} strokeWidth="2" fill="none" opacity=".8">
                    <circle cx="390" cy="150" r="32" />
                    <circle cx="560" cy="120" r="32" />
                    <path d="M660 90H940M660 120H940M660 230H940" strokeDasharray="2 0" />
                    <rect x="830" y="470" width="96" height="76" strokeDasharray="6 5" />
                    <rect x="270" y="420" width="120" height="80" />
                    <rect x="440" y="420" width="120" height="80" />
                  </g>
                  <g fontFamily="'Pretendard Variable', Pretendard, sans-serif" fontSize="15" style={{"fill":"var(--muted)"}}>
                    <text x="60" y="72" style={{"fill":"var(--bad)"}} fontWeight="600">
                      {"전기실 · 진입 금지"}
                    </text>
                    <text x="320" y="72">
                      {"펌프실 A"}
                    </text>
                    <text x="660" y="72">
                      {"배관 구역"}
                    </text>
                    <text x="60" y="412">
                      {"계단실 · 진입로"}
                    </text>
                    <text x="260" y="412">
                      {"송풍기실"}
                    </text>
                    <text x="620" y="412">
                      {"집수정"}
                    </text>
                    <text x="836" y="562" fontSize="12">
                      {"개구부"}
                    </text>
                    <text x="700" y="572" fontSize="12" style={{"fill":"var(--warn)"}}>
                      {"통신 약함 · −80 dBm 이하"}
                    </text>
                  </g>
                  <polyline points="780,404 780,480 780,340 800,340 800,170 800,340 150,340 150,450 120,540" fill="none" style={{"stroke":"var(--muted)"}} strokeWidth="3" strokeDasharray="8 7" opacity=".7" display={`${str(v.showPlan)}` as any} />
                  <polyline points="120,540 150,450 150,340 470,340 470,180 470,340 780,340 780,404" fill="none" style={{"stroke":"var(--accent)"}} strokeWidth="4" strokeLinejoin="round" display={`${str(v.showDoneNormal)}` as any} />
                  <polyline points="120,540 150,450 150,340 470,340 470,180 470,340 780,340 780,476" fill="none" style={{"stroke":"var(--accent)"}} strokeWidth="4" strokeLinejoin="round" display={`${str(v.showDoneAlt)}` as any} />
                  <polyline points="780,456 780,340 700,340" fill="none" style={{"stroke":"var(--bad)"}} strokeWidth="4" strokeDasharray="10 6" display={`${str(v.showRetreat)}` as any} />
                  <g display={`${str(v.showR)}` as any}>
                    <circle cx="700" cy="340" r="15" style={{"fill":"var(--map)","stroke":"var(--bad)"}} strokeWidth="3" />
                    <text x="700" y="345" textAnchor="middle" fontSize="14" fontWeight="700" style={{"fill":"var(--bad)"}} fontFamily="'Pretendard Variable', Pretendard, sans-serif">
                      {"R"}
                    </text>
                    <text x="664" y="320" fontSize="12" style={{"fill":"var(--bad)"}} fontFamily="'Pretendard Variable', Pretendard, sans-serif">
                      {"후퇴 지점"}
                    </text>
                  </g>
                  <g fontFamily="'Pretendard Variable', Pretendard, sans-serif" fontWeight="700" fontSize="13" textAnchor="middle">
                    <rect x="106" y="526" width="28" height="28" rx="4" style={{"fill":"var(--map)","stroke":"var(--text)"}} strokeWidth="2" />
                    <text x="120" y="545" style={{"fill":"var(--text)"}}>
                      {"S"}
                    </text>
                    <circle cx="150" cy="450" r="15" style={{"fill":"var(--ok)"}} />
                    <text x="150" y="455" style={{"fill":"var(--map)"}}>
                      {"1"}
                    </text>
                    <circle cx="470" cy="180" r="15" style={{"fill":"var(--ok)"}} />
                    <text x="470" y="185" style={{"fill":"var(--map)"}}>
                      {"2"}
                    </text>
                    <circle cx="780" cy="490" r="22" fill="none" style={{"stroke":"var(--accent)"}} strokeWidth="2" strokeDasharray="4 4" display={`${str(v.showPlan)}` as any} />
                    <circle cx="780" cy="490" r="15" style={{"fill":"var(--map)","stroke":"var(--accent)"}} strokeWidth="3" />
                    <text x="780" y="495" style={{"fill":"var(--accent)"}}>
                      {"3"}
                    </text>
                    <circle cx="800" cy="170" r="15" style={{"fill":"var(--map)","stroke":"var(--muted)"}} strokeWidth="2.5" />
                    <text x="800" y="175" style={{"fill":"var(--muted)"}}>
                      {"4"}
                    </text>
                  </g>
                  <g fontFamily="'Pretendard Variable', Pretendard, sans-serif" fontSize="12">
                    <rect x="172" y="440" width="138" height="24" rx="4" style={{"fill":"var(--panel)","stroke":"var(--line2)"}} />
                    <text x="182" y="456" style={{"fill":"var(--ok)"}}>
                      {"●"}
                    </text>
                    <text x="196" y="456" style={{"fill":"var(--text)"}}>
                      {ivs(v.tag1)}
                    </text>
                    <rect x="490" y="196" width="138" height="24" rx="4" style={{"fill":"var(--panel)","stroke":"var(--line2)"}} />
                    <text x="500" y="212" style={{"fill":"var(--ok)"}}>
                      {"●"}
                    </text>
                    <text x="514" y="212" style={{"fill":"var(--text)"}}>
                      {ivs(v.tag2)}
                    </text>
                    <g display={`${str(v.showGasTag)}` as any}>
                      <rect x="604" y="500" width="160" height="24" rx="4" style={{"fill":"var(--bad-strong)"}} />
                      <text x="614" y="516" fill="#FFFFFF" fontWeight="700">
                        {"■ H₂S 12.4 ppm"}
                      </text>
                    </g>
                    <g display={`${str(v.showWaitTag)}` as any}>
                      <rect x="640" y="500" width="124" height="24" rx="4" style={{"fill":"var(--panel)","stroke":"var(--line2)"}} />
                      <text x="650" y="516" style={css(`fill:${str(v.tag3Color)}`)}>
                        {ivs(v.tag3Mark)}
                      </text>
                      <text x="666" y="516" style={{"fill":"var(--text)"}}>
                        {ivs(v.tag3)}
                      </text>
                    </g>
                  </g>
                  <g display={`${str(v.showFind)}` as any}>
                    <rect x="531" y="221" width="16" height="16" transform="rotate(45 539 229)" style={{"fill":"var(--warn)"}} />
                    <text x="539" y="234" textAnchor="middle" fontSize="12" fontWeight="700" style={{"fill":"var(--paper)"}} fontFamily="'Pretendard Variable', Pretendard, sans-serif">
                      {"!"}
                    </text>
                    <text x="556" y="234" fontSize="13" style={{"fill":"var(--text)"}} fontFamily="'Pretendard Variable', Pretendard, sans-serif">
                      {"바닥 물고임"}
                    </text>
                    <rect x="397" y="252" width="16" height="16" transform="rotate(45 405 260)" style={{"fill":"var(--warn)"}} />
                    <text x="405" y="265" textAnchor="middle" fontSize="12" fontWeight="700" style={{"fill":"var(--paper)"}} fontFamily="'Pretendard Variable', Pretendard, sans-serif">
                      {"!"}
                    </text>
                    <text x="322" y="284" fontSize="13" style={{"fill":"var(--text)"}} fontFamily="'Pretendard Variable', Pretendard, sans-serif">
                      {"보온재 손상"}
                    </text>
                  </g>
                  <g transform={`translate(${str(v.rx)} ${str(v.ry)}) rotate(${str(v.rrot)})` as any} opacity={`${str(v.robotOpacity)}` as any}>
                    <path d="M0 0 L-46 -96 A106 106 0 0 1 46 -96 Z" style={{"fill":"var(--accent)"}} opacity=".14" />
                    <circle r="20" style={{"fill":"var(--accent)"}} opacity=".18" />
                    <path d="M0 -16 L11 11 L0 5 L-11 11 Z" style={{"fill":"var(--accent)","stroke":"var(--map)"}} strokeWidth="2" strokeLinejoin="round" />
                  </g>
                  <g fontFamily="'Pretendard Variable', Pretendard, sans-serif" fontSize="12" style={{"fill":"var(--muted)"}}>
                    <line x1="40" y1="603" x2="140" y2="603" style={{"stroke":"var(--muted)"}} strokeWidth="2" />
                    <line x1="40" y1="597" x2="40" y2="609" style={{"stroke":"var(--muted)"}} strokeWidth="2" />
                    <line x1="140" y1="597" x2="140" y2="609" style={{"stroke":"var(--muted)"}} strokeWidth="2" />
                    <text x="150" y="607">
                      {"5 m"}
                    </text>
                    <text x="960" y="607" textAnchor="end">
                      {"x 31.2 y 12.8 θ "}
                      {ivs(v.heading)}
                    </text>
                  </g>
                </svg>)}
                {" "}
                <div style={{"display":"flex","flexWrap":"wrap","gap":"6px 16px","padding":"10px 12px","borderTop":"1px solid var(--line)","fontSize":"12px","color":"var(--muted)","visibility":v.legendHide ? "hidden" : undefined}}>
                  {" "}
                  <span style={{"display":"flex","alignItems":"center","gap":"6px"}}>
                    <svg width="22" height="6" aria-hidden="true">
                      <line x1="0" y1="3" x2="22" y2="3" style={{"stroke":"var(--accent)"}} strokeWidth="3" />
                    </svg>
                    {"지나온 경로"}
                  </span>
                  {" "}
                  <span style={{"display":"flex","alignItems":"center","gap":"6px"}}>
                    <svg width="22" height="6" aria-hidden="true">
                      <line x1="0" y1="3" x2="22" y2="3" style={{"stroke":"var(--muted)"}} strokeWidth="2" strokeDasharray="5 4" />
                    </svg>
                    {"남은 경로"}
                  </span>
                  {" "}
                  <span style={{"display":"flex","alignItems":"center","gap":"6px"}}>
                    <span style={{"width":"12px","height":"12px","borderRadius":"50%","background":"var(--ok)"}} />
                    {"측정 완료"}
                  </span>
                  {" "}
                  <span style={{"display":"flex","alignItems":"center","gap":"6px"}}>
                    <span style={{"width":"12px","height":"12px","borderRadius":"50%","border":"2px solid var(--accent)"}} />
                    {"다음 지점"}
                  </span>
                  {" "}
                  <span style={{"display":"flex","alignItems":"center","gap":"6px"}}>
                    <span style={{"width":"10px","height":"10px","transform":"rotate(45deg)","background":"var(--warn)"}} />
                    {"발견물"}
                  </span>
                  {" "}
                  <span style={{"display":"flex","alignItems":"center","gap":"6px"}}>
                    <span style={{"width":"14px","height":"10px","background":"var(--bad-bg)","border":"1px solid var(--bad)"}} />
                    {"진입 금지"}
                  </span>
                  {" "}
                  <span style={{"display":"flex","alignItems":"center","gap":"6px"}}>
                    <span style={{"width":"14px","height":"10px","background":"var(--warn-bg)","border":"1px dashed var(--warn)"}} />
                    {"통신 약함"}
                  </span>
                  {" "}
                </div>
                {" "}
              </div>
              {" "}
              <div style={{"background":"var(--panel)","border":"1px solid var(--line)","borderRadius":"10px","padding":"12px","display":"flex","flexDirection":"column","gap":"10px"}}>
                {" "}
                <div style={{"display":"flex","alignItems":"center","gap":"10px"}}>
                  {" "}
                  <span style={{"fontWeight":"600"}}>
                    {"임무 단계"}
                  </span>
                  {" "}
                  <span style={{"fontSize":"12px","color":"var(--muted)"}}>
                    {v.stepHead ?? <>{"경과 "}
                    <span className="mono">
                      {"15:42"}
                    </span>
                    {" · 예상 남은 "}
                    <span className="mono">
                      {iv(v.eta)}
                    </span>
                    {" · 거리 "}
                    <span className="mono">
                      {"96 / 148 m"}
                    </span></>}
                  </span>
                  {" "}
                </div>
                {" "}
                <div style={{"display":"flex","flexWrap":"wrap","gap":"8px"}}>
                  {" "}
                  {arr(v.steps).map((s: any, i9: number) => (<Fragment key={i9}>
                    {" "}
                    <div className={`step ${str(s?.cls)}` as any}>
                      {" "}
                      <div style={{"display":"flex","alignItems":"center","gap":"8px"}}>
                        <span className="sn mono">
                          {iv(s?.n)}
                        </span>
                        <span style={{"fontSize":"13px","fontWeight":"600","whiteSpace":"nowrap","overflow":"hidden","textOverflow":"ellipsis"}}>
                          {iv(s?.title)}
                        </span>
                      </div>
                      {" "}
                      <span style={{"fontSize":"12px","color":"var(--muted)"}}>
                        {iv(s?.sub)}
                      </span>
                      {" "}
                    </div>
                    {" "}
                  </Fragment>))}
                  {" "}
                </div>
                {v.afterSteps ?? null}
              </div>
              {" "}
            </section>
            {" "}
            <section aria-label="영상과 측정" style={{"flex":"1 1 430px","minWidth":"0","maxWidth":"520px","display":"flex","flexDirection":"column","gap":"12px"}}>
              {" "}
              <div style={{"position":"relative","borderRadius":"10px","overflow":"hidden","border":"1px solid var(--line)","background":"#05080A","aspectRatio":"16/9"}} ref={v.boxRef} className={v.boxCls} hidden={v.camHide}>
                {" "}
                {v.cam ?? (<svg viewBox="0 0 640 360" preserveAspectRatio="xMidYMid slice" style={{"position":"absolute","inset":"0","width":"100%","height":"100%"}} role="img" aria-label="전방 카메라 영상 자리: 집수정 쪽 통로, 바닥 물고임 탐지 상자">
                  <defs>
                    <radialGradient id="lamp" cx="50%" cy="85%" r="60%">
                      <stop offset="0" stopColor="#FFFFFF" stopOpacity=".09" />
                      <stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
                    </radialGradient>
                  </defs>
                  <rect width="640" height="360" fill="#070A0C" />
                  <polygon points="0,0 640,0 404,92 236,92" fill="#0A0E11" />
                  <polygon points="0,0 236,92 236,206 0,360" fill="#0D1317" />
                  <polygon points="640,0 404,92 404,206 640,360" fill="#0F151A" />
                  <polygon points="0,360 640,360 404,206 236,206" fill="#131B20" />
                  <rect x="236" y="92" width="168" height="114" fill="#040607" stroke="#26313A" strokeWidth="3" />
                  <line x1="0" y1="64" x2="236" y2="122" stroke="#2C3A44" strokeWidth="9" />
                  <line x1="0" y1="98" x2="236" y2="134" stroke="#25313A" strokeWidth="5" />
                  <line x1="640" y1="40" x2="404" y2="112" stroke="#1F2930" strokeWidth="4" />
                  <ellipse cx="322" cy="300" rx="104" ry="22" fill="#1C2C35" opacity=".9" />
                  <ellipse cx="300" cy="296" rx="46" ry="6" fill="#3A5260" opacity=".55" />
                  <rect x="268" y="224" width="104" height="10" fill="#1A2329" />
                  <rect width="640" height="360" fill="url(#lamp)" />
                  <g display={`${str(v.showFind)}` as any}>
                    <rect x="206" y="268" width="232" height="62" fill="none" stroke="#dc9a30" strokeWidth="2" />
                    <rect x="206" y="246" width="128" height="22" fill="#dc9a30" />
                    <text x="214" y="262" fontSize="13" fontWeight="700" fill="#12161d" fontFamily="'Pretendard Variable', Pretendard, sans-serif">
                      {"바닥 물고임 0.88"}
                    </text>
                  </g>
                  <path d="M320 172v14M313 179h14" stroke="#E6EBEF" strokeOpacity=".55" strokeWidth="1.5" />
                </svg>)}
                {" "}
                <div style={{"position":"absolute","left":"10px","top":"10px","display":"flex","gap":"6px","flexWrap":"wrap"}}>
                  {" "}
                  <span className="mono" style={{"fontSize":"12px","padding":"4px 8px","borderRadius":"4px","background":"rgba(5,8,10,.72)","color":"#E6EBEF"}}>
                    {v.vlabel ?? <>{"전방 RGB · 15 fps · 지연 "}
                    {iv(v.vidLag)}</>}
                  </span>
                  {" "}
                </div>
                {" "}
                <div style={{"position":"absolute","right":"10px","top":"10px","display":"flex","alignItems":"center","gap":"6px","fontSize":"12px","padding":"4px 8px","borderRadius":"4px","background":"rgba(5,8,10,.72)","color":"#E6EBEF","visibility":v.recHide ? "hidden" : undefined}}>
                  <span style={{"width":"8px","height":"8px","borderRadius":"50%","background":"#e56d5e"}} />
                  {"기록 중"}
                </div>
                {" "}
                <div style={{"position":"absolute","left":"10px","bottom":"10px","display":"flex","gap":"6px"}}>
                  {" "}
                  <button {...v.frontP} style={{"height":"32px","padding":"0 10px","border":"1px solid rgba(230,235,239,.35)","borderRadius":"4px","background":"rgba(5,8,10,.72)","color":"#E6EBEF","fontSize":"12px"}}>
                    {"전방"}
                  </button>
                  {" "}
                  <button {...v.depthP} style={{"height":"32px","padding":"0 10px","border":"1px solid transparent","borderRadius":"4px","background":"rgba(5,8,10,.45)","color":"#C9D1D8","fontSize":"12px"}}>
                    {"뎁스"}
                  </button>
                  {" "}
                  <button {...v.shotP} style={{"height":"32px","padding":"0 10px","border":"1px solid transparent","borderRadius":"4px","background":"rgba(5,8,10,.45)","color":"#C9D1D8","fontSize":"12px"}}>
                    {"사진 찍기"}
                  </button>
                  {" "}
                </div>
                {" "}
                <button aria-label="영상 크게 보기" {...v.bigP} style={{"position":"absolute","right":"10px","bottom":"10px","width":"32px","height":"32px","border":"0","borderRadius":"4px","background":"rgba(5,8,10,.72)","color":"#E6EBEF","display":"grid","placeItems":"center"}}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
                  </svg>
                </button>
                {" "}
                {v.isLost ? (<>
                  {" "}
                  <div style={{"position":"absolute","inset":"0","background":"rgba(40,46,52,.78)","display":"flex","flexDirection":"column","alignItems":"center","justifyContent":"center","gap":"6px","color":"#FFFFFF"}}>
                    {" "}
                    <span style={{"fontWeight":"700","fontSize":"18px"}}>
                      {"영상 멎음"}
                    </span>
                    {" "}
                    <span className="mono" style={{"fontSize":"13px"}}>
                      {"마지막 수신 10:46:02 · 8초 전"}
                    </span>
                    {" "}
                  </div>
                  {" "}
                </>) : null}
                {v.bigbar ?? null}
              </div>
              {" "}
              <div style={{"display":"flex","flexWrap":"wrap","gap":"8px","alignItems":"center"}}>
                {" "}
                <button className="btn" {...v.b1P}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <path d="M8 5v14M16 5v14" />
                  </svg>
                  {v.b1T ?? "일시정지"}
                </button>
                {" "}
                <button className="btn" {...v.b2P}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <circle cx="12" cy="12" r="8" />
                    <circle cx="12" cy="12" r="2.5" />
                  </svg>
                  {v.b2T ?? "직접 조종"}
                </button>
                {v.b2Help ?? null}
                {" "}
                <button className="btn" {...v.b3P}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <path d="M3 11l9-7 9 7" />
                    <path d="M6 10v9h12v-9" />
                  </svg>
                  {v.b3T ?? "복귀"}
                </button>
                {" "}
                <div style={{"flex":"1"}} />
                {" "}
                <span style={{"fontSize":"12px","color":"var(--muted)"}}>
                  {v.motionNode ?? iv(v.motion)}
                </span>
                {" "}
              </div>
              {v.drive ?? null}
              {" "}
              {v.panelAsk ? (<>
                {" "}
                <div style={{"background":"var(--panel)","border":"1px solid var(--line)","borderRadius":"10px","padding":"12px","display":"flex","flexDirection":"column","gap":"10px"}}>
                  {" "}
                  <div style={{"display":"flex","alignItems":"center","gap":"8px"}}>
                    <span style={{"fontWeight":"600"}}>
                      {"이 지점에서 할 일"}
                    </span>
                    <span style={{"fontSize":"12px","color":"var(--muted)"}}>
                      {v.askSub ?? "WP3 · 모듈 2개"}
                    </span>
                  </div>
                  {" "}
                  {v.askGrid ?? (<div style={{"display":"grid","gridTemplateColumns":"22px 1fr auto","gap":"8px 10px","alignItems":"center","fontSize":"13px"}}>
                    {" "}
                    <span style={{"color":"var(--ok)","fontWeight":"700"}}>
                      {"✓"}
                    </span>
                    <span>
                      {"도착 판정 · 오차 "}
                      <span className="mono">
                        {"0.3 m"}
                      </span>
                    </span>
                    <span className="mono" style={{"fontSize":"12px","color":"var(--muted)"}}>
                      {"10:45:20"}
                    </span>
                    {" "}
                    <span style={{"color":"var(--ok)","fontWeight":"700"}}>
                      {"✓"}
                    </span>
                    <span>
                      {"사진 · 전방 1장"}
                    </span>
                    <span className="mono" style={{"fontSize":"12px","color":"var(--muted)"}}>
                      {"10:45:24"}
                    </span>
                    {" "}
                    <span style={{"width":"12px","height":"12px","borderRadius":"50%","border":"2.5px solid var(--accent)","justifySelf":"center"}} />
                    <span>
                      <b>
                        {"운영자 확인"}
                      </b>
                      {" · 답을 기다리는 중"}
                    </span>
                    <span className="mono" style={{"fontSize":"12px","color":"var(--accent)"}}>
                      {"0:42"}
                    </span>
                    {" "}
                  </div>)}
                  {" "}
                  {v.askTiles ?? (<div style={{"display":"grid","gridTemplateColumns":"repeat(3,minmax(0,1fr))","gap":"6px"}}>
                    {" "}
                    <div style={{"aspectRatio":"4/3","borderRadius":"6px","background":"#0D1317","border":"1px solid var(--line)"}} />
                    {" "}
                    <div style={{"aspectRatio":"4/3","borderRadius":"6px","background":"#111A1F","border":"1px solid var(--line)"}} />
                    {" "}
                    <div style={{"aspectRatio":"4/3","borderRadius":"6px","background":"#0A1014","border":"2px solid var(--accent)"}} />
                    {" "}
                  </div>)}
                  {" "}
                  <span style={{"fontSize":"11px","color":"var(--muted)"}}>
                    {v.askLbl ?? "이 임무의 사진 · WP1 · WP2 · WP3(방금)"}
                  </span>
                  {v.askActs ?? null}
                  {" "}
                </div>
                {" "}
              </>) : null}
              {" "}
              {v.panelDet ? (<>
                {" "}
                <div style={{"background":"var(--panel)","border":"1px solid var(--line)","borderRadius":"10px","padding":"12px","display":"flex","flexDirection":"column","gap":"8px"}}>
                  {" "}
                  <div style={{"display":"flex","alignItems":"center","gap":"8px"}}>
                    <span style={{"fontWeight":"600"}}>
                      {"AI 탐지"}
                    </span>
                    <span style={{"fontSize":"12px","color":"var(--muted)"}}>
                      {"사람 · 연기 · 문 열림 · 물고임 · 0.6 이상"}
                    </span>
                  </div>
                  {" "}
                  <div style={{"display":"grid","gridTemplateColumns":"repeat(4,minmax(0,1fr))","gap":"6px","textAlign":"center"}}>
                    {" "}
                    <div style={{"padding":"8px 4px","border":"1px solid var(--line)","borderRadius":"6px","background":"var(--panel2)"}}>
                      <div className="mono" style={{"fontSize":"20px","fontWeight":"600"}}>
                        {iv(v.detPerson)}
                      </div>
                      <div style={{"fontSize":"11px","color":"var(--muted)"}}>
                        {"사람"}
                      </div>
                    </div>
                    {" "}
                    <div style={{"padding":"8px 4px","border":"1px solid var(--line)","borderRadius":"6px","background":"var(--panel2)"}}>
                      <div className="mono" style={{"fontSize":"20px","fontWeight":"600"}}>
                        {"0"}
                      </div>
                      <div style={{"fontSize":"11px","color":"var(--muted)"}}>
                        {"연기"}
                      </div>
                    </div>
                    {" "}
                    <div style={{"padding":"8px 4px","border":"1px solid var(--line)","borderRadius":"6px","background":"var(--panel2)"}}>
                      <div className="mono" style={{"fontSize":"20px","fontWeight":"600"}}>
                        {"1"}
                      </div>
                      <div style={{"fontSize":"11px","color":"var(--muted)"}}>
                        {"문 열림"}
                      </div>
                    </div>
                    {" "}
                    <div style={{"padding":"8px 4px","border":"1px solid var(--warn)","borderRadius":"6px","background":"var(--warn-bg)"}}>
                      <div className="mono" style={{"fontSize":"20px","fontWeight":"600","color":"var(--warn)"}}>
                        {"1"}
                      </div>
                      <div style={{"fontSize":"11px","color":"var(--muted)"}}>
                        {"물고임"}
                      </div>
                    </div>
                    {" "}
                  </div>
                  {" "}
                  <div style={{"display":"grid","gridTemplateColumns":"64px 1fr auto","gap":"10px","alignItems":"center","padding":"8px","border":"1px solid var(--warn)","borderRadius":"8px"}}>
                    {" "}
                    <div style={{"aspectRatio":"4/3","borderRadius":"4px","background":"#0D1317","border":"1.5px solid var(--warn)"}} />
                    {" "}
                    <div style={{"display":"flex","flexDirection":"column","gap":"2px"}}>
                      <b style={{"fontSize":"13px"}}>
                        {"바닥 물고임 · 0.88"}
                      </b>
                      <span style={{"fontSize":"12px","color":"var(--muted)"}}>
                        {"펌프실 A · 확인 대기"}
                      </span>
                    </div>
                    {" "}
                    <div style={{"display":"flex","gap":"4px"}}>
                      <button className="btn" style={{"height":"36px","padding":"0 10px","fontSize":"12px"}}>
                        {"맞음"}
                      </button>
                      <button className="btn" style={{"height":"36px","padding":"0 10px","fontSize":"12px"}}>
                        {"오탐"}
                      </button>
                    </div>
                    {" "}
                  </div>
                  {" "}
                </div>
                {" "}
              </>) : null}
              {" "}
              {v.panelGas ? (<>
                {" "}
                <div style={{"background":"var(--panel)","border":"1px solid var(--line)","borderRadius":"10px","padding":"12px","display":"flex","flexDirection":"column","gap":"10px"}}>
                  {" "}
                  <div style={{"display":"flex","alignItems":"center","gap":"8px"}}>
                    {" "}
                    <span style={{"fontWeight":"600"}}>
                      {"가스 측정"}
                    </span>
                    {" "}
                    <span style={{"fontSize":"12px","color":"var(--muted)"}}>
                      {iv(v.gasSrc)}
                    </span>
                    {" "}
                    <div style={{"flex":"1"}} />
                    {" "}
                    <a href="#/PcSettings" style={{"fontSize":"12px","color":"var(--accent)"}}>
                      {"기준 설정"}
                    </a>
                    {" "}
                  </div>
                  {" "}
                  <div style={{"display":"grid","gridTemplateColumns":"repeat(auto-fit,minmax(min(124px,100%),1fr))","gap":"8px"}}>
                    {" "}
                    {arr(v.tiles).map((g: any, i10: number) => (<Fragment key={i10}>
                      {" "}
                      <div className={`tile ${str(g?.st)}` as any}>
                        {" "}
                        <div style={{"display":"flex","justifyContent":"space-between","alignItems":"baseline","gap":"6px"}}>
                          <span style={{"fontWeight":"600","fontSize":"14px"}}>
                            {iv(g?.name)}
                          </span>
                          <span className="stl">
                            {iv(g?.stLabel)}
                          </span>
                        </div>
                        {" "}
                        <div style={{"display":"flex","alignItems":"baseline","gap":"4px"}}>
                          <span className="mono val" style={{"fontSize":"26px","fontWeight":"600","letterSpacing":"-.02em"}}>
                            {iv(g?.val)}
                          </span>
                          <span style={{"fontSize":"12px","color":"var(--muted)"}}>
                            {iv(g?.unit)}
                          </span>
                        </div>
                        {" "}
                        <div className="track">
                          {" "}
                          {arr(g?.segs).map((sg: any, i13: number) => (<Fragment key={i13}>
                            <div className={`seg ${str(sg?.c)}` as any} style={css(`left: ${str(sg?.l)}; width: ${str(sg?.w)}`)} />
                          </Fragment>))}
                          {" "}
                          <div className="mark" style={css(`left: ${str(g?.mk)}`)} />
                          {" "}
                        </div>
                        {" "}
                        <svg className="spark" viewBox="0 0 100 24" preserveAspectRatio="none" style={{"width":"100%","height":"20px"}} aria-hidden="true">
                          <polyline points={`${str(g?.spark)}` as any} fill="none" stroke="currentColor" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
                        </svg>
                        {" "}
                        <span style={{"fontSize":"11px","color":"var(--muted)","lineHeight":"1.3"}}>
                          {iv(g?.limit)}
                        </span>
                        {" "}
                      </div>
                      {" "}
                    </Fragment>))}
                    {" "}
                  </div>
                  {" "}
                </div>
                {" "}
              </>) : null}
              {" "}
              <div style={{"background":"var(--panel)","border":"1px solid var(--line)","borderRadius":"10px","padding":"12px 12px 4px","display":"flex","flexDirection":"column"}}>
                {" "}
                <div style={{"display":"flex","alignItems":"center","gap":"8px","paddingBottom":"8px"}}>
                  {" "}
                  <span style={{"fontWeight":"600"}}>
                    {"사건 기록"}
                  </span>
                  {" "}
                  <div style={{"flex":"1"}} />
                  {" "}
                  <a href={v.evHref ?? "#/PcReview"} style={{"fontSize":"12px","color":"var(--accent)"}}>
                    {iv(v.evLink)}
                  </a>
                  {" "}
                </div>
                {" "}
                {arr(v.events).map((e: any, i8: number) => (<Fragment key={i8}>
                  {" "}
                  <div className="ev">
                    <span className="mono" style={{"color":"var(--muted)","fontSize":"12px"}}>
                      {iv(e?.t)}
                    </span>
                    <span className={`em ${str(e?.st)}` as any}>
                      {iv(e?.mark)}
                    </span>
                    <span>
                      {iv(e?.text)}
                    </span>
                  </div>
                  {" "}
                </Fragment>))}
                {" "}
              </div>
              {" "}
            </section>
            {" "}
          </main>
          {" "}
        </div>
        {" "}
      </div>
    </>
  );
}
