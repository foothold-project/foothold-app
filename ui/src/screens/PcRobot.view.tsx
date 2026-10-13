// 생성: scripts/dc2tsx.mjs ← web/PcRobot.dc.html (시각 원본). 생성 뒤 손으로 실데이터 연결 — 다시 생성해 덮지 않는다.
/* eslint-disable */
import { Fragment } from 'react';
import { arr, css, fn, iv, ivs, str } from '../dc/jsx';

export const PREVIEW = {"width":1440,"height":1040};
export const FONTS = ["https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap"];
export const CSS = "\nbody{margin:0}\n.fh{--bg:#0B0E11;--panel:#12171C;--panel2:#182028;--line:#26313A;--line2:#34424D;--text:#E6EBEF;--muted:#9AA7B3;--accent:#38C6D9;--on-accent:#061014;--ok:#5AA9FF;--warn:#FFB547;--bad:#FF5A52;--stop:#D7261E;--acc-bg:rgba(56,198,217,.12);--warn-bg:rgba(255,181,71,.12);--bad-bg:rgba(255,90,82,.13);--ok-bg:rgba(90,169,255,.10);font-family:'IBM Plex Sans KR',system-ui,sans-serif;color:var(--text);background:var(--bg);-webkit-font-smoothing:antialiased}\n.fh.light{--bg:#EDEFEA;--panel:#FFFFFF;--panel2:#F5F6F2;--line:#D7DBD3;--line2:#C2C8BF;--text:#12171C;--muted:#4F5A64;--accent:#006D7A;--on-accent:#FFFFFF;--ok:#1F5FBF;--warn:#9A5800;--bad:#B3261E;--stop:#C8201A;--acc-bg:rgba(0,109,122,.08);--warn-bg:rgba(154,88,0,.09);--bad-bg:rgba(179,38,30,.08);--ok-bg:rgba(31,95,191,.08)}\n.mono{font-family:'JetBrains Mono',ui-monospace,monospace;font-variant-numeric:tabular-nums}\nbutton{font:inherit;color:inherit;cursor:pointer}\n.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;display:flex;flex-direction:column;gap:12px}\n.card h2{margin:0;font-size:15px;font-weight:600;display:flex;align-items:center;gap:8px}\n.lbl{font-size:12px;color:var(--muted)}\n.btn{height:44px;padding:0 14px;border:1px solid var(--line2);background:var(--panel2);border-radius:8px;display:inline-flex;align-items:center;justify-content:center;gap:6px;font-weight:600;font-size:13px}\n.row{display:grid;grid-template-columns:18px 1fr auto;gap:10px;align-items:center;padding:9px 0;border-top:1px solid var(--line);font-size:13px}\n.m-ok{color:var(--ok)}.m-warn{color:var(--warn)}.m-bad{color:var(--bad)}.m-off{color:var(--muted)}\n.eq{display:grid;grid-template-columns:40px 1fr auto;gap:12px;align-items:center;padding:12px;border:1px solid var(--line);border-radius:8px;background:var(--panel2)}\n.ei{width:40px;height:40px;border-radius:8px;background:var(--acc-bg);color:var(--accent);display:grid;place-items:center}\n.nav{display:flex;flex-direction:column;align-items:center;gap:4px;width:64px;padding:10px 0;border-radius:8px;font-size:11px;color:var(--muted);text-decoration:none}\n.nav:hover{color:var(--text);background:var(--panel2)}\n.nav.cur{color:var(--text);background:var(--acc-bg)}\n.nav.cur svg{color:var(--accent)}\n/* 승인 수정(10-12): PC 머리줄(STOP 포함)은 스크롤해도 화면 위에 남는다 — 불투명 배경(--panel)이 아래 내용을 가린 채 위에 놓임 */\nheader{position:sticky;top:0;z-index:10}\n";
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
              {"로봇"}
            </span>
            {" "}
            <span style={{"fontSize":"17px","fontWeight":"600"}}>
              {"GO2-01 · Unitree Go2 EDU"}
            </span>
            {" "}
          </div>
          {" "}
          <span style={{"height":"26px","padding":"0 10px","borderRadius":"999px","display":"flex","alignItems":"center","fontSize":"12px","fontWeight":"600","background":"var(--ok-bg)","color":"var(--ok)"}}>
            {"● 연결됨 · 대기"}
          </span>
          {" "}
          <div style={{"flex":"1"}} />
          {" "}
          <span className="lbl">
            {"조종권: "}
            <b style={{"color":"var(--text)"}}>
              {"운영자 A (이 기기)"}
            </b>
          </span>
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
            <a className="nav" href="#/Main">
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
            <a className="nav cur" href="#/PcRobot" aria-current="page">
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
          <main style={{"flex":"999 1 600px","minWidth":"0","padding":"12px","display":"grid","gridTemplateColumns":"repeat(auto-fit,minmax(min(400px,100%),1fr))","gap":"12px","alignContent":"start"}}>
            {" "}
            <section className="card" aria-label="몸 상태">
              {" "}
              <h2>
                {"몸 상태 "}
                <span className="lbl" style={{"fontWeight":"400"}}>
                  {"위에서 본 모습 · 다리 모터 온도"}
                </span>
              </h2>
              {" "}
              <div style={{"display":"flex","flexWrap":"wrap","gap":"16px","alignItems":"center"}}>
                {" "}
                <svg viewBox="0 0 220 260" style={{"width":"200px","height":"auto","flex":"none"}} role="img" aria-label="위에서 본 로봇: 다리 네 개 모터 온도, 앞오른쪽 다리가 가장 높음 52도">
                  <path d="M110 18 L118 34 L102 34 Z" style={{"fill":"var(--accent)"}} />
                  <text x="110" y="14" textAnchor="middle" fontSize="11" style={{"fill":"var(--muted)"}} fontFamily="IBM Plex Sans KR, sans-serif">
                    {"앞"}
                  </text>
                  <rect x="70" y="40" width="80" height="180" rx="18" style={{"fill":"var(--panel2)","stroke":"var(--line2)"}} strokeWidth="2" />
                  <rect x="88" y="44" width="44" height="18" rx="4" style={{"fill":"var(--line2)"}} />
                  <g strokeWidth="10" strokeLinecap="round">
                    <line x1="70" y1="70" x2="30" y2="60" style={{"stroke":"var(--ok)"}} />
                    <line x1="150" y1="70" x2="190" y2="60" style={{"stroke":"var(--warn)"}} />
                    <line x1="70" y1="190" x2="30" y2="200" style={{"stroke":"var(--ok)"}} />
                    <line x1="150" y1="190" x2="190" y2="200" style={{"stroke":"var(--ok)"}} />
                  </g>
                  <g fontFamily="JetBrains Mono, monospace" fontSize="12" textAnchor="middle">
                    <text x="30" y="44" style={{"fill":"var(--text)"}}>
                      {"41°"}
                    </text>
                    <text x="190" y="44" style={{"fill":"var(--warn)"}} fontWeight="700">
                      {"52°"}
                    </text>
                    <text x="30" y="224" style={{"fill":"var(--text)"}}>
                      {"38°"}
                    </text>
                    <text x="190" y="224" style={{"fill":"var(--text)"}}>
                      {"40°"}
                    </text>
                  </g>
                  <g fontFamily="IBM Plex Sans KR, sans-serif" fontSize="11" textAnchor="middle" style={{"fill":"var(--muted)"}}>
                    <text x="30" y="84">
                      {"앞왼"}
                    </text>
                    <text x="190" y="84">
                      {"앞오른"}
                    </text>
                    <text x="30" y="186">
                      {"뒤왼"}
                    </text>
                    <text x="190" y="186">
                      {"뒤오른"}
                    </text>
                  </g>
                </svg>
                {" "}
                <div style={{"flex":"1 1 180px","display":"flex","flexDirection":"column","gap":"2px"}}>
                  {" "}
                  <div className="row" style={{"borderTop":"0"}}>
                    <span className="m-ok">
                      {"●"}
                    </span>
                    <span>
                      {"자세"}
                    </span>
                    <b>
                      {"서 있음 · 균형 서기"}
                    </b>
                  </div>
                  {" "}
                  <div className="row">
                    <span className="m-ok">
                      {"●"}
                    </span>
                    <span>
                      {"보행 모드"}
                    </span>
                    <b>
                      {"보통 · 장애물 피하기 켬"}
                    </b>
                  </div>
                  {" "}
                  <div className="row">
                    <span className="m-warn">
                      {"▲"}
                    </span>
                    <span>
                      {"앞오른 다리 모터"}
                    </span>
                    <b className="mono">
                      {"52 °C"}
                    </b>
                  </div>
                  {" "}
                  <div className="row">
                    <span className="m-ok">
                      {"●"}
                    </span>
                    <span>
                      {"넘어짐"}
                    </span>
                    <b>
                      {"없음"}
                    </b>
                  </div>
                  {" "}
                  <span className="lbl" style={{"lineHeight":"1.5","paddingTop":"4px"}}>
                    {"모터 온도 주의 50 °C · 위험 65 °C(팀 설정 임시값). 위험이면 «앉기» 후 식힙니다."}
                  </span>
                  {" "}
                </div>
                {" "}
              </div>
              {" "}
            </section>
            {" "}
            <section className="card" aria-label="배터리와 연결">
              {" "}
              <h2>
                {"배터리 · 연결"}
              </h2>
              {" "}
              <div style={{"display":"flex","alignItems":"baseline","gap":"8px"}}>
                <span className="mono" style={{"fontSize":"40px","fontWeight":"600","lineHeight":"1"}}>
                  {"68"}
                  <span style={{"fontSize":"20px"}}>
                    {"%"}
                  </span>
                </span>
                <span className="lbl">
                  {"복귀 여유 41분 · 예상 운용 남은 시간 52분"}
                </span>
              </div>
              {" "}
              <div style={{"height":"10px","borderRadius":"5px","background":"var(--line)","overflow":"hidden","position":"relative"}}>
                <span style={{"position":"absolute","left":"0","top":"0","bottom":"0","width":"68%","background":"var(--ok)"}} />
                <span style={{"position":"absolute","left":"20%","top":"-2px","bottom":"-2px","width":"2px","background":"var(--warn)"}} />
              </div>
              {" "}
              <span className="lbl">
                {"노란 선 20% = 임무를 끝내고 복귀를 시작하는 기준"}
              </span>
              {" "}
              <div>
                {" "}
                <div className="row">
                  <span className="m-ok">
                    {"●"}
                  </span>
                  <span>
                    {"전압 · 사이클"}
                  </span>
                  <b className="mono">
                    {"[V] · [회]"}
                  </b>
                </div>
                {" "}
                <div className="row">
                  <span className="m-ok">
                    {"●"}
                  </span>
                  <span>
                    {"현장 Wi-Fi"}
                  </span>
                  <b className="mono">
                    {"−58 dBm · 90 ms"}
                  </b>
                </div>
                {" "}
                <div className="row">
                  <span className="m-ok">
                    {"●"}
                  </span>
                  <span>
                    {"로봇 PC (Orin NX)"}
                  </span>
                  <b className="mono">
                    {"CPU 41% · GPU 33% · 58 °C"}
                  </b>
                </div>
                {" "}
                <div className="row">
                  <span className="m-off">
                    {"○"}
                  </span>
                  <span>
                    {"펌웨어 · SDK"}
                  </span>
                  <b className="mono">
                    {"[버전] · [버전]"}
                  </b>
                </div>
                {" "}
              </div>
              {" "}
            </section>
            {" "}
            <section className="card" aria-label="센서">
              {" "}
              <h2>
                {"센서"}
              </h2>
              {" "}
              <div>
                {" "}
                <div className="row" style={{"borderTop":"0"}}>
                  <span className="m-ok">
                    {"●"}
                  </span>
                  <span>
                    {"전방 카메라 (내장)"}
                  </span>
                  <b className="mono">
                    {"15 fps · 0.18 s"}
                  </b>
                </div>
                {" "}
                <div className="row">
                  <span className="m-ok">
                    {"●"}
                  </span>
                  <span>
                    {"L1 라이다 (내장)"}
                  </span>
                  <b className="mono">
                    {"정상 · 점 수 [n]/s"}
                  </b>
                </div>
                {" "}
                <div className="row">
                  <span className="m-ok">
                    {"●"}
                  </span>
                  <span>
                    {"IMU"}
                  </span>
                  <b>
                    {"정상"}
                  </b>
                </div>
                {" "}
                <div className="row">
                  <span className="m-off">
                    {"○"}
                  </span>
                  <span>
                    {"뎁스 카메라 D435i"}
                  </span>
                  <b style={{"color":"var(--muted)"}}>
                    {"장착 확인 안 됨"}
                  </b>
                </div>
                {" "}
                <div className="row">
                  <span className="m-off">
                    {"○"}
                  </span>
                  <span>
                    {"XT-16 라이다"}
                  </span>
                  <b style={{"color":"var(--muted)"}}>
                    {"장착 확인 안 됨"}
                  </b>
                </div>
                {" "}
              </div>
              {" "}
              <span className="lbl" style={{"lineHeight":"1.5"}}>
                {"«확인 안 됨»은 고장이 아니라 아직 연결 근거가 없다는 뜻입니다. 숫자를 지어내지 않습니다."}
              </span>
              {" "}
            </section>
            {" "}
            <section className="card" aria-label="장비">
              {" "}
              <h2>
                {"장비 "}
                <span className="lbl" style={{"fontWeight":"400"}}>
                  {"여기 등록된 장비만 임무 모듈에서 고를 수 있습니다"}
                </span>
              </h2>
              {" "}
              <div style={{"display":"flex","flexDirection":"column","gap":"8px"}}>
                {" "}
                <div className="eq">
                  <span className="ei">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                      <rect x="7" y="3" width="10" height="18" rx="2" />
                      <path d="M10 7h4M10 11h4" />
                    </svg>
                  </span>
                  <span style={{"display":"flex","flexDirection":"column","gap":"2px"}}>
                    <b style={{"fontSize":"14px"}}>
                      {"가스 검지기 · [모델]"}
                    </b>
                    <span className="lbl">
                      {"O₂ · H₂S · CO · LEL + CO₂ · 직렬 연결 · "}
                      <span style={{"color":"var(--warn)"}}>
                        {"▲ 오늘 범프 테스트 없음"}
                      </span>
                    </span>
                  </span>
                  <button className="btn" style={{"height":"36px"}}>
                    {"테스트 기록"}
                  </button>
                </div>
                {" "}
                <div className="eq">
                  <span className="ei">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                      <path d="M4 10v4h3l5 4V6L7 10z" />
                      <path d="M16 9a4 4 0 010 6" />
                    </svg>
                  </span>
                  <span style={{"display":"flex","flexDirection":"column","gap":"2px"}}>
                    <b style={{"fontSize":"14px"}}>
                      {"스피커 (내장)"}
                    </b>
                    <span className="lbl">
                      {"음성 방송 모듈에 사용"}
                    </span>
                  </span>
                  <span className="m-ok" style={{"fontSize":"13px"}}>
                    {"● 정상"}
                  </span>
                </div>
                {" "}
                <div className="eq" style={{"borderStyle":"dashed","background":"transparent"}}>
                  <span className="ei" style={{"background":"var(--panel2)","color":"var(--muted)"}}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                  </span>
                  <span style={{"display":"flex","flexDirection":"column","gap":"2px"}}>
                    <b style={{"fontSize":"14px"}}>
                      {"장비 등록"}
                    </b>
                    <span className="lbl">
                      {"열화상 카메라 · 계기판 카메라 · 조명 …"}
                    </span>
                  </span>
                  <button className="btn" style={{"height":"36px"}}>
                    {"등록"}
                  </button>
                </div>
                {" "}
              </div>
              {" "}
            </section>
            {" "}
            <section className="card" aria-label="자세 명령">
              {" "}
              <h2>
                {"자세 명령 "}
                <span className="lbl" style={{"fontWeight":"400"}}>
                  {"조종권이 있을 때만 · 주변 1 m를 비우세요"}
                </span>
              </h2>
              {" "}
              <div style={{"display":"grid","gridTemplateColumns":"repeat(2,minmax(0,1fr))","gap":"8px"}}>
                {" "}
                <button className="btn">
                  {"일어서기"}
                </button>
                {" "}
                <button className="btn">
                  {"앉기"}
                </button>
                {" "}
                <button className="btn">
                  {"엎드리기 · 모터 끄기 전"}
                </button>
                {" "}
                <button className="btn" style={{"borderColor":"var(--warn)"}}>
                  {"넘어짐에서 다시 일어서기"}
                </button>
                {" "}
              </div>
              {" "}
              <span className="lbl" style={{"lineHeight":"1.5"}}>
                {"«다시 일어서기»는 넘어짐이 감지됐을 때만 켜집니다. 계단 오르기·춤 같은 동작은 이 앱에서 쓰지 않습니다."}
              </span>
              {" "}
            </section>
            {" "}
            <section className="card" aria-label="정지 계층">
              {" "}
              <h2>
                {"정지 계층 "}
                <span className="lbl" style={{"fontWeight":"400"}}>
                  {"위에서 놓쳐도 아래가 잡습니다"}
                </span>
              </h2>
              {" "}
              <div>
                {" "}
                <div className="row" style={{"borderTop":"0"}}>
                  <span className="m-ok">
                    {"●"}
                  </span>
                  <span>
                    {"앱 STOP → 서버"}
                  </span>
                  <b>
                    {"정상 · 마지막 시험 10-12 09:58"}
                  </b>
                </div>
                {" "}
                <div className="row">
                  <span className="m-ok">
                    {"●"}
                  </span>
                  <span>
                    {"서버 deadman 0.3 s"}
                  </span>
                  <b>
                    {"켜짐"}
                  </b>
                </div>
                {" "}
                <div className="row">
                  <span className="m-ok">
                    {"●"}
                  </span>
                  <span>
                    {"화면 신호 끊김 1.0 s → 정지·잠금"}
                  </span>
                  <b>
                    {"켜짐"}
                  </b>
                </div>
                {" "}
                <div className="row">
                  <span className="m-warn">
                    {"▲"}
                  </span>
                  <span>
                    {"로봇 쪽 명령 끊김 감시"}
                  </span>
                  <b style={{"color":"var(--warn)"}}>
                    {"실기 미검증"}
                  </b>
                </div>
                {" "}
                <div className="row">
                  <span className="m-ok">
                    {"●"}
                  </span>
                  <span>
                    {"리모컨 비상 정지"}
                  </span>
                  <b>
                    {"[확인 필요]"}
                  </b>
                </div>
                {" "}
              </div>
              {" "}
              <div style={{"display":"flex","gap":"8px"}}>
                <button className="btn" style={{"flex":"1"}}>
                  {"정지 시험 실행"}
                </button>
                <button className="btn" style={{"flex":"1"}}>
                  {"진단 로그 내려받기"}
                </button>
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
