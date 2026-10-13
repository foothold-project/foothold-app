// 생성: scripts/dc2tsx.mjs ← web/MAlerts.dc.html (시각 원본). 생성 뒤 손으로 실데이터 연결 — 다시 생성해 덮지 않는다.
/* eslint-disable */
import { Fragment } from 'react';
import { arr, css, fn, iv, ivs, str } from '../dc/jsx';

export const PREVIEW = {"width":390,"height":844};
export const FONTS = ["https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap"];
export const CSS = "\nbody{margin:0}\n.fh{--bg:#0B0E11;--panel:#12171C;--panel2:#182028;--line:#26313A;--line2:#34424D;--text:#E6EBEF;--muted:#9AA7B3;--accent:#38C6D9;--on-accent:#061014;--ok:#5AA9FF;--warn:#FFB547;--bad:#FF5A52;--stop:#D7261E;--acc-bg:rgba(56,198,217,.12);--warn-bg:rgba(255,181,71,.12);--bad-bg:rgba(255,90,82,.13);font-family:'IBM Plex Sans KR',system-ui,sans-serif;color:var(--text);background:var(--bg);-webkit-font-smoothing:antialiased}\n.fh.light{--bg:#EDEFEA;--panel:#FFFFFF;--panel2:#F5F6F2;--line:#D7DBD3;--line2:#C2C8BF;--text:#12171C;--muted:#4F5A64;--accent:#006D7A;--on-accent:#FFFFFF;--ok:#1F5FBF;--warn:#9A5800;--bad:#B3261E;--stop:#C8201A;--acc-bg:rgba(0,109,122,.08);--warn-bg:rgba(154,88,0,.09);--bad-bg:rgba(179,38,30,.08)}\n.mono{font-family:'JetBrains Mono',ui-monospace,monospace;font-variant-numeric:tabular-nums}\nbutton{font:inherit;color:inherit;cursor:pointer}\n.lbl{font-size:12px;color:var(--muted)}\n.n{display:grid;grid-template-columns:28px 1fr auto;gap:4px 10px;padding:12px 14px;border-bottom:1px solid var(--line);text-decoration:none;color:inherit;align-items:start}\n.n.unread{background:var(--panel)}\n.ic{width:28px;height:28px;border-radius:6px;display:grid;place-items:center;font-size:13px;font-weight:700}\n.ic.bad{background:var(--bad-bg);color:var(--bad)}.ic.warn{background:var(--warn-bg);color:var(--warn)}.ic.acc{background:var(--acc-bg);color:var(--accent)}.ic.mute{background:var(--panel2);color:var(--muted)}\n.dot{width:8px;height:8px;border-radius:50%;background:var(--accent);margin-top:6px}\n.grp{font-size:12px;font-weight:700;color:var(--muted);padding:14px 16px 6px;letter-spacing:.04em}\n";
/** 원본 틀이 읽는 값 이름 */
export type Vals = { themeClass?: any };

