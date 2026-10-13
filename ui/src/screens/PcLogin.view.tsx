// 생성: scripts/dc2tsx.mjs ← web/PcLogin.dc.html (시각 원본). 생성 뒤 손으로 실데이터 연결 — 다시 생성해 덮지 않는다.
/* eslint-disable */
import { Fragment } from 'react';
import { arr, css, fn, iv, ivs, str } from '../dc/jsx';

export const PREVIEW = {"width":1440,"height":900};
export const FONTS = ["https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap"];
export const CSS = "\nbody{margin:0}\n.fh{--bg:#0B0E11;--panel:#12171C;--panel2:#182028;--line:#26313A;--line2:#34424D;--text:#E6EBEF;--muted:#9AA7B3;--accent:#38C6D9;--on-accent:#061014;--ok:#5AA9FF;--warn:#FFB547;--bad:#FF5A52;--acc-bg:rgba(56,198,217,.12);font-family:'IBM Plex Sans KR',system-ui,sans-serif;color:var(--text);background:var(--bg);-webkit-font-smoothing:antialiased}\n.fh.light{--bg:#EDEFEA;--panel:#FFFFFF;--panel2:#F5F6F2;--line:#D7DBD3;--line2:#C2C8BF;--text:#12171C;--muted:#4F5A64;--accent:#006D7A;--on-accent:#FFFFFF;--ok:#1F5FBF;--warn:#9A5800;--bad:#B3261E;--acc-bg:rgba(0,109,122,.08)}\n.mono{font-family:'JetBrains Mono',ui-monospace,monospace;font-variant-numeric:tabular-nums}\nbutton,input{font:inherit;color:inherit}\n.lbl{font-size:13px;color:var(--muted)}\n.inp{height:48px;padding:0 14px;border:1px solid var(--line2);border-radius:8px;background:var(--panel2);font-size:15px;box-sizing:border-box;width:100%}\n.inp:focus{outline:2px solid var(--accent);outline-offset:1px}\n";
/** 원본 틀이 읽는 값 이름 */
export type Vals = { themeClass?: any };

