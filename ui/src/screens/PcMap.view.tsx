// 생성: scripts/dc2tsx.mjs ← web/PcMap.dc.html (시각 원본). 생성 뒤 손으로 실데이터 연결 — 다시 생성해 덮지 않는다.
/* eslint-disable */
import { Fragment } from 'react';
import { arr, css, fn, iv, ivs, str } from '../dc/jsx';

export const PREVIEW = {"width":1440,"height":980};
export const FONTS = ["https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap"];
export const CSS = "\nbody{margin:0}\n.fh{--bg:#0B0E11;--panel:#12171C;--panel2:#182028;--line:#26313A;--line2:#34424D;--text:#E6EBEF;--muted:#9AA7B3;--accent:#38C6D9;--on-accent:#061014;--ok:#5AA9FF;--warn:#FFB547;--bad:#FF5A52;--stop:#D7261E;--map:#0E1317;--wall:#4C5A66;--gridc:rgba(154,167,179,.07);--acc-bg:rgba(56,198,217,.12);--warn-bg:rgba(255,181,71,.12);--bad-bg:rgba(255,90,82,.13);font-family:'IBM Plex Sans KR',system-ui,sans-serif;color:var(--text);background:var(--bg);-webkit-font-smoothing:antialiased}\n.fh.light{--bg:#EDEFEA;--panel:#FFFFFF;--panel2:#F5F6F2;--line:#D7DBD3;--line2:#C2C8BF;--text:#12171C;--muted:#4F5A64;--accent:#006D7A;--on-accent:#FFFFFF;--ok:#1F5FBF;--warn:#9A5800;--bad:#B3261E;--stop:#C8201A;--map:#F8F9F5;--wall:#7C8790;--gridc:rgba(18,23,28,.06);--acc-bg:rgba(0,109,122,.08);--warn-bg:rgba(154,88,0,.09);--bad-bg:rgba(179,38,30,.08)}\n.mono{font-family:'JetBrains Mono',ui-monospace,monospace;font-variant-numeric:tabular-nums}\nbutton,input,select{font:inherit;color:inherit}\nbutton{cursor:pointer}\n.card{background:var(--panel);border:1px solid var(--line);border-radius:10px}\n.lbl{font-size:12px;color:var(--muted)}\n.btn{height:40px;padding:0 14px;border:1px solid var(--line2);background:var(--panel2);border-radius:8px;display:inline-flex;align-items:center;justify-content:center;gap:6px;font-weight:600;font-size:13px}\n.btn.pri{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}\n.tool{height:38px;padding:0 10px;border:1px solid transparent;border-radius:6px;background:transparent;display:flex;align-items:center;gap:6px;font-size:13px;color:var(--muted)}\n.tool[aria-pressed=\"true\"]{background:var(--acc-bg);border-color:var(--accent);color:var(--text)}\n.mp{display:flex;flex-direction:column;gap:4px;padding:12px;border:1px solid var(--line);border-radius:8px;background:var(--panel2);text-align:left;width:100%}\n.mp.sel{border-color:var(--accent);background:var(--acc-bg)}\n.inp{height:40px;padding:0 12px;border:1px solid var(--line2);border-radius:6px;background:var(--panel2);font-size:14px;box-sizing:border-box;width:100%}\n.sec{padding:14px 16px;border-top:1px solid var(--line);display:flex;flex-direction:column;gap:10px}\n.kv{display:grid;grid-template-columns:96px 1fr;gap:6px 10px;font-size:13px}\n.nav{display:flex;flex-direction:column;align-items:center;gap:4px;width:64px;padding:10px 0;border-radius:8px;font-size:11px;color:var(--muted);text-decoration:none}\n.nav:hover{color:var(--text);background:var(--panel2)}\n.nav.cur{color:var(--text);background:var(--acc-bg)}\n.nav.cur svg{color:var(--accent)}\n/* 승인 수정(10-12): PC 머리줄(STOP 포함)은 스크롤해도 화면 위에 남는다 — 불투명 배경(--panel)이 아래 내용을 가린 채 위에 놓임 */\nheader{position:sticky;top:0;z-index:10}\n";
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
              {"지도"}
            </span>
            {" "}
            <span style={{"fontSize":"17px","fontWeight":"600"}}>
              {"B1 펌프실 · 지도 v3"}
            </span>
            {" "}
          </div>
          {" "}
          <span style={{"height":"26px","padding":"0 10px","borderRadius":"999px","display":"flex","alignItems":"center","fontSize":"12px","fontWeight":"600","background":"var(--acc-bg)","color":"var(--accent)"}}>
            {"임무에 사용 중"}
          </span>
          {" "}
          <div style={{"flex":"1"}} />
          {" "}
          <div style={{"display":"flex","alignItems":"center","gap":"6px","height":"34px","padding":"0 10px","border":"1px solid var(--line)","borderRadius":"6px","fontSize":"13px","background":"var(--panel2)"}}>
            <span style={{"color":"var(--ok)","fontSize":"11px"}}>
              {"●"}
            </span>
            <span style={{"color":"var(--muted)"}}>
              {"위치"}
            </span>
            <span className="mono" style={{"fontWeight":"600"}}>
              {"신뢰 높음 · ±0.08 m"}
            </span>
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
            <a className="nav" href="PcMissions.dc.html">
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
            <a className="nav cur" href="PcMap.dc.html" aria-current="page">
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
            <section aria-label="저장된 지도" className="card" style={{"flex":"1 1 240px","maxWidth":"280px","minWidth":"0","padding":"14px","display":"flex","flexDirection":"column","gap":"10px"}}>
              {" "}
              <span style={{"fontWeight":"600","fontSize":"15px"}}>
                {"저장된 지도"}
              </span>
              {" "}
              <button className="btn pri" style={{"width":"100%"}}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" />
                </svg>
                {"새 지도 만들기"}
              </button>
              {" "}
              <span className="lbl" style={{"lineHeight":"1.5"}}>
                {"로봇을 직접 조종해 한 바퀴 돌면 SLAM이 지도를 만듭니다. 끝나면 저장합니다."}
              </span>
              {" "}
              <span className="lbl" style={{"paddingTop":"6px"}}>
                {"B1 · [현장명]"}
              </span>
              {" "}
              <button className="mp sel">
                <b style={{"fontSize":"14px"}}>
                  {"펌프실 v3"}
                </b>
                <span className="lbl">
                  {"10-10 14:20 · 46 × 27 m · 사용 중"}
                </span>
              </button>
              {" "}
              <button className="mp">
                <b style={{"fontSize":"14px"}}>
                  {"펌프실 v2"}
                </b>
                <span className="lbl">
                  {"10-03 · 이전 판 · 보관"}
                </span>
              </button>
              {" "}
              <span className="lbl" style={{"paddingTop":"6px"}}>
                {"1F · [현장명]"}
              </span>
              {" "}
              <button className="mp">
                <b style={{"fontSize":"14px"}}>
                  {"로비 v1"}
                </b>
                <span className="lbl">
                  {"09-28 · 32 × 18 m"}
                </span>
              </button>
              {" "}
              <span className="lbl" style={{"lineHeight":"1.5","paddingTop":"6px","borderTop":"1px solid var(--line)"}}>
                {"층을 바꾸면: 층 확인 → 지도 불러오기 → 위치 맞추기 → 신뢰 확인 뒤에만 이동합니다. 층 사이 자율 이동은 아직 지원하지 않습니다."}
              </span>
              {" "}
            </section>
            {" "}
            <section aria-label="지도 편집" className="card" style={{"flex":"999 1 560px","minWidth":"0","overflow":"hidden","display":"flex","flexDirection":"column"}}>
              {" "}
              <div role="toolbar" aria-label="지도 도구" style={{"display":"flex","flexWrap":"wrap","alignItems":"center","gap":"4px","padding":"8px 10px","borderBottom":"1px solid var(--line)"}}>
                {" "}
                <button className="tool" aria-pressed="true">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <circle cx="12" cy="12" r="4" />
                    <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
                  </svg>
                  {"위치 맞추기"}
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
                    <path d="M4 7h16M4 12h10M4 17h7" />
                  </svg>
                  {"구역 이름"}
                </button>
                {" "}
                <button className="tool" aria-pressed="false">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <path d="M5 20l7-16 7 16" />
                  </svg>
                  {"지우개 (잡음 정리)"}
                </button>
                {" "}
                <div style={{"flex":"1"}} />
                {" "}
                <div role="radiogroup" aria-label="보기" style={{"display":"flex","border":"1px solid var(--line2)","borderRadius":"6px","overflow":"hidden"}}>
                  {" "}
                  <button role="radio" aria-checked="true" style={{"height":"34px","padding":"0 12px","border":"0","background":"var(--acc-bg)","fontSize":"12px","fontWeight":"600"}}>
                    {"2D 지도"}
                  </button>
                  {" "}
                  <button role="radio" aria-checked="false" style={{"height":"34px","padding":"0 12px","border":"0","background":"transparent","fontSize":"12px","color":"var(--muted)"}}>
                    {"3D 점군"}
                  </button>
                  {" "}
                </div>
                {" "}
              </div>
              {" "}
              <div style={{"position":"relative"}}>
                {" "}
                <svg viewBox="0 0 1000 620" style={{"width":"100%","height":"auto","display":"block"}} role="img" aria-label="지도 편집: 위치 맞추기 화살표와 위치 추정 입자 구름, 선택된 진입 금지 구역, 감속 구역">
                  <defs>
                    <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
                      <path d="M20 0H0V20" fill="none" style={{"stroke":"var(--gridc)"}} strokeWidth="1" />
                    </pattern>
                    <pattern id="hb" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                      <line x1="0" y1="0" x2="0" y2="10" style={{"stroke":"var(--bad)"}} strokeWidth="2" strokeOpacity=".4" />
                    </pattern>
                    <pattern id="hs" width="14" height="14" patternUnits="userSpaceOnUse">
                      <circle cx="7" cy="7" r="1.6" style={{"fill":"var(--warn)"}} fillOpacity=".5" />
                    </pattern>
                  </defs>
                  <rect width="1000" height="620" style={{"fill":"var(--map)"}} />
                  <rect width="1000" height="620" fill="url(#grid)" />
                  <rect x="43" y="43" width="254" height="194" fill="url(#hb)" />
                  <rect x="43" y="43" width="254" height="194" fill="none" style={{"stroke":"var(--bad)"}} strokeWidth="2.5" />
                  <g style={{"fill":"var(--map)","stroke":"var(--bad)"}} strokeWidth="2.5">
                    <rect x="37" y="37" width="12" height="12" />
                    <rect x="291" y="37" width="12" height="12" />
                    <rect x="37" y="231" width="12" height="12" />
                    <rect x="291" y="231" width="12" height="12" />
                  </g>
                  <rect x="310" y="306" width="290" height="68" fill="url(#hs)" />
                  <rect x="310" y="306" width="290" height="68" fill="none" style={{"stroke":"var(--warn)"}} strokeWidth="1.5" strokeDasharray="6 4" />
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
                  <g style={{"fill":"var(--wall)"}} opacity=".55">
                    <circle cx="512" cy="56" r="2" />
                    <circle cx="728" cy="268" r="2" />
                    <circle cx="352" cy="548" r="2" />
                    <circle cx="905" cy="402" r="2" />
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
                    <text x="318" y="296" fontSize="12" style={{"fill":"var(--warn)"}}>
                      {"감속 0.3 m/s · 문턱"}
                    </text>
                  </g>
                  <g style={{"fill":"var(--accent)"}} opacity=".55">
                    <circle cx="142" cy="512" r="2.2" />
                    <circle cx="150" cy="520" r="2.2" />
                    <circle cx="136" cy="526" r="2.2" />
                    <circle cx="158" cy="510" r="2.2" />
                    <circle cx="146" cy="530" r="2.2" />
                    <circle cx="130" cy="514" r="2.2" />
                    <circle cx="154" cy="524" r="2.2" />
                    <circle cx="140" cy="506" r="2.2" />
                    <circle cx="162" cy="518" r="2.2" />
                    <circle cx="148" cy="514" r="2.2" />
                    <circle cx="138" cy="520" r="2.2" />
                    <circle cx="152" cy="508" r="2.2" />
                  </g>
                  <g transform="translate(146 518)">
                    <circle r="22" fill="none" style={{"stroke":"var(--accent)"}} strokeWidth="1.5" strokeDasharray="3 3" />
                    <line x1="0" y1="0" x2="0" y2="-74" style={{"stroke":"var(--accent)"}} strokeWidth="3" />
                    <path d="M0 -86 L-9 -70 L9 -70 Z" style={{"fill":"var(--accent)"}} />
                    <circle r="6" style={{"fill":"var(--accent)"}} />
                  </g>
                  <g fontFamily="IBM Plex Sans KR, sans-serif">
                    <rect x="178" y="470" width="212" height="54" rx="6" style={{"fill":"var(--panel)","stroke":"var(--accent)"}} strokeWidth="1.5" />
                    <text x="190" y="492" fontSize="14" fontWeight="600" style={{"fill":"var(--text)"}}>
                      {"여기 · 북쪽(위)을 보고 있음"}
                    </text>
                    <text x="190" y="512" fontSize="12" style={{"fill":"var(--muted)"}}>
                      {"누른 뒤 방향으로 끌어 놓기"}
                    </text>
                  </g>
                  <g fontFamily="JetBrains Mono, monospace" fontSize="12" style={{"fill":"var(--muted)"}}>
                    <line x1="40" y1="603" x2="140" y2="603" style={{"stroke":"var(--muted)"}} strokeWidth="2" />
                    <line x1="40" y1="597" x2="40" y2="609" style={{"stroke":"var(--muted)"}} strokeWidth="2" />
                    <line x1="140" y1="597" x2="140" y2="609" style={{"stroke":"var(--muted)"}} strokeWidth="2" />
                    <text x="150" y="607">
                      {"5 m"}
                    </text>
                    <text x="960" y="607" textAnchor="end">
                      {"해상도 0.05 m/칸"}
                    </text>
                  </g>
                </svg>
                {" "}
                <div style={{"position":"absolute","left":"12px","top":"12px","maxWidth":"340px","display":"flex","flexDirection":"column","gap":"6px","padding":"12px 14px","borderRadius":"8px","background":"var(--panel)","border":"1px solid var(--line2)"}}>
                  {" "}
                  <b style={{"fontSize":"14px"}}>
                    {"위치 맞추기"}
                  </b>
                  {" "}
                  <span className="lbl" style={{"lineHeight":"1.5"}}>
                    {"1 로봇이 실제로 있는 곳을 누르고 2 바라보는 방향으로 끌어 놓은 뒤 3 로봇을 조금 움직여 점이 모이는지 봅니다."}
                  </span>
                  {" "}
                  <div style={{"display":"flex","alignItems":"center","gap":"8px","fontSize":"13px"}}>
                    <span style={{"color":"var(--ok)"}}>
                      {"●"}
                    </span>
                    {"점이 한곳에 모였습니다 · 이동 가능"}
                  </div>
                  {" "}
                </div>
                {" "}
              </div>
              {" "}
            </section>
            {" "}
            <aside aria-label="선택한 구역" className="card" style={{"flex":"1 1 300px","maxWidth":"340px","minWidth":"0","display":"flex","flexDirection":"column"}}>
              {" "}
              <div style={{"padding":"14px 16px","display":"flex","flexDirection":"column","gap":"10px"}}>
                {" "}
                <div style={{"display":"flex","alignItems":"center","gap":"8px"}}>
                  <span style={{"width":"14px","height":"14px","background":"var(--bad-bg)","border":"2px solid var(--bad)"}} />
                  <b style={{"fontSize":"15px"}}>
                    {"진입 금지 구역"}
                  </b>
                </div>
                {" "}
                <label className="lbl" htmlFor="zn">
                  {"이름"}
                </label>
                {" "}
                <input id="zn" className="inp" defaultValue="전기실 · 고압 배전반" />
                {" "}
                <label className="lbl" htmlFor="za">
                  {"적용"}
                </label>
                {" "}
                <select id="za" className="inp">
                  <option>
                    {"모든 임무 · 직접 조종 포함"}
                  </option>
                  <option>
                    {"자율 이동만"}
                  </option>
                </select>
                {" "}
                <span className="lbl" style={{"lineHeight":"1.5"}}>
                  {"직접 조종 중에도 이 구역 앞에서 멈춥니다. Nav2 keepout 필터로 서버에서 막습니다."}
                </span>
                {" "}
                <div style={{"display":"flex","gap":"8px"}}>
                  <button className="btn" style={{"flex":"1","color":"var(--bad)","borderColor":"var(--bad)"}}>
                    {"구역 삭제"}
                  </button>
                  <button className="btn pri" style={{"flex":"1"}}>
                    {"저장"}
                  </button>
                </div>
                {" "}
              </div>
              {" "}
              <div className="sec">
                {" "}
                <b style={{"fontSize":"14px"}}>
                  {"이 지도의 구역"}
                </b>
                {" "}
                <div style={{"display":"flex","flexDirection":"column","gap":"6px","fontSize":"13px"}}>
                  {" "}
                  <span style={{"display":"flex","justifyContent":"space-between"}}>
                    <span>
                      <span style={{"color":"var(--bad)"}}>
                        {"■"}
                      </span>
                      {" 전기실 · 진입 금지"}
                    </span>
                    <span className="lbl">
                      {"모든 임무"}
                    </span>
                  </span>
                  {" "}
                  <span style={{"display":"flex","justifyContent":"space-between"}}>
                    <span>
                      <span style={{"color":"var(--warn)"}}>
                        {"▲"}
                      </span>
                      {" 복도 문턱 · 감속"}
                    </span>
                    <span className="lbl">
                      {"0.3 m/s"}
                    </span>
                  </span>
                  {" "}
                  <span style={{"display":"flex","justifyContent":"space-between"}}>
                    <span>
                      <span style={{"color":"var(--warn)"}}>
                        {"▲"}
                      </span>
                      {" 집수정 개구부 · 감속"}
                    </span>
                    <span className="lbl">
                      {"0.2 m/s"}
                    </span>
                  </span>
                  {" "}
                </div>
                {" "}
              </div>
              {" "}
              <div className="sec">
                {" "}
                <b style={{"fontSize":"14px"}}>
                  {"지도 정보"}
                </b>
                {" "}
                <div className="kv">
                  {" "}
                  <span className="lbl">
                    {"만든 날"}
                  </span>
                  <span className="mono">
                    {"2026-10-10 14:20"}
                  </span>
                  {" "}
                  <span className="lbl">
                    {"만든 사람"}
                  </span>
                  <span>
                    {"운영자 A"}
                  </span>
                  {" "}
                  <span className="lbl">
                    {"크기"}
                  </span>
                  <span className="mono">
                    {"46 × 27 m"}
                  </span>
                  {" "}
                  <span className="lbl">
                    {"해상도"}
                  </span>
                  <span className="mono">
                    {"0.05 m/칸"}
                  </span>
                  {" "}
                  <span className="lbl">
                    {"방법"}
                  </span>
                  <span>
                    {"slam_toolbox · L1 라이다"}
                  </span>
                  {" "}
                  <span className="lbl">
                    {"위치 추정"}
                  </span>
                  <span>
                    {"AMCL (저장 지도)"}
                  </span>
                  {" "}
                  <span className="lbl">
                    {"쓴 임무"}
                  </span>
                  <span className="mono">
                    {"7회"}
                  </span>
                  {" "}
                </div>
                {" "}
                <div style={{"display":"flex","gap":"8px"}}>
                  <button className="btn" style={{"flex":"1"}}>
                    {"내보내기"}
                  </button>
                  <button className="btn" style={{"flex":"1"}}>
                    {"다시 만들기"}
                  </button>
                </div>
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
