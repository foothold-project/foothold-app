// 생성: scripts/dc2tsx.mjs ← web/MMap.dc.html (시각 원본). 생성 뒤 손으로 실데이터 연결 — 다시 생성해 덮지 않는다.
/* eslint-disable */
import { Fragment } from 'react';
import { arr, css, fn, iv, ivs, str } from '../dc/jsx';

export const PREVIEW = {"width":390,"height":844};
export const FONTS = ["https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap"];
export const CSS = "\nbody{margin:0}\n.fh{--bg:#0B0E11;--panel:#12171C;--panel2:#182028;--line:#26313A;--line2:#34424D;--text:#E6EBEF;--muted:#9AA7B3;--accent:#38C6D9;--on-accent:#061014;--ok:#5AA9FF;--warn:#FFB547;--bad:#FF5A52;--stop:#D7261E;--map:#0E1317;--wall:#4C5A66;--gridc:rgba(154,167,179,.07);font-family:'IBM Plex Sans KR',system-ui,sans-serif;color:var(--text);background:var(--bg);-webkit-font-smoothing:antialiased}\n.fh.light{--bg:#EDEFEA;--panel:#FFFFFF;--panel2:#F5F6F2;--line:#D7DBD3;--line2:#C2C8BF;--text:#12171C;--muted:#4F5A64;--accent:#006D7A;--on-accent:#FFFFFF;--ok:#1F5FBF;--warn:#9A5800;--bad:#B3261E;--stop:#C8201A;--map:#F8F9F5;--wall:#7C8790;--gridc:rgba(18,23,28,.06)}\n.mono{font-family:'JetBrains Mono',ui-monospace,monospace;font-variant-numeric:tabular-nums}\nbutton{font:inherit;color:inherit;cursor:pointer}\n.lbl{font-size:12px;color:var(--muted)}\n.tabb{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;height:52px;font-size:11px;color:var(--muted);text-decoration:none}\n.tabb.cur{color:var(--accent);font-weight:600}\n.fab{width:44px;height:44px;border-radius:10px;border:1px solid var(--line2);background:var(--panel);display:grid;place-items:center}\n";
/** 원본 틀이 읽는 값 이름 */
export type Vals = { themeClass?: any };