export function View({ v }: { v: Vals }) {
  return (
    <>
      {" "}
      {" "}
      <div className={`${str(v.themeClass)}` as any} style={{"minHeight":"100vh","display":"flex","flexWrap":"wrap"}}>
        {" "}
        <section aria-label="소개" style={{"flex":"1 1 520px","minHeight":"360px","position":"relative","overflow":"hidden","background":"#071014","color":"#E6EBEF","display":"flex","flexDirection":"column","justifyContent":"space-between","padding":"48px"}}>
          {" "}
          <svg viewBox="0 0 800 900" preserveAspectRatio="xMidYMid slice" style={{"position":"absolute","inset":"0","width":"100%","height":"100%"}} aria-hidden="true">
            <g fill="none" stroke="#38C6D9" strokeOpacity=".13" strokeWidth="1.5">
              <path d="M-40 760 C120 700 220 760 340 700 S560 560 840 610" />
              <path d="M-40 700 C110 640 230 690 350 630 S570 500 840 545" />
              <path d="M-40 640 C100 585 240 620 360 560 S580 440 840 480" />
              <path d="M-40 580 C90 530 250 550 370 490 S590 380 840 415" />
              <path d="M-40 520 C80 475 260 480 380 420 S600 320 840 350" />
              <path d="M-40 460 C70 420 270 410 390 350 S610 260 840 285" />
              <path d="M-40 400 C60 365 280 340 400 280 S620 200 840 220" />
              <path d="M-40 340 C50 310 290 270 410 210 S630 140 840 155" />
            </g>
            <g fill="none" stroke="#38C6D9" strokeOpacity=".35" strokeWidth="2">
              <path d="M210 620 L300 520 L360 560 L470 430" />
            </g>
            <g fill="#38C6D9">
              <circle cx="210" cy="620" r="6" />
              <circle cx="300" cy="520" r="6" />
              <circle cx="360" cy="560" r="6" />
              <circle cx="470" cy="430" r="9" />
            </g>
          </svg>
          {" "}
          <div style={{"position":"relative","display":"flex","alignItems":"center","gap":"12px"}}>
            {" "}
            <svg width="36" height="36" viewBox="0 0 28 28" aria-hidden="true">
              <path d="M3 23 L10 9 L14 16 L18 6 L25 23 Z" fill="none" stroke="#38C6D9" strokeWidth="2.2" strokeLinejoin="round" />
              <circle cx="18" cy="6" r="2.2" fill="#38C6D9" />
            </svg>
            {" "}
            <span style={{"fontWeight":"700","letterSpacing":".14em","fontSize":"18px"}}>
              {"FOOTHOLD"}
            </span>
            {" "}
          </div>
          {" "}
          <div style={{"position":"relative","display":"flex","flexDirection":"column","gap":"14px","maxWidth":"460px"}}>
            {" "}
            <h1 style={{"margin":"0","fontSize":"40px","lineHeight":"1.25","fontWeight":"700","letterSpacing":"-.01em","textWrap":"balance"}}>
              {"사람이 들어가기 전에,"}
              <br />
              {"로봇이 먼저."}
            </h1>
            {" "}
            <p style={{"margin":"0","fontSize":"16px","lineHeight":"1.65","color":"#B5C1CB"}}>
              {"사족보행 로봇으로 위험한 현장을 먼저 걷고, 보고, 재고, 기록합니다."}
            </p>
            {" "}
          </div>
          {" "}
          <span className="mono" style={{"position":"relative","fontSize":"12px","color":"#93A3AE"}}>
            {"인공지능사관학교 7기 · FOOTHOLD 팀"}
          </span>
          {" "}
        </section>
        {" "}
        <section aria-label="로그인" style={{"flex":"1 1 480px","display":"flex","alignItems":"center","justifyContent":"center","padding":"48px 24px","background":"var(--bg)"}}>
          {" "}
          <form style={{"width":"100%","maxWidth":"400px","display":"flex","flexDirection":"column","gap":"18px"}}>
            {" "}
            <div style={{"display":"flex","flexDirection":"column","gap":"6px"}}>
              {" "}
              <h2 style={{"margin":"0","fontSize":"26px","fontWeight":"700"}}>
                {"로그인"}
              </h2>
              {" "}
              <span className="lbl">
                {"현장 서버에 연결해 로봇을 보고 조종합니다"}
              </span>
              {" "}
            </div>
            {" "}
            <div style={{"display":"flex","alignItems":"center","gap":"10px","padding":"12px 14px","border":"1px solid var(--line)","borderRadius":"8px","background":"var(--panel)"}}>
              {" "}
              <span style={{"color":"var(--ok)"}}>
                {"●"}
              </span>
              {" "}
              <span style={{"display":"flex","flexDirection":"column","gap":"2px","flex":"1","minWidth":"0"}}>
                <span style={{"fontSize":"14px","fontWeight":"600"}}>
                  {"현장 서버 · [서버 주소]"}
                </span>
                <span className="lbl" style={{"fontSize":"12px"}}>
                  {"인증서 확인됨 · 로봇 1대 연결됨"}
                </span>
              </span>
              {" "}
              <a href="#" style={{"fontSize":"13px","color":"var(--accent)"}}>
                {"바꾸기"}
              </a>
              {" "}
            </div>
            {" "}
            <div style={{"display":"flex","flexDirection":"column","gap":"6px"}}>
              <label className="lbl" htmlFor="id">
                {"계정"}
              </label>
              <input id="id" className="inp" defaultValue="operator.a" autoComplete="username" />
            </div>
            {" "}
            <div style={{"display":"flex","flexDirection":"column","gap":"6px"}}>
              <label className="lbl" htmlFor="pw">
                {"비밀번호"}
              </label>
              <input id="pw" className="inp" type="password" defaultValue="password" autoComplete="current-password" />
            </div>
            {" "}
            <div style={{"display":"flex","flexDirection":"column","gap":"6px"}}>
              <label className="lbl" htmlFor="dv">
                {"이 기기 이름 · 기록에 남습니다"}
              </label>
              <input id="dv" className="inp" defaultValue="관제 노트북 1" />
            </div>
            {" "}
            <label style={{"display":"flex","gap":"10px","alignItems":"center","fontSize":"14px"}}>
              <input type="checkbox" defaultChecked={!!(true)} style={{"width":"18px","height":"18px","accentColor":"var(--accent)"}} />
              {"이 기기에서 로그인 유지 (12시간)"}
            </label>
            {" "}
            <a href="#/Main" style={{"height":"52px","borderRadius":"8px","background":"var(--accent)","color":"var(--on-accent)","fontWeight":"700","fontSize":"16px","display":"flex","alignItems":"center","justifyContent":"center","textDecoration":"none"}}>
              {"로그인"}
            </a>
            {" "}
            <div style={{"display":"flex","justifyContent":"space-between","gap":"12px","fontSize":"13px"}}>
              {" "}
              <a href="#/Main" style={{"color":"var(--accent)"}}>
                {"보기 전용으로 들어가기"}
              </a>
              {" "}
              <span className="lbl">
                {"5번 틀리면 1분 잠김"}
              </span>
              {" "}
            </div>
            {" "}
            <span className="lbl" style={{"fontSize":"12px","lineHeight":"1.6","paddingTop":"6px","borderTop":"1px solid var(--line)"}}>
              {"보기 전용 사용자도 STOP은 누를 수 있습니다. 조종은 로그인한 한 사람만, «조종권 받기»를 누른 뒤에 할 수 있습니다."}
            </span>
            {" "}
          </form>
          {" "}
        </section>
        {" "}
      </div>
      {" "}
    </>
  );
}
