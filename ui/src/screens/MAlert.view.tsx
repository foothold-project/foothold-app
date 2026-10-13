// 생성: scripts/dc2tsx.mjs ← web/MAlert.dc.html (시각 원본). 생성 뒤 손으로 실데이터 연결 — 다시 생성해 덮지 않는다.
/* eslint-disable */
import { Fragment } from 'react';
import { arr, css, fn, iv, ivs, str } from '../dc/jsx';

export const PREVIEW = {"width":390,"height":844};
export const FONTS = ["https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap"];
export const CSS = "\nbody{margin:0}\n.fh{--bg:#0B0E11;--panel:#12171C;--panel2:#182028;--line:#26313A;--line2:#34424D;--text:#E6EBEF;--muted:#9AA7B3;--accent:#38C6D9;--on-accent:#061014;--ok:#5AA9FF;--warn:#FFB547;--bad:#FF5A52;--stop:#D7261E;font-family:'IBM Plex Sans KR',system-ui,sans-serif;color:var(--text);background:var(--bg);-webkit-font-smoothing:antialiased}\n.fh.light{--bg:#EDEFEA;--panel:#FFFFFF;--panel2:#F5F6F2;--line:#D7DBD3;--line2:#C2C8BF;--text:#12171C;--muted:#4F5A64;--accent:#006D7A;--on-accent:#FFFFFF;--ok:#1F5FBF;--warn:#9A5800;--bad:#B3261E;--stop:#C8201A}\n.mono{font-family:'JetBrains Mono',ui-monospace,monospace;font-variant-numeric:tabular-nums}\nbutton{font:inherit;color:inherit;cursor:pointer}\n.lbl{font-size:12px;color:var(--muted)}\n.row{display:grid;grid-template-columns:22px 1fr auto;gap:10px;align-items:center;font-size:14px}\n";
/** 원본 틀이 읽는 값 이름 */
export type Vals = { themeClass?: any };

