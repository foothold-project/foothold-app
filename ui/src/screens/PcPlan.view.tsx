// 생성: scripts/dc2tsx.mjs ← web/PcPlan.dc.html (시각 원본). 생성 뒤 손으로 실데이터 연결 — 다시 생성해 덮지 않는다.
/* eslint-disable */
import { Fragment } from 'react';
import { arr, css, fn, iv, ivs, str } from '../dc/jsx';

export const PREVIEW = {"width":1440,"height":1120};
export const FONTS = ["https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap"];
export const CSS = "\nbody{margin:0}\n.fh{--bg:#0B0E11;--panel:#12171C;--panel2:#182028;--line:#26313A;--line2:#34424D;--text:#E6EBEF;--muted:#9AA7B3;--accent:#38C6D9;--on-accent:#061014;--ok:#5AA9FF;--warn:#FFB547;--bad:#FF5A52;--bad-strong:#B3261E;--stop:#D7261E;--map:#0E1317;--wall:#4C5A66;--gridc:rgba(154,167,179,.07);--bad-bg:rgba(255,90,82,.13);--warn-bg:rgba(255,181,71,.12);--ok-bg:rgba(90,169,255,.10);--acc-bg:rgba(56,198,217,.12);font-family:'IBM Plex Sans KR',system-ui,sans-serif;color:var(--text);background:var(--bg);-webkit-font-smoothing:antialiased}\n.fh.light{--bg:#EDEFEA;--panel:#FFFFFF;--panel2:#F5F6F2;--line:#D7DBD3;--line2:#C2C8BF;--text:#12171C;--muted:#4F5A64;--accent:#006D7A;--on-accent:#FFFFFF;--ok:#1F5FBF;--warn:#9A5800;--bad:#B3261E;--bad-strong:#B3261E;--stop:#C8201A;--map:#F8F9F5;--wall:#7C8790;--gridc:rgba(18,23,28,.06);--bad-bg:rgba(179,38,30,.08);--warn-bg:rgba(154,88,0,.09);--ok-bg:rgba(31,95,191,.08);--acc-bg:rgba(0,109,122,.08)}\n.mono{font-family:'JetBrains Mono',ui-monospace,monospace;font-variant-numeric:tabular-nums}\nbutton,input,select{font:inherit;color:inherit}\nbutton{cursor:pointer}\n.chip{display:flex;align-items:center;gap:6px;height:34px;padding:0 10px;border:1px solid var(--line);border-radius:6px;font-size:13px;background:var(--panel2);white-space:nowrap}\n.chip .mk{font-size:11px;color:var(--ok)}\n.btn{height:44px;padding:0 16px;border:1px solid var(--line2);background:var(--panel2);border-radius:8px;display:flex;align-items:center;justify-content:center;gap:8px;font-weight:600;font-size:14px}\n.btn.pri{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}\n.btn.pri[disabled]{background:var(--line);border-color:var(--line);color:var(--muted);cursor:not-allowed}\n.btn.sm{height:34px;padding:0 10px;font-size:13px}\n.tool{height:38px;padding:0 10px;border:1px solid transparent;border-radius:6px;background:transparent;display:flex;align-items:center;gap:6px;font-size:13px;color:var(--muted)}\n.tool[aria-pressed=\"true\"]{background:var(--acc-bg);border-color:var(--accent);color:var(--text)}\n.card{background:var(--panel);border:1px solid var(--line);border-radius:10px}\n.sec{padding:14px 16px;border-top:1px solid var(--line);display:flex;flex-direction:column;gap:10px}\n.sec h3{margin:0;font-size:14px;font-weight:600;display:flex;align-items:center;gap:8px}\n.lbl{font-size:12px;color:var(--muted)}\n.inp{height:40px;padding:0 12px;border:1px solid var(--line2);border-radius:6px;background:var(--panel2);font-size:14px;box-sizing:border-box;width:100%}\n.wp{display:grid;grid-template-columns:18px 28px 1fr auto;gap:10px;align-items:center;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--panel2)}\n.wp.sel{border-color:var(--accent);background:var(--acc-bg)}\n.num{width:26px;height:26px;border-radius:50%;border:2px solid var(--accent);display:grid;place-items:center;font-size:12px;font-weight:700;color:var(--accent)}\n.act{font-size:11px;padding:2px 7px;border-radius:4px;border:1px solid var(--line2);color:var(--muted);white-space:nowrap}\n.opt{display:flex;gap:10px;align-items:flex-start;padding:10px;border:1px solid var(--line);border-radius:8px;font-size:13px;line-height:1.45;cursor:pointer}\n.opt.on{border-color:var(--accent);background:var(--acc-bg)}\n.opt input{margin:3px 0 0;accent-color:var(--accent);width:16px;height:16px}\n.ck{display:grid;grid-template-columns:18px 1fr auto;gap:10px;align-items:center;padding:9px 0;border-top:1px solid var(--line);font-size:13px}\n.ck .m.ok{color:var(--ok)}.ck .m.warn{color:var(--warn)}\n.nav{display:flex;flex-direction:column;align-items:center;gap:4px;width:64px;padding:10px 0;border-radius:8px;font-size:11px;color:var(--muted);text-decoration:none}\n.nav:hover{color:var(--text);background:var(--panel2)}\n.nav.cur{color:var(--text);background:var(--acc-bg)}\n.nav.cur svg{color:var(--accent)}\n/* 승인 수정(10-12): PC 머리줄(STOP 포함)은 스크롤해도 화면 위에 남는다 — 불투명 배경(--panel)이 아래 내용을 가린 채 위에 놓임 */\nheader{position:sticky;top:0;z-index:10}\n";
/** 원본 틀이 읽는 값 이름 */
export type Vals = { themeClass?: any };

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
            <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
              <path d="M3 23 L10 9 L14 16 L18 6 L25 23 Z" fill="none" style={{"stroke":"var(--accent)"}} strokeWidth="2.2" strokeLinejoin="round" />
              <circle cx="18" cy="6" r="2.2" style={{"fill":"var(--accent)"}} />
            </svg>
            {" "}
            <span style={{"fontWeight":"700","letterSpacing":".12em","fontSize":"15px"}}>
              {"FOOTHOLD"}
            </span>
            {" "}
          </div>
          {" "}
          <div style={{"width":"1px","height":"32px","background":"var(--line)"}} />
          {" "}
          <div style={{"display":"flex","flexDirection":"column","gap":"2px"}}>
            {" "}
            <span style={{"fontSize":"12px","color":"var(--muted)"}}>
              {"임무 계획 · 초안 · 마지막 저장 "}
              <span className="mono">
                {"10:24"}
              </span>
            </span>
            {" "}
            <span style={{"fontSize":"17px","fontWeight":"600"}}>
              {"지하 펌프실 진입 전 사전 측정"}
            </span>
            {" "}
          </div>
          {" "}
          <span style={{"height":"26px","padding":"0 10px","borderRadius":"999px","display":"flex","alignItems":"center","fontSize":"12px","fontWeight":"600","background":"var(--panel2)","border":"1px solid var(--line2)","color":"var(--muted)"}}>
            {"대기 · 출발점"}
          </span>
          {" "}
          <div style={{"flex":"1"}} />
          {" "}
          <div style={{"display":"flex","flexWrap":"wrap","gap":"6px"}}>
            {" "}
            <div className="chip">
              <span className="mk">
                {"●"}
              </span>
              <span style={{"color":"var(--muted)"}}>
                {"통신"}
              </span>
              <span className="mono" style={{"fontWeight":"600"}}>
                {"−58 dBm · 90 ms"}
              </span>
            </div>
            {" "}
            <div className="chip">
              <span className="mk">
                {"●"}
              </span>
              <span style={{"color":"var(--muted)"}}>
                {"위치"}
              </span>
              <span className="mono" style={{"fontWeight":"600"}}>
                {"신뢰 높음"}
              </span>
            </div>
            {" "}
            <div className="chip">
              <span className="mk">
                {"●"}
              </span>
              <span style={{"color":"var(--muted)"}}>
                {"배터리"}
              </span>
              <span className="mono" style={{"fontWeight":"600"}}>
                {"68%"}
              </span>
            </div>
            {" "}
          </div>
          {" "}
          <button aria-label="비상 정지" style={{"height":"52px","minWidth":"136px","padding":"0 18px","border":"0","borderRadius":"8px","background":"var(--stop)","color":"#FFFFFF","display":"flex","alignItems":"center","gap":"10px","boxShadow":"0 0 0 3px rgba(215,38,30,.22)"}}>
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
                {"스페이스 · 전체 정지"}
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
            <a className="nav" href="Main.dc.html">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <circle cx="12" cy="12" r="8" />
                <circle cx="12" cy="12" r="3" />
                <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
              </svg>
              {"관제"}
            </a>
            {" "}
            <a className="nav cur" href="PcMissions.dc.html" aria-current="page">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <path d="M4 19l5-14 5 9 3-4 3 9" />
                <circle cx="9" cy="5" r="1.5" />
              </svg>
              {"임무"}
            </a>
            {" "}
            <a className="nav" href="PcHistory.dc.html">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <rect x="4" y="3" width="16" height="18" rx="2" />
                <path d="M8 8h8M8 12h8M8 16h5" />
              </svg>
              {"기록"}
            </a>
            {" "}
            <a className="nav" href="PcMap.dc.html">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z" />
                <path d="M9 4v14M15 6v14" />
              </svg>
              {"지도"}
            </a>
            {" "}
            <a className="nav" href="PcRobot.dc.html">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <rect x="6" y="4" width="12" height="14" rx="3" />
                <path d="M9 21h6M12 18v3M9 9h.01M15 9h.01" />
              </svg>
              {"로봇"}
            </a>
            {" "}
            <div style={{"flex":"1"}} />
            {" "}
            <a className="nav" href="PcSettings.dc.html">
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
            <section aria-label="경로 지도" className="card" style={{"flex":"999 1 620px","minWidth":"0","overflow":"hidden","display":"flex","flexDirection":"column"}}>
              {" "}
              <div role="toolbar" aria-label="지도 도구" style={{"display":"flex","flexWrap":"wrap","alignItems":"center","gap":"4px","padding":"8px 10px","borderBottom":"1px solid var(--line)"}}>
                {" "}
                <button className="tool" aria-pressed="false">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <path d="M5 3l14 8-6 2-2 6z" />
                  </svg>
                  {"선택"}
                </button>
                {" "}
                <button className="tool" aria-pressed="true">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <circle cx="12" cy="10" r="3" />
                    <path d="M12 21s-7-6-7-11a7 7 0 0114 0c0 5-7 11-7 11z" />
                  </svg>
                  {"측정 지점 추가"}
                </button>
                {" "}
                <button className="tool" aria-pressed="false">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <rect x="4" y="4" width="16" height="16" />
                    <path d="M4 4l16 16" />
                  </svg>
                  {"진입 금지 구역"}
                </button>
                {" "}
                <button className="tool" aria-pressed="false">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <path d="M4 18a8 8 0 0116 0" />
                    <path d="M12 18l4-6" />
                  </svg>
                  {"감속 구역"}
                </button>
                {" "}
                <button className="tool" aria-pressed="false">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <path d="M3 12h18M3 8v8M21 8v8" />
                  </svg>
                  {"거리 재기"}
                </button>
                {" "}
                <div style={{"flex":"1"}} />
                {" "}
                <button className="btn sm">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <path d="M4 12a8 8 0 0114-5l2-2v6h-6l2-2a5 5 0 10.5 6" />
                  </svg>
                  {"지난 순찰 경로 불러오기"}
                </button>
                {" "}
              </div>
              {" "}
              <div style={{"position":"relative"}}>
                {" "}
                <svg viewBox="0 0 1000 620" style={{"width":"100%","height":"auto","display":"block"}} role="img" aria-label="임무 계획 지도: 측정 지점 4곳과 계획 경로, 선택된 3번 지점, 진입 금지 구역, 지난 순찰의 통신 약함 구역">
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
                  <rect x="43" y="43" width="254" height="194" fill="none" style={{"stroke":"var(--bad)"}} strokeWidth="1.5" strokeDasharray="6 4" />
                  <rect x="690" y="420" width="267" height="157" fill="url(#hw)" />
                  <g style={{"stroke":"var(--wall)"}} strokeWidth="6" fill="none" strokeLinecap="square">
                    <rect x="40" y="40" width="920" height="540" />
                    <path d="M40 240H200M260 240H300M300 40V300M300 300H440M500 300H770M830 300H960M640 40V300" />
                    <path d="M40 380H120M180 380H330M380 380H750M810 380H960M240 380V580M600 380V580" />
                  </g>
                  <g style={{"stroke":"var(--wall)"}} strokeWidth="2" fill="none" opacity=".8">
                    <circle cx="390" cy="150" r="32" />
                    <circle cx="560" cy="120" r="32" />
                    <path d="M660 90H940M660 120H940M660 230H940" />
                    <rect x="830" y="470" width="96" height="76" strokeDasharray="6 5" />
                    <rect x="270" y="420" width="120" height="80" />
                    <rect x="440" y="420" width="120" height="80" />
                  </g>
                  <g fontFamily="IBM Plex Sans KR, sans-serif" fontSize="15" style={{"fill":"var(--muted)"}}>
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
                    <text x="700" y="572" fontSize="12" style={{"fill":"var(--warn)"}}>
                      {"지난 순찰: 통신 약함"}
                    </text>
                  </g>
                  <polyline points="120,540 150,450 150,340 470,340 470,180 470,340 780,340 780,490 780,340 800,340 800,170" fill="none" style={{"stroke":"var(--accent)"}} strokeWidth="4" strokeLinejoin="round" opacity=".85" />
                  <polyline points="800,170 800,340 150,340 150,450 120,540" fill="none" style={{"stroke":"var(--accent)"}} strokeWidth="2.5" strokeDasharray="8 7" opacity=".6" />
                  <g fontFamily="JetBrains Mono, monospace" fontWeight="700" fontSize="13" textAnchor="middle">
                    <rect x="106" y="526" width="28" height="28" rx="4" style={{"fill":"var(--map)","stroke":"var(--text)"}} strokeWidth="2" />
                    <text x="120" y="545" style={{"fill":"var(--text)"}}>
                      {"S"}
                    </text>
                    <circle cx="150" cy="450" r="15" style={{"fill":"var(--map)","stroke":"var(--accent)"}} strokeWidth="3" />
                    <text x="150" y="455" style={{"fill":"var(--accent)"}}>
                      {"1"}
                    </text>
                    <circle cx="470" cy="180" r="15" style={{"fill":"var(--map)","stroke":"var(--accent)"}} strokeWidth="3" />
                    <text x="470" y="185" style={{"fill":"var(--accent)"}}>
                      {"2"}
                    </text>
                    <circle cx="780" cy="490" r="34" fill="none" style={{"stroke":"var(--accent)"}} strokeWidth="1.5" strokeDasharray="3 4" />
                    <circle cx="780" cy="490" r="18" style={{"fill":"var(--accent)"}} />
                    <text x="780" y="495" style={{"fill":"var(--on-accent)"}}>
                      {"3"}
                    </text>
                    <circle cx="800" cy="170" r="15" style={{"fill":"var(--map)","stroke":"var(--accent)"}} strokeWidth="3" />
                    <text x="800" y="175" style={{"fill":"var(--accent)"}}>
                      {"4"}
                    </text>
                  </g>
                  <g fontFamily="IBM Plex Sans KR, sans-serif">
                    <rect x="574" y="436" width="160" height="58" rx="6" style={{"fill":"var(--panel)","stroke":"var(--accent)"}} strokeWidth="1.5" />
                    <text x="586" y="459" fontSize="14" fontWeight="600" style={{"fill":"var(--text)"}}>
                      {"WP3 · 집수정"}
                    </text>
                    <text x="586" y="481" fontSize="12" style={{"fill":"var(--muted)"}}>
                      {"반경 0.5 m · 측정 60초"}
                    </text>
                  </g>
                  <g fontFamily="JetBrains Mono, monospace" fontSize="12" style={{"fill":"var(--muted)"}}>
                    <line x1="40" y1="603" x2="140" y2="603" style={{"stroke":"var(--muted)"}} strokeWidth="2" />
                    <line x1="40" y1="597" x2="40" y2="609" style={{"stroke":"var(--muted)"}} strokeWidth="2" />
                    <line x1="140" y1="597" x2="140" y2="609" style={{"stroke":"var(--muted)"}} strokeWidth="2" />
                    <text x="150" y="607">
                      {"5 m"}
                    </text>
                  </g>
                </svg>
                {" "}
                <div style={{"position":"absolute","left":"12px","bottom":"34px","display":"flex","flexWrap":"wrap","gap":"6px"}}>
                  {" "}
                  <span style={{"display":"flex","alignItems":"center","gap":"6px","height":"30px","padding":"0 10px","borderRadius":"6px","background":"var(--panel)","border":"1px solid var(--line2)","fontSize":"12px"}}>
                    <span style={{"color":"var(--ok)"}}>
                      {"●"}
                    </span>
                    {"경로 검사 통과 · 막힘 없음"}
                  </span>
                  {" "}
                  <span style={{"display":"flex","alignItems":"center","gap":"6px","height":"30px","padding":"0 10px","borderRadius":"6px","background":"var(--panel)","border":"1px solid var(--warn)","fontSize":"12px"}}>
                    <span style={{"color":"var(--warn)"}}>
                      {"▲"}
                    </span>
                    {"WP3가 통신 약함 구역 안에 있음"}
                  </span>
                  {" "}
                </div>
                {" "}
              </div>
              {" "}
            </section>
            {" "}
            <aside aria-label="임무 설정" className="card" style={{"flex":"1 1 400px","minWidth":"0","maxWidth":"480px","display":"flex","flexDirection":"column"}}>
              {" "}
              <div style={{"padding":"14px 16px","display":"flex","flexDirection":"column","gap":"10px"}}>
                {" "}
                <div style={{"display":"flex","justifyContent":"space-between","alignItems":"baseline"}}>
                  <label className="lbl" htmlFor="tpl">
                    {"임무 양식"}
                  </label>
                  <a href="PcMissions.dc.html" style={{"fontSize":"12px","color":"var(--accent)"}}>
                    {"양식 관리 →"}
                  </a>
                </div>
                {" "}
                <select id="tpl" className="inp" defaultValue="가스 사전 측정">
                  <option>
                    {"지점 확인 다녀오기 (기본)"}
                  </option>
                  <option>
                    {"가스 사전 측정"}
                  </option>
                  <option>
                    {"시설 순찰"}
                  </option>
                </select>
                {" "}
                <span className="lbl">
                  {"양식이 지점마다 할 일의 기본값을 정합니다. 지점별로 더하거나 뺄 수 있습니다."}
                </span>
                {" "}
              </div>
              {" "}
              <div className="sec">
                {" "}
                <h3>
                  {"경로 "}
                  <span className="mono" style={{"fontSize":"12px","color":"var(--muted)","fontWeight":"500"}}>
                    {"4개 지점 · 148 m"}
                  </span>
                </h3>
                {" "}
                <div style={{"display":"flex","flexDirection":"column","gap":"6px"}}>
                  {" "}
                  <div className="wp">
                    <span aria-hidden="true" style={{"color":"var(--muted)"}}>
                      {"⋮⋮"}
                    </span>
                    <span className="num mono">
                      {"1"}
                    </span>
                    <div style={{"display":"flex","flexDirection":"column","gap":"4px","minWidth":"0"}}>
                      <span style={{"fontSize":"13px","fontWeight":"600"}}>
                        {"계단실 하부"}
                      </span>
                      <div style={{"display":"flex","gap":"4px","flexWrap":"wrap"}}>
                        <span className="act">
                          {"가스 측정 30초"}
                        </span>
                      </div>
                    </div>
                    <span className="mono lbl">
                      {"22 m"}
                    </span>
                  </div>
                  {" "}
                  <div className="wp">
                    <span aria-hidden="true" style={{"color":"var(--muted)"}}>
                      {"⋮⋮"}
                    </span>
                    <span className="num mono">
                      {"2"}
                    </span>
                    <div style={{"display":"flex","flexDirection":"column","gap":"4px","minWidth":"0"}}>
                      <span style={{"fontSize":"13px","fontWeight":"600"}}>
                        {"펌프실 A"}
                      </span>
                      <div style={{"display":"flex","gap":"4px","flexWrap":"wrap"}}>
                        <span className="act">
                          {"사진 3방향"}
                        </span>
                        <span className="act">
                          {"탐지"}
                        </span>
                      </div>
                    </div>
                    <span className="mono lbl">
                      {"41 m"}
                    </span>
                  </div>
                  {" "}
                  <div className="wp sel" style={{"gridTemplateColumns":"18px 28px 1fr auto"}}>
                    {" "}
                    <span aria-hidden="true" style={{"color":"var(--muted)"}}>
                      {"⋮⋮"}
                    </span>
                    <span className="num mono" style={{"background":"var(--accent)","color":"var(--on-accent)"}}>
                      {"3"}
                    </span>
                    {" "}
                    <div style={{"display":"flex","flexDirection":"column","gap":"4px","minWidth":"0"}}>
                      <span style={{"fontSize":"13px","fontWeight":"600"}}>
                        {"집수정"}
                      </span>
                      <span className="lbl">
                        {"이 지점에서 할 일"}
                      </span>
                    </div>
                    {" "}
                    <span className="mono lbl">
                      {"74 m"}
                    </span>
                    {" "}
                    <div style={{"gridColumn":"2 / -1","display":"flex","flexDirection":"column","gap":"8px","paddingTop":"4px"}}>
                      {" "}
                      <label style={{"display":"flex","gap":"8px","alignItems":"center","fontSize":"13px"}}>
                        <input type="checkbox" defaultChecked={!!(true)} style={{"accentColor":"var(--accent)","width":"16px","height":"16px"}} />
                        {"가스 측정 · 값이 안정될 때까지 최대 "}
                        <span className="mono">
                          {"60"}
                        </span>
                        {"초"}
                      </label>
                      {" "}
                      <label style={{"display":"flex","gap":"8px","alignItems":"center","fontSize":"13px"}}>
                        <input type="checkbox" defaultChecked={!!(true)} style={{"accentColor":"var(--accent)","width":"16px","height":"16px"}} />
                        {"사진 · 전방 1장 + 개구부 쪽 1장"}
                      </label>
                      {" "}
                      <label style={{"display":"flex","gap":"8px","alignItems":"center","fontSize":"13px"}}>
                        <input type="checkbox" defaultChecked={!!(true)} style={{"accentColor":"var(--accent)","width":"16px","height":"16px"}} />
                        {"AI 탐지 · 물고임 · 쓰러진 사람 · 연기"}
                      </label>
                      {" "}
                      <div style={{"display":"flex","gap":"8px"}}>
                        {" "}
                        <div style={{"flex":"1","display":"flex","flexDirection":"column","gap":"4px"}}>
                          <label className="lbl" htmlFor="rad">
                            {"도착 판정 반경"}
                          </label>
                          <input id="rad" className="inp mono" defaultValue="0.5 m" />
                        </div>
                        {" "}
                        <div style={{"flex":"1","display":"flex","flexDirection":"column","gap":"4px"}}>
                          <label className="lbl" htmlFor="hdg">
                            {"도착 방향"}
                          </label>
                          <input id="hdg" className="inp mono" defaultValue="남 · 180°" />
                        </div>
                        {" "}
                      </div>
                      {" "}
                    </div>
                    {" "}
                  </div>
                  {" "}
                  <div className="wp">
                    <span aria-hidden="true" style={{"color":"var(--muted)"}}>
                      {"⋮⋮"}
                    </span>
                    <span className="num mono">
                      {"4"}
                    </span>
                    <div style={{"display":"flex","flexDirection":"column","gap":"4px","minWidth":"0"}}>
                      <span style={{"fontSize":"13px","fontWeight":"600"}}>
                        {"배관 구역"}
                      </span>
                      <div style={{"display":"flex","gap":"4px","flexWrap":"wrap"}}>
                        <span className="act">
                          {"탐지"}
                        </span>
                        <span className="act">
                          {"사진"}
                        </span>
                      </div>
                    </div>
                    <span className="mono lbl">
                      {"96 m"}
                    </span>
                  </div>
                  {" "}
                  <div className="wp" style={{"opacity":".8"}}>
                    <span />
                    <span className="mono" style={{"width":"26px","height":"26px","border":"2px solid var(--text)","borderRadius":"4px","display":"grid","placeItems":"center","fontSize":"12px","fontWeight":"700"}}>
                      {"S"}
                    </span>
                    <span style={{"fontSize":"13px","fontWeight":"600"}}>
                      {"출발점으로 복귀"}
                    </span>
                    <span className="mono lbl">
                      {"148 m"}
                    </span>
                  </div>
                  {" "}
                </div>
                {" "}
              </div>
              {" "}
              <div className="sec">
                {" "}
                <h3>
                  {"통신이 끊기면"}
                </h3>
                {" "}
                <div role="radiogroup" aria-label="통신이 끊겼을 때 동작" style={{"display":"flex","flexDirection":"column","gap":"6px"}}>
                  {" "}
                  <label className="opt">
                    <input type="radio" name="lost" />
                    <span>
                      <b>
                        {"그 자리 정지"}
                      </b>
                      <br />
                      <span className="lbl">
                        {"사람이 다시 연결해 결정합니다. 음영이 길면 회수가 필요할 수 있습니다."}
                      </span>
                    </span>
                  </label>
                  {" "}
                  <label className="opt on">
                    <input type="radio" name="lost" defaultChecked={!!(true)} />
                    <span>
                      <b>
                        {"마지막 통신 지점으로 후퇴"}
                      </b>
                      {" · 권장"}
                      <br />
                      <span className="lbl">
                        <span className="mono">
                          {"5"}
                        </span>
                        {"초 넘게 끊기면 후퇴하고, 다시 연결되면 확인을 기다립니다."}
                      </span>
                    </span>
                  </label>
                  {" "}
                </div>
                {" "}
              </div>
              {" "}
              <div className="sec">
                {" "}
                <h3>
                  {"경보 규칙 "}
                  <span className="lbl" style={{"fontWeight":"400"}}>
                    {"양식에서 가져옴 · 2개"}
                  </span>
                </h3>
                {" "}
                <div style={{"display":"flex","flexDirection":"column","gap":"6px","fontSize":"13px"}}>
                  {" "}
                  <div className="opt" style={{"cursor":"default"}}>
                    <span>
                      <span className="lbl">
                        {"만약"}
                      </span>
                      {" "}
                      <b>
                        {"H₂S 10 ppm 이상 · CO 30 ppm 이상"}
                      </b>
                      <br />
                      <span className="lbl">
                        {"그러면"}
                      </span>
                      {" 일시정지 → 직전 정상 지점으로 후퇴 · 긴급 알림"}
                    </span>
                  </div>
                  {" "}
                  <div className="opt" style={{"cursor":"default"}}>
                    <span>
                      <span className="lbl">
                        {"만약"}
                      </span>
                      {" "}
                      <b>
                        {"O₂ 18% 미만 또는 23.5% 이상"}
                      </b>
                      <br />
                      <span className="lbl">
                        {"그러면"}
                      </span>
                      {" 일시정지 → 후퇴 · 긴급 알림"}
                    </span>
                  </div>
                  {" "}
                  <a href="PcMissions.dc.html" style={{"fontSize":"12px","color":"var(--accent)"}}>
                    {"양식에서 규칙 고치기 →"}
                  </a>
                  {" "}
                </div>
                {" "}
              </div>
              {" "}
              <div className="sec">
                {" "}
                <h3>
                  {"출발 전 점검 "}
                  <span className="mono" style={{"fontSize":"12px","color":"var(--warn)","fontWeight":"600"}}>
                    {"4 / 6"}
                  </span>
                </h3>
                {" "}
                <div>
                  {" "}
                  <div className="ck">
                    <span className="m ok">
                      {"●"}
                    </span>
                    <span>
                      {"로봇 연결 · 응답 정상"}
                    </span>
                    <span />
                  </div>
                  {" "}
                  <div className="ck">
                    <span className="m ok">
                      {"●"}
                    </span>
                    <span>
                      {"위치 맞춤 · B1 저장 지도, 신뢰 높음"}
                    </span>
                    <span />
                  </div>
                  {" "}
                  <div className="ck">
                    <span className="m ok">
                      {"●"}
                    </span>
                    <span>
                      {"영상 · 지연 "}
                      <span className="mono">
                        {"0.18 s"}
                      </span>
                    </span>
                    <span />
                  </div>
                  {" "}
                  <div className="ck">
                    <span className="m ok">
                      {"●"}
                    </span>
                    <span>
                      {"배터리 "}
                      <span className="mono">
                        {"68%"}
                      </span>
                      {" · 이 임무 예상 "}
                      <span className="mono">
                        {"29%"}
                      </span>
                      {" + 여유 "}
                      <span className="mono">
                        {"15%"}
                      </span>
                    </span>
                    <span />
                  </div>
                  {" "}
                  <div className="ck">
                    <span className="m warn">
                      {"▲"}
                    </span>
                    <span>
                      {"가스 검지기 범프 테스트 · 오늘 기록 없음"}
                    </span>
                    <button className="btn sm">
                      {"기록"}
                    </button>
                  </div>
                  {" "}
                  <div className="ck">
                    <span className="m warn">
                      {"▲"}
                    </span>
                    <span>
                      {"현장 책임자 승인 · 대기"}
                    </span>
                    <button className="btn sm">
                      {"요청"}
                    </button>
                  </div>
                  {" "}
                </div>
                {" "}
              </div>
              {" "}
              <div style={{"marginTop":"auto","padding":"14px 16px","borderTop":"1px solid var(--line)","display":"flex","flexDirection":"column","gap":"10px","background":"var(--panel2)","borderRadius":"0 0 10px 10px"}}>
                {" "}
                <div style={{"display":"flex","flexWrap":"wrap","gap":"6px 16px","fontSize":"13px"}}>
                  {" "}
                  <span>
                    <span className="lbl">
                      {"예상 시간"}
                    </span>
                    {" "}
                    <b className="mono">
                      {"18분"}
                    </b>
                  </span>
                  {" "}
                  <span>
                    <span className="lbl">
                      {"거리"}
                    </span>
                    {" "}
                    <b className="mono">
                      {"148 m"}
                    </b>
                  </span>
                  {" "}
                  <span>
                    <span className="lbl">
                      {"배터리 사용"}
                    </span>
                    {" "}
                    <b className="mono">
                      {"약 29%"}
                    </b>
                  </span>
                  {" "}
                </div>
                {" "}
                <div style={{"display":"flex","gap":"8px"}}>
                  {" "}
                  <button className="btn" style={{"flex":"1"}}>
                    {"양식으로 저장"}
                  </button>
                  {" "}
                  <button className="btn pri" style={{"flex":"2"}} disabled={!!(true)} aria-describedby="why">
                    {"임무 시작"}
                  </button>
                  {" "}
                </div>
                {" "}
                <span id="why" style={{"fontSize":"12px","color":"var(--warn)"}}>
                  {"▲ 점검 2개가 남아 아직 시작할 수 없습니다"}
                </span>
                {" "}
              </div>
              {" "}
            </aside>
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