export function View({ v }: { v: Vals }) {
  return (
    <>
      {" "}
      {" "}
      <div className={`${str(v.themeClass)}` as any} style={{"width":"390px","height":"844px","boxSizing":"border-box","display":"flex","flexDirection":"column","overflow":"hidden"}}>
        {" "}
        <header style={{"display":"flex","alignItems":"center","gap":"8px","padding":"10px 12px"}}>
          {" "}
          <a href="MHome.dc.html" aria-label="뒤로" style={{"width":"44px","height":"44px","display":"grid","placeItems":"center","color":"inherit"}}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M15 6l-6 6 6 6" />
            </svg>
          </a>
          {" "}
          <span style={{"fontWeight":"700","fontSize":"17px","flex":"1"}}>
            {"알림"}
          </span>
          {" "}
          <button style={{"height":"44px","padding":"0 12px","border":"0","background":"transparent","fontSize":"13px","fontWeight":"600","color":"var(--accent)"}}>
            {"모두 읽음"}
          </button>
          {" "}
        </header>
        {" "}
        <div style={{"flex":"1","minHeight":"0","overflow":"hidden","borderTop":"1px solid var(--line)"}}>
          {" "}
          <div className="grp">
            {"지금 할 일"}
          </div>
          {" "}
          <a className="n unread" href="MFinding.dc.html">
            <span className="ic warn">
              {"▲"}
            </span>
            <span style={{"display":"flex","flexDirection":"column","gap":"3px"}}>
              <b style={{"fontSize":"14px"}}>
                {"발견물 확인 대기 · 바닥 물고임"}
              </b>
              <span className="lbl">
                {"지하 펌프실 사전 측정 · WP2"}
              </span>
            </span>
            <span style={{"display":"flex","flexDirection":"column","alignItems":"flex-end","gap":"4px"}}>
              <span className="mono lbl">
                {"5분 전"}
              </span>
              <span className="dot" />
            </span>
          </a>
          {" "}
          <a className="n unread" href="PcPlan.dc.html">
            <span className="ic acc">
              {"✓"}
            </span>
            <span style={{"display":"flex","flexDirection":"column","gap":"3px"}}>
              <b style={{"fontSize":"14px"}}>
                {"출발 승인 요청"}
              </b>
              <span className="lbl">
                {"B1 정기 순찰 · 운영자 B가 승인을 요청함"}
              </span>
            </span>
            <span style={{"display":"flex","flexDirection":"column","alignItems":"flex-end","gap":"4px"}}>
              <span className="mono lbl">
                {"12분 전"}
              </span>
              <span className="dot" />
            </span>
          </a>
          {" "}
          <div className="grp">
            {"경보"}
          </div>
          {" "}
          <a className="n unread" href="MAlert.dc.html">
            <span className="ic bad">
              {"■"}
            </span>
            <span style={{"display":"flex","flexDirection":"column","gap":"3px"}}>
              <b style={{"fontSize":"14px"}}>
                {"H₂S 12.4 ppm · 기준 초과"}
              </b>
              <span className="lbl">
                {"WP3 집수정 · 자동 후퇴 완료 · 운영자 A 확인"}
              </span>
            </span>
            <span style={{"display":"flex","flexDirection":"column","alignItems":"flex-end","gap":"4px"}}>
              <span className="mono lbl">
                {"10:46"}
              </span>
              <span className="dot" />
            </span>
          </a>
          {" "}
          <a className="n" href="#">
            <span className="ic bad">
              {"■"}
            </span>
            <span style={{"display":"flex","flexDirection":"column","gap":"3px"}}>
              <b style={{"fontSize":"14px"}}>
                {"통신 끊김 8초 · 후퇴"}
              </b>
              <span className="lbl">
                {"10-08 펌프실 사전 측정 · 다시 연결됨"}
              </span>
            </span>
            <span className="mono lbl">
              {"10-08"}
            </span>
          </a>
          {" "}
          <div className="grp">
            {"로봇 · 시스템"}
          </div>
          {" "}
          <a className="n" href="PcRobot.dc.html">
            <span className="ic warn">
              {"▲"}
            </span>
            <span style={{"display":"flex","flexDirection":"column","gap":"3px"}}>
              <b style={{"fontSize":"14px"}}>
                {"앞오른 다리 모터 52 °C"}
              </b>
              <span className="lbl">
                {"주의 기준 50 °C 넘음 · 쉬면 내려갑니다"}
              </span>
            </span>
            <span className="mono lbl">
              {"10:52"}
            </span>
          </a>
          {" "}
          <a className="n" href="PcRobot.dc.html">
            <span className="ic warn">
              {"▲"}
            </span>
            <span style={{"display":"flex","flexDirection":"column","gap":"3px"}}>
              <b style={{"fontSize":"14px"}}>
                {"가스 검지기 범프 테스트 필요"}
              </b>
              <span className="lbl">
                {"오늘 기록 없음 · 가스 임무 시작 전 필요"}
              </span>
            </span>
            <span className="mono lbl">
              {"09:00"}
            </span>
          </a>
          {" "}
          <a className="n" href="#">
            <span className="ic mute">
              {"●"}
            </span>
            <span style={{"display":"flex","flexDirection":"column","gap":"3px"}}>
              <b style={{"fontSize":"14px"}}>
                {"배터리 충전 완료"}
              </b>
              <span className="lbl">
                {"GO2-01 · 100%"}
              </span>
            </span>
            <span className="mono lbl">
              {"어제"}
            </span>
          </a>
          {" "}
        </div>
        {" "}
        <div style={{"padding":"10px 16px","borderTop":"1px solid var(--line)","display":"flex","justifyContent":"space-between","alignItems":"center"}}>
          {" "}
          <span className="lbl">
            {"위험 경보는 잠금 화면에도 뜹니다"}
          </span>
          {" "}
          <a href="PcSettings.dc.html" style={{"fontSize":"13px","color":"var(--accent)","padding":"12px 0"}}>
            {"알림 설정"}
          </a>
          {" "}
        </div>
        {" "}
        <div style={{"padding":"0 16px 18px"}}>
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