export function View({ v }: { v: Vals }) {
  return (
    <>
      {" "}
      {" "}
      <div className={`${str(v.themeClass)}` as any} style={{"width":"390px","height":"844px","boxSizing":"border-box","display":"flex","flexDirection":"column","overflow":"hidden"}}>
        {" "}
        <section role="alert" aria-label="가스 경보" style={{"background":"#a3342a","color":"#FFFFFF","padding":"22px 20px 20px","display":"flex","flexDirection":"column","gap":"6px"}}>
          {" "}
          <div style={{"display":"flex","justifyContent":"space-between","alignItems":"center"}}>
            {" "}
            <span style={{"fontSize":"13px","fontWeight":"700","letterSpacing":".06em","padding":"4px 10px","border":"1.5px solid #FFFFFF","borderRadius":"4px"}}>
              {"■ 위험 · 긴급"}
            </span>
            {" "}
            <span className="mono" style={{"fontSize":"13px"}}>
              {"10:46:08 · 12초 전"}
            </span>
            {" "}
          </div>
          {" "}
          <span style={{"fontSize":"24px","fontWeight":"700","marginTop":"8px"}}>
            {"황화수소 기준 초과"}
          </span>
          {" "}
          <div style={{"display":"flex","alignItems":"baseline","gap":"8px"}}>
            <span className="mono" style={{"fontSize":"60px","fontWeight":"700","letterSpacing":"-.03em","lineHeight":"1"}}>
              {"12.4"}
            </span>
            <span style={{"fontSize":"20px","fontWeight":"600"}}>
              {"ppm"}
            </span>
          </div>
          {" "}
          <span style={{"fontSize":"14px"}}>
            {"기준 10 ppm 미만 · WP3 집수정 · GO2-01"}
          </span>
          {" "}
        </section>
        {" "}
        <div style={{"flex":"1","minHeight":"0","display":"flex","flexDirection":"column","gap":"12px","padding":"14px 16px"}}>
          {" "}
          <section aria-label="로봇이 한 일" style={{"background":"var(--panel)","border":"1px solid var(--line)","borderRadius":"12px","padding":"14px","display":"flex","flexDirection":"column","gap":"12px"}}>
            {" "}
            <span style={{"fontWeight":"700"}}>
              {"로봇이 자동으로 한 일"}
            </span>
            {" "}
            <div className="row">
              <span style={{"color":"var(--ok)","fontWeight":"700"}}>
                {"✓"}
              </span>
              <span>
                {"임무 일시정지"}
              </span>
              <span className="mono lbl">
                {"10:46:08"}
              </span>
            </div>
            {" "}
            <div className="row">
              <span style={{"width":"14px","height":"14px","borderRadius":"50%","border":"3px solid var(--accent)","boxSizing":"border-box","justifySelf":"center"}} />
              <span style={{"display":"flex","flexDirection":"column","gap":"6px"}}>
                <span>
                  <b>
                    {"후퇴 지점 R로 이동 중"}
                  </b>
                </span>
                <span style={{"height":"6px","borderRadius":"3px","background":"var(--line)","overflow":"hidden"}}>
                  <span style={{"display":"block","width":"40%","height":"100%","background":"var(--accent)"}} />
                </span>
              </span>
              <span className="mono lbl">
                {"9 m 남음"}
              </span>
            </div>
            {" "}
            <div className="row" style={{"color":"var(--muted)"}}>
              <span style={{"justifySelf":"center"}}>
                {"·"}
              </span>
              <span>
                {"R에 도착하면 그 자리에서 대기"}
              </span>
              <span />
            </div>
            {" "}
            <span className="lbl">
              {"임무 설정의 «가스 기준을 넘으면: 일시정지 후 직전 정상 지점으로 후퇴»에 따른 동작입니다."}
            </span>
            {" "}
          </section>
          {" "}
          <section aria-label="H2S 추이" style={{"background":"var(--panel)","border":"1px solid var(--line)","borderRadius":"12px","padding":"12px 14px","display":"flex","flexDirection":"column","gap":"6px"}}>
            {" "}
            <div style={{"display":"flex","justifyContent":"space-between"}}>
              <span style={{"fontWeight":"600","fontSize":"14px"}}>
                {"H₂S 최근 2분"}
              </span>
              <span className="lbl">
                {"점선 = 기준 10 ppm"}
              </span>
            </div>
            {" "}
            <svg viewBox="0 0 320 90" style={{"width":"100%","height":"90px"}} role="img" aria-label="H2S가 2분 동안 1 ppm에서 12.4 ppm으로 올라 기준선을 넘음">
              <line x1="0" y1="30" x2="320" y2="30" style={{"stroke":"var(--bad)"}} strokeWidth="1.5" strokeDasharray="5 4" />
              <line x1="0" y1="56" x2="320" y2="56" style={{"stroke":"var(--warn)"}} strokeWidth="1" strokeDasharray="2 4" />
              <polyline points="0,80 40,79 80,76 120,70 160,62 200,54 240,44 270,34 290,26 320,20" fill="none" style={{"stroke":"var(--bad)"}} strokeWidth="2.5" strokeLinejoin="round" />
              <circle cx="320" cy="20" r="4" style={{"fill":"var(--bad)"}} />
              <text x="4" y="24" fontSize="11" style={{"fill":"var(--bad)"}} fontFamily="'Pretendard Variable', Pretendard, sans-serif">
                {"10"}
              </text>
              <text x="4" y="50" fontSize="11" style={{"fill":"var(--warn)"}} fontFamily="'Pretendard Variable', Pretendard, sans-serif">
                {"5"}
              </text>
            </svg>
            {" "}
          </section>
          {" "}
          <div style={{"display":"flex","flexDirection":"column","gap":"8px","marginTop":"auto"}}>
            {" "}
            <button style={{"height":"56px","border":"0","borderRadius":"12px","background":"var(--accent)","color":"var(--on-accent)","fontWeight":"700","fontSize":"16px"}}>
              {"확인 · 후퇴 계속"}
            </button>
            {" "}
            <div style={{"display":"grid","gridTemplateColumns":"repeat(2,minmax(0,1fr))","gap":"8px"}}>
              {" "}
              <button style={{"height":"52px","border":"1px solid var(--line2)","borderRadius":"12px","background":"var(--panel)","fontWeight":"600"}}>
                {"그 자리 정지"}
              </button>
              {" "}
              <a href="#/MDrive" style={{"height":"52px","border":"1px solid var(--line2)","borderRadius":"12px","background":"var(--panel)","fontWeight":"600","display":"flex","alignItems":"center","justifyContent":"center","textDecoration":"none","color":"inherit"}}>
                {"직접 조종"}
              </a>
              {" "}
            </div>
            {" "}
            <button style={{"height":"44px","border":"0","background":"transparent","fontWeight":"600","color":"var(--accent)","fontSize":"14px"}}>
              {"현장 책임자에게 경보 공유"}
            </button>
            {" "}
          </div>
          {" "}
        </div>
        {" "}
        <div style={{"padding":"8px 16px 18px","background":"var(--panel)","borderTop":"1px solid var(--line)"}}>
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