export function View({ v }: { v: Vals }) {
  return (
    <>
      {" "}
      {" "}
      <div className={`${str(v.themeClass)}` as any} style={{"width":"390px","height":"844px","boxSizing":"border-box","display":"flex","flexDirection":"column","overflow":"hidden"}}>
        {" "}
        <header style={{"display":"flex","alignItems":"center","gap":"10px","padding":"14px 16px 10px"}}>
          {" "}
          <div style={{"display":"flex","flexDirection":"column","gap":"2px","flex":"1"}}>
            {" "}
            <span style={{"fontSize":"18px","fontWeight":"700"}}>
              {"지도"}
            </span>
            {" "}
            <span className="lbl">
              {"B1 펌프실 v3 · "}
              <span style={{"color":"var(--ok)"}}>
                {"●"}
              </span>
              {" 위치 신뢰 높음"}
            </span>
            {" "}
          </div>
          {" "}
          <button className="fab" aria-label="지도 레이어">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="M12 3l9 5-9 5-9-5z" />
              <path d="M3 13l9 5 9-5" />
            </svg>
          </button>
          {" "}
        </header>
        {" "}
        <div style={{"position":"relative","margin":"0 16px","border":"1px solid var(--line)","borderRadius":"12px","overflow":"hidden","flex":"1","minHeight":"0"}}>
          {" "}
          <svg viewBox="600 70 380 470" preserveAspectRatio="xMidYMid slice" style={{"position":"absolute","inset":"0","width":"100%","height":"100%"}} role="img" aria-label="지도: 로봇 위치와 새로 찍은 목표, 미리 본 경로">
            <defs>
              <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
                <path d="M20 0H0V20" fill="none" style={{"stroke":"var(--gridc)"}} strokeWidth="1" />
              </pattern>
              <pattern id="hw" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
                <line x1="0" y1="0" x2="0" y2="10" style={{"stroke":"var(--warn)"}} strokeWidth="2" strokeOpacity=".32" />
              </pattern>
            </defs>
            <rect x="0" y="0" width="1000" height="620" style={{"fill":"var(--map)"}} />
            <rect x="0" y="0" width="1000" height="620" fill="url(#grid)" />
            <rect x="690" y="420" width="267" height="157" fill="url(#hw)" />
            <g style={{"stroke":"var(--wall)"}} strokeWidth="6" fill="none" strokeLinecap="square">
              <rect x="40" y="40" width="920" height="540" />
              <path d="M500 300H770M830 300H960M640 40V300M380 380H750M810 380H960M600 380V580" />
            </g>
            <g style={{"stroke":"var(--wall)"}} strokeWidth="2" fill="none" opacity=".8">
              <path d="M660 90H940M660 120H940M660 230H940" />
              <rect x="830" y="470" width="96" height="76" strokeDasharray="6 5" />
            </g>
            <g fontFamily="IBM Plex Sans KR, sans-serif" fontSize="16" style={{"fill":"var(--muted)"}}>
              <text x="660" y="74">
                {"배관 구역"}
              </text>
              <text x="620" y="412">
                {"집수정"}
              </text>
              <text x="660" y="335">
                {"복도"}
              </text>
            </g>
            <polyline points="780,404 780,340 800,340 800,200 880,200 880,176" fill="none" style={{"stroke":"var(--accent)"}} strokeWidth="5" strokeDasharray="10 7" strokeLinejoin="round" />
            <g transform="translate(880 160)">
              <path d="M0 18 C-10 4 -14 -2 -14 -8 A14 14 0 0 1 14 -8 C14 -2 10 4 0 18 Z" style={{"fill":"var(--accent)"}} />
              <circle cy="-8" r="5" style={{"fill":"var(--map)"}} />
            </g>
            <g transform="translate(780 404) rotate(180)">
              <path d="M0 0 L-40 -84 A92 92 0 0 1 40 -84 Z" style={{"fill":"var(--accent)"}} opacity=".14" />
              <circle r="18" style={{"fill":"var(--accent)"}} opacity=".2" />
              <path d="M0 -15 L11 11 L0 5 L-11 11 Z" style={{"fill":"var(--accent)","stroke":"var(--map)"}} strokeWidth="2" />
            </g>
          </svg>
          {" "}
          <div style={{"position":"absolute","right":"10px","top":"10px","display":"flex","flexDirection":"column","gap":"6px"}}>
            {" "}
            <button className="fab" aria-label="로봇 위치로">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <circle cx="12" cy="12" r="3" />
                <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
              </svg>
            </button>
            {" "}
            <button className="fab" aria-label="확대">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
            {" "}
            <button className="fab" aria-label="축소">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M5 12h14" />
              </svg>
            </button>
            {" "}
          </div>
          {" "}
          <span style={{"position":"absolute","left":"10px","top":"10px","fontSize":"12px","padding":"6px 10px","borderRadius":"6px","background":"var(--panel)","border":"1px solid var(--line2)"}}>
            {"지도를 눌러 목표를 고르세요"}
          </span>
          {" "}
        </div>
        {" "}
        <section aria-label="고른 목표" style={{"margin":"10px 16px 0","padding":"14px","border":"1px solid var(--accent)","borderRadius":"12px","background":"var(--panel)","display":"flex","flexDirection":"column","gap":"10px"}}>
          {" "}
          <div style={{"display":"flex","justifyContent":"space-between","alignItems":"baseline","gap":"8px"}}>
            {" "}
            <b style={{"fontSize":"16px"}}>
              {"배관 구역 안쪽"}
            </b>
            {" "}
            <span className="mono lbl">
              {"x 41.2 · y 6.4"}
            </span>
            {" "}
          </div>
          {" "}
          <div style={{"display":"flex","flexWrap":"wrap","gap":"6px 14px","fontSize":"13px"}}>
            {" "}
            <span>
              <span className="lbl">
                {"거리"}
              </span>
              {" "}
              <b className="mono">
                {"19 m"}
              </b>
            </span>
            {" "}
            <span>
              <span className="lbl">
                {"예상"}
              </span>
              {" "}
              <b className="mono">
                {"1분"}
              </b>
            </span>
            {" "}
            <span>
              <span style={{"color":"var(--ok)"}}>
                {"●"}
              </span>
              {" 경로 검사 통과"}
            </span>
            {" "}
          </div>
          {" "}
          <div style={{"display":"grid","gridTemplateColumns":"1fr 2fr","gap":"8px"}}>
            {" "}
            <button style={{"height":"52px","border":"1px solid var(--line2)","borderRadius":"10px","background":"var(--panel2)","fontWeight":"600"}}>
              {"취소"}
            </button>
            {" "}
            <button style={{"height":"52px","border":"0","borderRadius":"10px","background":"var(--accent)","color":"var(--on-accent)","fontWeight":"700","fontSize":"15px"}}>
              {"이 목표로 이동"}
            </button>
            {" "}
          </div>
          {" "}
          <span className="lbl" style={{"textAlign":"center"}}>
            {"지도를 누르기만 해서는 움직이지 않습니다"}
          </span>
          {" "}
        </section>
        {" "}
        <nav aria-label="주 메뉴" style={{"display":"flex","borderTop":"1px solid var(--line)","background":"var(--panel)","marginTop":"10px"}}>
          {" "}
          <a className="tabb" href="MHome.dc.html">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <circle cx="12" cy="12" r="8" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            {"현황"}
          </a>
          {" "}
          <a className="tabb cur" href="MMap.dc.html" aria-current="page">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z" />
            </svg>
            {"지도"}
          </a>
          {" "}
          <a className="tabb" href="MFinding.dc.html">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <rect x="7" y="7" width="10" height="10" transform="rotate(45 12 12)" />
            </svg>
            {"발견물"}
          </a>
          {" "}
          <a className="tabb" href="MHistory.dc.html">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <rect x="5" y="3" width="14" height="18" rx="2" />
              <path d="M9 8h6M9 12h6" />
            </svg>
            {"기록"}
          </a>
          {" "}
        </nav>
        {" "}
        <div style={{"padding":"8px 16px 18px","background":"var(--panel)"}}>
          {" "}
          <button aria-label="비상 정지" style={{"width":"100%","height":"64px","border":"0","borderRadius":"12px","background":"var(--stop)","color":"#FFFFFF","display":"flex","alignItems":"center","justifyContent":"center","gap":"12px"}}>
            {" "}
            <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M8 2h8l6 6v8l-6 6H8l-6-6V8z" fill="none" stroke="#FFFFFF" strokeWidth="2" />
              <rect x="8" y="8" width="8" height="8" fill="#FFFFFF" />
            </svg>
            {" "}
            <span style={{"fontWeight":"700","fontSize":"22px","letterSpacing":".1em"}}>
              {"STOP"}
            </span>
            <span style={{"fontSize":"13px"}}>
              {"전체 정지"}
            </span>
            {" "}
          </button>
          {" "}
        </div>
        {" "}
      </div>
      {" "}
    </>
  );
}
