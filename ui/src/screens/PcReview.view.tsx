// 생성: scripts/dc2tsx.mjs ← web/PcReview.dc.html (시각 원본). 생성 뒤 손으로 실데이터 연결 — 다시 생성해 덮지 않는다.
/* eslint-disable */
import { Fragment } from 'react';
import { arr, css, fn, iv, ivs, str } from '../dc/jsx';
import { BrandLogo } from '../app/BrandLogo';   // 공식 로고(브랜드 변경)

export const PREVIEW = {"width":1440,"height":1060};
export const FONTS = ["https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap"];
export const CSS = "\nbody{margin:0}\n.fh{--bg:#0B0E11;--panel:#12171C;--panel2:#182028;--line:#26313A;--line2:#34424D;--text:#E6EBEF;--muted:#9AA7B3;--accent:#38C6D9;--on-accent:#061014;--ok:#5AA9FF;--warn:#FFB547;--bad:#FF5A52;--bad-strong:#B3261E;--stop:#D7261E;--map:#0E1317;--wall:#4C5A66;--bad-bg:rgba(255,90,82,.13);--warn-bg:rgba(255,181,71,.12);--ok-bg:rgba(90,169,255,.10);--acc-bg:rgba(56,198,217,.12);font-family:'IBM Plex Sans KR',system-ui,sans-serif;color:var(--text);background:var(--bg);-webkit-font-smoothing:antialiased}\n.fh.light{--bg:#EDEFEA;--panel:#FFFFFF;--panel2:#F5F6F2;--line:#D7DBD3;--line2:#C2C8BF;--text:#12171C;--muted:#4F5A64;--accent:#006D7A;--on-accent:#FFFFFF;--ok:#1F5FBF;--warn:#9A5800;--bad:#B3261E;--bad-strong:#B3261E;--stop:#C8201A;--map:#F8F9F5;--wall:#7C8790;--bad-bg:rgba(179,38,30,.08);--warn-bg:rgba(154,88,0,.09);--ok-bg:rgba(31,95,191,.08);--acc-bg:rgba(0,109,122,.08)}\n.mono{font-family:'JetBrains Mono',ui-monospace,monospace;font-variant-numeric:tabular-nums}\nbutton,input,textarea{font:inherit;color:inherit}\nbutton{cursor:pointer}\n.card{background:var(--panel);border:1px solid var(--line);border-radius:10px}\n.btn{height:44px;padding:0 16px;border:1px solid var(--line2);background:var(--panel2);border-radius:8px;display:flex;align-items:center;justify-content:center;gap:8px;font-weight:600;font-size:14px}\n.btn.pri{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}\n.lbl{font-size:12px;color:var(--muted)}\n.tab{height:34px;padding:0 12px;border:1px solid var(--line);border-radius:999px;background:transparent;font-size:13px;color:var(--muted)}\n.tab[aria-selected=\"true\"]{background:var(--acc-bg);border-color:var(--accent);color:var(--text)}\n.fd{display:grid;grid-template-columns:88px 1fr;gap:10px;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--panel2);text-align:left;width:100%}\n.fd.sel{border-color:var(--accent);background:var(--acc-bg)}\n.badge{font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;white-space:nowrap}\n.b-wait{background:var(--warn-bg);color:var(--warn);border:1px solid var(--warn)}\n.b-ok{background:var(--ok-bg);color:var(--ok);border:1px solid var(--ok)}\n.b-no{background:transparent;color:var(--muted);border:1px solid var(--line2)}\ntable{border-collapse:collapse;width:100%;font-size:13px}\nth{font-size:12px;font-weight:600;color:var(--muted);text-align:right;padding:10px 12px;border-bottom:1px solid var(--line2);white-space:nowrap}\nth:first-child,td:first-child{text-align:left}\ntd{padding:10px 12px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}\ntd.l{text-align:left}\n.v-bad{color:var(--bad);font-weight:700}\n.v-warn{color:var(--warn);font-weight:600}\n.nav{display:flex;flex-direction:column;align-items:center;gap:4px;width:64px;padding:10px 0;border-radius:8px;font-size:11px;color:var(--muted);text-decoration:none}\n.nav:hover{color:var(--text);background:var(--panel2)}\n.nav.cur{color:var(--text);background:var(--acc-bg)}\n.nav.cur svg{color:var(--accent)}\n/* 승인 수정(10-12): PC 머리줄(STOP 포함)은 스크롤해도 화면 위에 남는다 — 불투명 배경(--panel)이 아래 내용을 가린 채 위에 놓임 */\nheader{position:sticky;top:0;z-index:10}\n";
/** 원본 틀이 읽는 값 이름 */
export type Vals = { themeClass?: any; [k: string]: any };

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
          <div style={{"display":"flex","flexDirection":"column","gap":"2px"}}>
            {" "}
            <span style={{"fontSize":"12px","color":"var(--muted)"}}>
              {v.hdrA ?? (<>{"기록 · "}
              <span className="mono">
                {"2026-10-12 10:31–10:52"}
              </span>
              {" · 운영자 A"}</>)}
            </span>
            {" "}
            <span style={{"fontSize":"17px","fontWeight":"600"}}>
              {v.hdrB ?? "지하 펌프실 진입 전 사전 측정"}
            </span>
            {" "}
          </div>
          {" "}
          <div style={{"flex":"1"}} />
          {" "}
          {v.status ?? null}
          <button aria-label="비상 정지" {...v.stopProps} style={{"height":"52px","minWidth":"136px","padding":"0 18px","border":"0","borderRadius":"8px","background":"var(--stop)","color":"#FFFFFF","display":"flex","alignItems":"center","gap":"10px","boxShadow":"0 0 0 3px rgba(215,38,30,.22)"}}>
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
                {"스페이스 · 명령 0·잠금"}
              </span>
            </span>
            {" "}
          </button>
          {" "}
        </header>
        {" "}
        <div style={{"flex":"1","display":"flex","flexWrap":"wrap","minHeight":"0"}}>
          {" "}
          <nav aria-label="주 메뉴" style={{"flex":"0 0 76px","display":"flex","flexDirection":"column","alignItems":"center","gap":"4px","padding":"12px 6px","borderRight":"1px solid var(--line)","background":"var(--panel)"}}>
            {" "}
            <a className="nav" href="#/Fleet">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <circle cx="12" cy="12" r="8" />
                <circle cx="12" cy="12" r="3" />
                <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
              </svg>
              {"관제"}
            </a>
            {" "}
            <a className="nav" href="#/PcPlan">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <path d="M4 19l5-14 5 9 3-4 3 9" />
                <circle cx="9" cy="5" r="1.5" />
              </svg>
              {"임무"}
            </a>
            {" "}
            <a className="nav cur" href="#/PcHistory" aria-current="page">
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
          <main style={{"flex":"999 1 600px","minWidth":"0","display":"flex","flexDirection":"column","gap":"12px","padding":"12px"}}>
            {" "}
            <section aria-label="판정 요약" className="card" style={{"display":"flex","flexWrap":"wrap","alignItems":"center","gap":"16px 28px","padding":"16px 20px"}}>
              {" "}
              <div style={{"display":"flex","flexDirection":"column","gap":"4px"}}>
                {" "}
                <span className="lbl">
                  {v.sL ?? "임무 결과 · 양식: 가스 사전 측정"}
                </span>
                {" "}
                <span style={{"fontSize":"22px","fontWeight":"700","color":"var(--bad)",...v.sBigS}}>
                  {v.sBig ?? "■ 진입 불가 · H₂S 기준 초과"}
                </span>
                {" "}
                <span style={{"fontSize":"13px","color":"var(--muted)"}}>
                  {v.sDesc ?? (<>{"WP3 집수정에서 "}
                  <span className="mono">
                    {"12.4 ppm"}
                  </span>
                  {" (기준 10 ppm 미만) · 환기 후 재측정 필요"}</>)}
                </span>
                {" "}
              </div>
              {" "}
              <div style={{"display":"flex","flexWrap":"wrap","gap":"24px"}}>
                {v.stats ?? (<>
                {" "}
                <div style={{"display":"flex","flexDirection":"column","gap":"2px"}}>
                  <span className="lbl">
                    {"소요"}
                  </span>
                  <span className="mono" style={{"fontSize":"20px","fontWeight":"600"}}>
                    {"21분"}
                  </span>
                </div>
                {" "}
                <div style={{"display":"flex","flexDirection":"column","gap":"2px"}}>
                  <span className="lbl">
                    {"이동"}
                  </span>
                  <span className="mono" style={{"fontSize":"20px","fontWeight":"600"}}>
                    {"112 m"}
                  </span>
                </div>
                {" "}
                <div style={{"display":"flex","flexDirection":"column","gap":"2px"}}>
                  <span className="lbl">
                    {"측정 지점"}
                  </span>
                  <span className="mono" style={{"fontSize":"20px","fontWeight":"600"}}>
                    {"3 / 4"}
                  </span>
                </div>
                {" "}
                <div style={{"display":"flex","flexDirection":"column","gap":"2px"}}>
                  <span className="lbl">
                    {"발견물"}
                  </span>
                  <span className="mono" style={{"fontSize":"20px","fontWeight":"600"}}>
                    {"3"}
                  </span>
                </div>
                {" "}
                <div style={{"display":"flex","flexDirection":"column","gap":"2px"}}>
                  <span className="lbl">
                    {"경보"}
                  </span>
                  <span className="mono" style={{"fontSize":"20px","fontWeight":"600","color":"var(--bad)"}}>
                    {"1"}
                  </span>
                </div>
                {" "}
                </>)}
              </div>
              {" "}
              <div style={{"flex":"1"}} />
              {" "}
              <div style={{"display":"flex","flexWrap":"wrap","gap":"8px"}}>
                {" "}
                <button className="btn" {...v.csvP}>
                  {v.csvT ?? "원자료 내려받기 (CSV)"}
                </button>
                {" "}
                <a href="#/Report" className="btn pri" style={{"textDecoration":"none"}} {...v.repP}>
                  {v.repT ?? "측정 기록 보고서 만들기"}
                </a>
                {" "}
              </div>
              {" "}
            </section>
            {" "}
            <div style={{"display":"flex","flexWrap":"wrap","gap":"12px","alignItems":"flex-start"}}>
              {" "}
              <section aria-label="발견물 목록" className="card" style={{"flex":"1 1 320px","maxWidth":"400px","minWidth":"0","padding":"14px","display":"flex","flexDirection":"column","gap":"10px"}}>
                {" "}
                <div style={{"display":"flex","alignItems":"center","gap":"8px"}}>
                  <span style={{"fontWeight":"600"}}>
                    {v.lhA ?? "발견물"}
                  </span>
                  <span className="lbl">
                    {v.lhB ?? "AI 탐지 결과는 사람이 확인해야 기록에 들어갑니다"}
                  </span>
                </div>
                {" "}
                <div role="tablist" aria-label="발견물 거르기" style={{"display":"flex","flexWrap":"wrap","gap":"6px"}}>
                  {v.tabs ?? (<>
                  {" "}
                  <button className="tab" role="tab" aria-selected="false">
                    {"전체 3"}
                  </button>
                  {" "}
                  <button className="tab" role="tab" aria-selected="true">
                    {"확인 대기 1"}
                  </button>
                  {" "}
                  <button className="tab" role="tab" aria-selected="false">
                    {"맞음 1"}
                  </button>
                  {" "}
                  <button className="tab" role="tab" aria-selected="false">
                    {"오탐 1"}
                  </button>
                  {" "}
                  </>)}
                </div>
                {" "}
                {v.fds ?? (<>
                <button className="fd sel">
                  {" "}
                  <svg viewBox="0 0 88 66" style={{"width":"88px","height":"66px","borderRadius":"6px","background":"#0D1317"}} aria-hidden="true">
                    <rect width="88" height="66" fill="#0D1317" />
                    <polygon points="0,66 88,66 58,34 30,34" fill="#151E24" />
                    <ellipse cx="44" cy="54" rx="22" ry="5" fill="#2A4250" />
                    <rect x="18" y="44" width="52" height="18" fill="none" stroke="#FFB547" strokeWidth="1.5" />
                  </svg>
                  {" "}
                  <span style={{"display":"flex","flexDirection":"column","gap":"4px","minWidth":"0"}}>
                    <span style={{"display":"flex","justifyContent":"space-between","gap":"6px"}}>
                      <b style={{"fontSize":"14px"}}>
                        {"바닥 물고임"}
                      </b>
                      <span className="badge b-wait">
                        {"확인 대기"}
                      </span>
                    </span>
                    <span className="lbl">
                      {"WP2 펌프실 A · "}
                      <span className="mono">
                        {"10:39:51"}
                      </span>
                    </span>
                    <span className="lbl">
                      {"신뢰도 "}
                      <span className="mono">
                        {"0.88"}
                      </span>
                      {" · 미끄럼 위험"}
                    </span>
                  </span>
                  {" "}
                </button>
                {" "}
                <button className="fd">
                  {" "}
                  <svg viewBox="0 0 88 66" style={{"width":"88px","height":"66px","borderRadius":"6px","background":"#0D1317"}} aria-hidden="true">
                    <rect width="88" height="66" fill="#0D1317" />
                    <rect x="0" y="20" width="88" height="10" fill="#2C3A44" />
                    <rect x="40" y="18" width="20" height="14" fill="#56473A" />
                    <rect x="36" y="14" width="28" height="22" fill="none" stroke="#5AA9FF" strokeWidth="1.5" />
                  </svg>
                  {" "}
                  <span style={{"display":"flex","flexDirection":"column","gap":"4px","minWidth":"0"}}>
                    <span style={{"display":"flex","justifyContent":"space-between","gap":"6px"}}>
                      <b style={{"fontSize":"14px"}}>
                        {"배관 보온재 손상"}
                      </b>
                      <span className="badge b-ok">
                        {"맞음"}
                      </span>
                    </span>
                    <span className="lbl">
                      {"WP2 펌프실 A · "}
                      <span className="mono">
                        {"10:40:12"}
                      </span>
                    </span>
                    <span className="lbl">
                      {"신뢰도 "}
                      <span className="mono">
                        {"0.74"}
                      </span>
                      {" · 확인 운영자 A"}
                    </span>
                  </span>
                  {" "}
                </button>
                {" "}
                <button className="fd">
                  {" "}
                  <svg viewBox="0 0 88 66" style={{"width":"88px","height":"66px","borderRadius":"6px","background":"#0D1317"}} aria-hidden="true">
                    <rect width="88" height="66" fill="#0D1317" />
                    <rect x="36" y="16" width="14" height="40" fill="#222C33" />
                    <rect x="32" y="12" width="22" height="48" fill="none" stroke="#9AA7B3" strokeWidth="1.5" strokeDasharray="3 2" />
                  </svg>
                  {" "}
                  <span style={{"display":"flex","flexDirection":"column","gap":"4px","minWidth":"0"}}>
                    <span style={{"display":"flex","justifyContent":"space-between","gap":"6px"}}>
                      <b style={{"fontSize":"14px"}}>
                        {"사람 형상"}
                      </b>
                      <span className="badge b-no">
                        {"오탐"}
                      </span>
                    </span>
                    <span className="lbl">
                      {"복도 · "}
                      <span className="mono">
                        {"10:43:30"}
                      </span>
                    </span>
                    <span className="lbl">
                      {"신뢰도 "}
                      <span className="mono">
                        {"0.41"}
                      </span>
                      {" · 세워 둔 사다리"}
                    </span>
                  </span>
                  {" "}
                </button>
                {" "}
                </>)}
              </section>
              {" "}
              <section aria-label="선택한 발견물" className="card" style={{"flex":"999 1 560px","minWidth":"0","padding":"14px","display":"flex","flexDirection":"column","gap":"12px",...v.scS}}>
                {" "}
                <div style={{"display":"flex","flexWrap":"wrap","alignItems":"center","gap":"8px 12px"}}>
                  {" "}
                  <span style={{"fontSize":"18px","fontWeight":"700"}}>
                    {v.scT ?? "바닥 물고임"}
                  </span>
                  {" "}
                  <span className="badge b-wait" {...v.scBP}>
                    {v.scB ?? "확인 대기"}
                  </span>
                  {" "}
                  <span className="lbl">
                    {v.scL ?? (<>{"WP2 펌프실 A · x 22.6 y 18.1 · 로봇 방향 "}
                    <span className="mono">
                      {"92°"}
                    </span>
                    {" · "}
                    <span className="mono">
                      {"10:39:51"}
                    </span></>)}
                  </span>
                  {" "}
                </div>
                {" "}
                <div style={{"display":"grid","gridTemplateColumns":"repeat(auto-fit,minmax(min(280px,100%),1fr))","gap":"10px"}}>
                  {" "}
                  <figure style={{"margin":"0","display":"flex","flexDirection":"column","gap":"6px"}}>
                    {" "}
                    {v.im1 ?? (<>{v.im2 ?? (<><svg viewBox="0 0 640 360" style={{"width":"100%","height":"auto","borderRadius":"8px","background":"#05080A","display":"block"}} role="img" aria-label="오늘 사진: 펌프 아래 바닥에 넓은 물고임과 탐지 상자">
                      <rect width="640" height="360" fill="#080B0D" />
                      <polygon points="0,360 640,360 470,190 170,190" fill="#141C21" />
                      <circle cx="470" cy="150" r="70" fill="#121A1F" stroke="#2D3A43" strokeWidth="4" />
                      <rect x="430" y="210" width="80" height="40" fill="#0F151A" />
                      <ellipse cx="330" cy="292" rx="150" ry="30" fill="#1D303B" />
                      <ellipse cx="300" cy="286" rx="70" ry="7" fill="#3E5A69" opacity=".6" />
                      <rect x="170" y="252" width="320" height="76" fill="none" stroke="#FFB547" strokeWidth="2.5" />
                      <rect x="170" y="228" width="148" height="24" fill="#FFB547" />
                      <text x="178" y="245" fontSize="14" fontWeight="700" fill="#1A1206" fontFamily="'Pretendard Variable', Pretendard, sans-serif">
                        {"바닥 물고임 0.88"}
                      </text>
                    </svg></>)}</>)}
                    {" "}
                    <figcaption className="lbl">
                      {v.c1 ?? "오늘 10:39 · 전방 RGB"}
                    </figcaption>
                    {" "}
                  </figure>
                  {" "}
                  <figure style={{"margin":"0","display":"flex","flexDirection":"column","gap":"6px"}}>
                    {" "}
                    <svg viewBox="0 0 640 360" style={{"width":"100%","height":"auto","borderRadius":"8px","background":"#05080A","display":"block"}} role="img" aria-label="지난 순찰 사진: 같은 위치, 물고임 없음">
                      <rect width="640" height="360" fill="#080B0D" />
                      <polygon points="0,360 640,360 470,190 170,190" fill="#141C21" />
                      <circle cx="470" cy="150" r="70" fill="#121A1F" stroke="#2D3A43" strokeWidth="4" />
                      <rect x="430" y="210" width="80" height="40" fill="#0F151A" />
                      <ellipse cx="300" cy="300" rx="40" ry="8" fill="#1A2830" />
                    </svg>
                    {" "}
                    <figcaption className="lbl">
                      {v.c2 ?? "지난 순찰 10-05 · 같은 위치 비교"}
                    </figcaption>
                    {" "}
                  </figure>
                  {" "}
                </div>
                {" "}
                <div role="group" aria-label="판정" style={{"display":"flex","flexWrap":"wrap","gap":"8px"}}>
                  {" "}
                  <button className="btn pri" style={{"flex":"1 1 160px"}} {...v.j?.[0]}>
                    {v.jT?.[0] ?? "맞음 · 위험 요인으로 기록"}
                  </button>
                  {" "}
                  <button className="btn" style={{"flex":"1 1 120px"}} {...v.j?.[1]}>
                    {v.jT?.[1] ?? "오탐"}
                  </button>
                  {" "}
                  <button className="btn" style={{"flex":"1 1 120px"}} {...v.j?.[2]}>
                    {v.jT?.[2] ?? "다음 순찰 때 다시 보기"}
                  </button>
                  {" "}
                </div>
                {" "}
                <div style={{"display":"flex","flexDirection":"column","gap":"6px"}}>
                  {" "}
                  <label className="lbl" htmlFor="memo">
                    {v.memoL ?? "메모 · 보고서에 함께 실립니다"}
                  </label>
                  {" "}
                  {v.memo ?? <textarea defaultValue={"펌프 B 씰 누수 의심. 진입 시 미끄럼 주의 표지 필요."} id="memo" rows={2} style={{"padding":"10px 12px","border":"1px solid var(--line2)","borderRadius":"6px","background":"var(--panel2)","fontSize":"14px","resize":"vertical"}} />}
                  {v.msg ?? null}
                  {" "}
                </div>
                {" "}
                <div style={{"display":"flex","flexDirection":"column","gap":"8px","paddingTop":"4px"}}>
                  {" "}
                  <div style={{"display":"flex","justifyContent":"space-between"}} className="lbl">
                    <span>
                      {v.rewA ?? "임무 되감기"}
                    </span>
                    <span className="mono">
                      {v.rewB ?? "10:39:51 / 10:52:40"}
                    </span>
                  </div>
                  {" "}
                  {v.rewHide ? null : (<><div style={{"position":"relative","height":"28px"}}>
                    {" "}
                    <div style={{"position":"absolute","left":"0","right":"0","top":"12px","height":"4px","borderRadius":"2px","background":"var(--line)"}} />
                    {" "}
                    <div style={{"position":"absolute","left":"0","width":"41%","top":"12px","height":"4px","borderRadius":"2px","background":"var(--accent)"}} />
                    {" "}
                    <span style={{"position":"absolute","left":"10%","top":"8px","width":"10px","height":"10px","borderRadius":"50%","background":"var(--ok)"}} />
                    {" "}
                    <span style={{"position":"absolute","left":"39%","top":"8px","width":"10px","height":"10px","transform":"rotate(45deg)","background":"var(--warn)"}} />
                    {" "}
                    <span style={{"position":"absolute","left":"42%","top":"8px","width":"10px","height":"10px","transform":"rotate(45deg)","background":"var(--warn)"}} />
                    {" "}
                    <span style={{"position":"absolute","left":"70%","top":"8px","width":"10px","height":"10px","transform":"rotate(45deg)","background":"var(--muted)"}} />
                    {" "}
                    <span style={{"position":"absolute","left":"84%","top":"7px","width":"12px","height":"12px","background":"var(--bad)"}} />
                    {" "}
                    <span style={{"position":"absolute","left":"41%","top":"4px","width":"4px","height":"20px","borderRadius":"2px","background":"var(--text)","transform":"translateX(-2px)"}} />
                    {" "}
                  </div></>)}
                  {" "}
                </div>
                {" "}
              </section>
              {" "}
            </div>
            {" "}
            <section aria-label="측정 기록" className="card" style={{"padding":"14px 0 6px"}}>
              {" "}
              <div style={{"display":"flex","flexWrap":"wrap","alignItems":"baseline","gap":"6px 12px","padding":"0 16px 10px"}}>
                {" "}
                <span style={{"fontWeight":"600"}}>
                  {"측정 기록"}
                </span>
                {" "}
                <span className="lbl">
                  {v.msLbl ?? (<>{"원격 측정 · 로봇 탑재 4종 검지기 + CO₂ · 범프 테스트 10:20 · 보존 기한 "}
                  <span className="mono">
                    {"2029-10-12"}
                  </span></>)}
                </span>
                {" "}
              </div>
              {" "}
              <div style={{"overflowX":"auto"}}>
                {" "}
                <table>
                  <thead>
                    <tr>
                      <th>
                        {"지점"}
                      </th>
                      <th>
                        {"측정 시각"}
                      </th>
                      <th>
                        {"O₂ %"}
                      </th>
                      <th>
                        {"H₂S ppm"}
                      </th>
                      <th>
                        {"CO ppm"}
                      </th>
                      <th>
                        {"LEL %"}
                      </th>
                      <th>
                        {"CO₂ %"}
                      </th>
                      <th style={{"textAlign":"left"}}>
                        {"판정"}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {v.mRows ?? (<>
                    <tr>
                      <td>
                        {"WP1 계단실 하부"}
                      </td>
                      <td className="mono">
                        {"10:33:20"}
                      </td>
                      <td className="mono">
                        {"20.9"}
                      </td>
                      <td className="mono">
                        {"0.0"}
                      </td>
                      <td className="mono">
                        {"2"}
                      </td>
                      <td className="mono">
                        {"0"}
                      </td>
                      <td className="mono">
                        {"0.08"}
                      </td>
                      <td className="l">
                        <span style={{"color":"var(--ok)"}}>
                          {"●"}
                        </span>
                        {" 적정"}
                      </td>
                    </tr>
                    <tr>
                      <td>
                        {"WP2 펌프실 A"}
                      </td>
                      <td className="mono">
                        {"10:39:44"}
                      </td>
                      <td className="mono">
                        {"20.6"}
                      </td>
                      <td className="mono">
                        {"1.2"}
                      </td>
                      <td className="mono">
                        {"2"}
                      </td>
                      <td className="mono">
                        {"0"}
                      </td>
                      <td className="mono">
                        {"0.12"}
                      </td>
                      <td className="l">
                        <span style={{"color":"var(--ok)"}}>
                          {"●"}
                        </span>
                        {" 적정"}
                      </td>
                    </tr>
                    <tr style={{"background":"var(--bad-bg)"}}>
                      <td>
                        {"WP3 집수정"}
                      </td>
                      <td className="mono">
                        {"10:46:08"}
                      </td>
                      <td className="mono">
                        {"19.6"}
                      </td>
                      <td className="mono v-bad">
                        {"12.4"}
                      </td>
                      <td className="mono">
                        {"4"}
                      </td>
                      <td className="mono">
                        {"2"}
                      </td>
                      <td className="mono">
                        {"0.34"}
                      </td>
                      <td className="l" style={{"color":"var(--bad)","fontWeight":"700"}}>
                        {"■ 부적정 · H₂S"}
                      </td>
                    </tr>
                    <tr>
                      <td>
                        {"WP4 배관 구역"}
                      </td>
                      <td className="mono">
                        {"—"}
                      </td>
                      <td className="mono">
                        {"—"}
                      </td>
                      <td className="mono">
                        {"—"}
                      </td>
                      <td className="mono">
                        {"—"}
                      </td>
                      <td className="mono">
                        {"—"}
                      </td>
                      <td className="mono">
                        {"—"}
                      </td>
                      <td className="l" style={{"color":"var(--muted)"}}>
                        {"측정 안 함 · 경보로 중단"}
                      </td>
                    </tr>
                    </>)}
                  </tbody>
                </table>
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
      {" "}
    </>
  );
}
