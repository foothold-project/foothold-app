// 생성: scripts/dc2tsx.mjs ← web/MLogin.dc.html (시각 원본). 생성 뒤 손으로 실데이터 연결 — 다시 생성해 덮지 않는다.
/* eslint-disable */
import { Fragment } from 'react';
import { arr, css, fn, iv, ivs, str } from '../dc/jsx';
import { BrandLogo } from '../app/BrandLogo';   // 공식 로고(브랜드 변경)

export const PREVIEW = {"width":390,"height":844};
export const FONTS = ["https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap"];
export const CSS = "\nbody{margin:0}\n.fh{--bg:#0B0E11;--panel:#12171C;--panel2:#182028;--line:#26313A;--line2:#34424D;--text:#E6EBEF;--muted:#9AA7B3;--accent:#38C6D9;--on-accent:#061014;--ok:#5AA9FF;font-family:'IBM Plex Sans KR',system-ui,sans-serif;color:var(--text);background:var(--bg);-webkit-font-smoothing:antialiased}\n.fh.light{--bg:#EDEFEA;--panel:#FFFFFF;--panel2:#F5F6F2;--line:#D7DBD3;--line2:#C2C8BF;--text:#12171C;--muted:#4F5A64;--accent:#006D7A;--on-accent:#FFFFFF;--ok:#1F5FBF}\n.mono{font-family:'JetBrains Mono',ui-monospace,monospace}\nbutton,input{font:inherit;color:inherit}\n.lbl{font-size:13px;color:var(--muted)}\n.inp{height:52px;padding:0 14px;border:1px solid var(--line2);border-radius:10px;background:var(--panel);font-size:16px;box-sizing:border-box;width:100%}\n";
/** 원본 틀이 읽는 값 이름 */
export type Vals = { themeClass?: any; [slot: string]: any };   // 손 연결 슬롯: 서버 표시·입력칸·안내·버튼 동작

export function View({ v }: { v: Vals }) {
  return (
    <>
      {" "}
      {" "}
      <div className={`${str(v.themeClass)}` as any} style={{"width":"390px","height":"844px","boxSizing":"border-box","display":"flex","flexDirection":"column","overflow":"hidden"}}>
        {" "}
        <div style={{"position":"relative","height":"250px","background":"#12161d","color":"#E6EBEF","padding":"44px 24px 24px","boxSizing":"border-box","display":"flex","flexDirection":"column","justifyContent":"space-between","overflow":"hidden"}}>
          {" "}
          <svg viewBox="0 0 390 250" style={{"position":"absolute","inset":"0","width":"100%","height":"100%"}} aria-hidden="true">
            <g fill="none" stroke="#3ec7b4" strokeOpacity=".14" strokeWidth="1.5">
              <path d="M-20 230 C80 200 160 230 240 190 S340 140 410 160" />
              <path d="M-20 200 C70 170 170 195 250 155 S350 110 410 125" />
              <path d="M-20 170 C60 145 180 160 260 120 S360 80 410 90" />
              <path d="M-20 140 C50 120 190 125 270 85 S370 50 410 55" />
            </g>
            <path d="M110 200 L170 150 L210 170 L280 100" fill="none" stroke="#3ec7b4" strokeOpacity=".4" strokeWidth="2" />
            <circle cx="280" cy="100" r="6" fill="#3ec7b4" />
          </svg>
          {" "}
          <div style={{"position":"relative","display":"flex","alignItems":"center","gap":"10px"}}>
            {" "}
            <BrandLogo kind="primary" h={36} tone="dark" />
            {" "}
          </div>
          {" "}
          <span style={{"position":"relative","fontSize":"24px","fontWeight":"700","lineHeight":"1.35"}}>
            {"사람이 들어가기 전에,"}
            <br />
            {"로봇이 먼저."}
          </span>
          {" "}
        </div>
        {" "}
        <form style={{"flex":"1","display":"flex","flexDirection":"column","gap":"14px","padding":"22px 20px 24px"}} {...v.formP}>
          {" "}
          <div style={{"display":"flex","alignItems":"center","gap":"10px","padding":"12px 14px","border":"1px solid var(--line)","borderRadius":"10px","background":"var(--panel)"}}>
            {" "}
            <span style={{"color":"var(--ok)"}} {...v.dotP}>
              {"●"}
            </span>
            {" "}
            <span style={{"display":"flex","flexDirection":"column","gap":"2px","flex":"1","minWidth":"0"}}>
              <span style={{"fontSize":"14px","fontWeight":"600"}}>
                {v.srvA ?? "현장 서버 · [서버 주소]"}
              </span>
              <span className="lbl" style={{"fontSize":"12px"}}>
                {v.srvB ?? "같은 Wi-Fi · 인증서 확인됨"}
              </span>
            </span>
            {" "}
            <a href="#" style={{"fontSize":"13px","color":"var(--accent)","padding":"12px 0"}} {...v.chgP}>
              {"바꾸기"}
            </a>
            {" "}
          </div>
          {" "}
          <div style={{"display":"flex","flexDirection":"column","gap":"6px"}}>
            <label className="lbl" htmlFor="mid">
              {"계정"}
            </label>
            {v.idIn ?? <input id="mid" className="inp" defaultValue="operator.a" autoComplete="username" />}
          </div>
          {" "}
          <div style={{"display":"flex","flexDirection":"column","gap":"6px"}}>
            <label className="lbl" htmlFor="mpw">
              {"비밀번호"}
            </label>
            {v.pwIn ?? <input id="mpw" className="inp" type="password" defaultValue="password" autoComplete="current-password" />}
          </div>
          {" "}
          <label style={{"display":"flex","gap":"10px","alignItems":"center","fontSize":"14px","minHeight":"44px"}} {...v.keepP}>
            <input type="checkbox" defaultChecked={!!(true)} style={{"width":"20px","height":"20px","accentColor":"var(--accent)"}} {...v.keepIn} />
            {v.keepT ?? "이 휴대폰에서 로그인 유지"}
          </label>
          {v.msg}
          {" "}
          <a href="#/MHome" style={{"height":"56px","borderRadius":"12px","background":"var(--accent)","color":"var(--on-accent)","fontWeight":"700","fontSize":"17px","display":"flex","alignItems":"center","justifyContent":"center","textDecoration":"none","marginTop":"auto"}} {...v.loginP}>
            {"로그인"}
          </a>
          {" "}
          <a href="#/MHome" style={{"height":"44px","display":"flex","alignItems":"center","justifyContent":"center","fontSize":"14px","fontWeight":"600","color":"var(--accent)","textDecoration":"none"}} {...v.viewP}>
            {"보기 전용으로 들어가기"}
          </a>
          {" "}
          <span className="lbl" style={{"fontSize":"12px","textAlign":"center","lineHeight":"1.5"}}>
            {"보기 전용도 STOP은 누를 수 있습니다"}
          </span>
          {v.guide}
          {" "}
        </form>
        {" "}
      </div>
      {" "}
    </>
  );
}
