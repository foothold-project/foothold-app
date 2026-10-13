// 생성: scripts/dc2tsx.mjs ← web/MFinding.dc.html (시각 원본). 생성 뒤 손으로 실데이터 연결 — 다시 생성해 덮지 않는다.
/* eslint-disable */
import { Fragment } from 'react';
import { arr, css, fn, iv, ivs, str } from '../dc/jsx';

export const PREVIEW = {"width":390,"height":844};
export const FONTS = ["https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap"];
export const CSS = "\nbody{margin:0}\n.fh{--bg:#0B0E11;--panel:#12171C;--panel2:#182028;--line:#26313A;--line2:#34424D;--text:#E6EBEF;--muted:#9AA7B3;--accent:#38C6D9;--on-accent:#061014;--ok:#5AA9FF;--warn:#FFB547;--stop:#D7261E;--acc-bg:rgba(56,198,217,.12);--warn-bg:rgba(255,181,71,.12);font-family:'IBM Plex Sans KR',system-ui,sans-serif;color:var(--text);background:var(--bg);-webkit-font-smoothing:antialiased}\n.fh.light{--bg:#EDEFEA;--panel:#FFFFFF;--panel2:#F5F6F2;--line:#D7DBD3;--line2:#C2C8BF;--text:#12171C;--muted:#4F5A64;--accent:#006D7A;--on-accent:#FFFFFF;--ok:#1F5FBF;--warn:#9A5800;--stop:#C8201A;--acc-bg:rgba(0,109,122,.08);--warn-bg:rgba(154,88,0,.09)}\n.mono{font-family:'JetBrains Mono',ui-monospace,monospace;font-variant-numeric:tabular-nums}\nbutton{font:inherit;color:inherit;cursor:pointer}\n.lbl{font-size:12px;color:var(--muted)}\n.tag{height:36px;padding:0 12px;border:1px solid var(--line2);border-radius:18px;background:var(--panel);font-size:13px}\n.tag[aria-pressed=\"true\"]{border-color:var(--accent);background:var(--acc-bg);font-weight:600}\n";
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
          <a href="#/MHome" aria-label="뒤로" style={{"width":"44px","height":"44px","display":"grid","placeItems":"center","color":"inherit"}}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M15 6l-6 6 6 6" />
            </svg>
          </a>
          {" "}
          <span style={{"fontWeight":"700","fontSize":"17px","flex":"1"}}>
            {"발견물 확인"}
          </span>
          {" "}
          <span className="mono lbl" style={{"paddingRight":"8px"}}>
            {"1 / 2"}
          </span>
          {" "}
        </header>
        {" "}
        <div style={{"flex":"1","minHeight":"0","display":"flex","flexDirection":"column","gap":"12px","padding":"0 16px"}}>
          {" "}
          <figure style={{"margin":"0","position":"relative","borderRadius":"12px","overflow":"hidden","background":"#05080A"}}>
            {" "}
            <svg viewBox="0 0 640 360" style={{"width":"100%","height":"auto","display":"block"}} role="img" aria-label="탐지 사진: 펌프 아래 바닥 물고임, 탐지 상자">
              <rect width="640" height="360" fill="#080B0D" />
              <polygon points="0,360 640,360 470,190 170,190" fill="#141C21" />
              <circle cx="470" cy="150" r="70" fill="#121A1F" stroke="#2D3A43" strokeWidth="4" />
              <rect x="430" y="210" width="80" height="40" fill="#0F151A" />
              <ellipse cx="330" cy="292" rx="150" ry="30" fill="#1D303B" />
              <ellipse cx="300" cy="286" rx="70" ry="7" fill="#3E5A69" opacity=".6" />
              <rect x="170" y="252" width="320" height="76" fill="none" stroke="#FFB547" strokeWidth="3" />
            </svg>
            {" "}
            <span style={{"position":"absolute","left":"8px","top":"8px","fontSize":"12px","padding":"4px 8px","borderRadius":"4px","background":"rgba(8,11,14,.7)","color":"#E6EBEF"}}>
              {"전방 RGB · "}
              <span className="mono">
                {"10:39:51"}
              </span>
            </span>
            {" "}
          </figure>
          {" "}
          <div style={{"display":"flex","flexDirection":"column","gap":"6px"}}>
            {" "}
            <div style={{"display":"flex","alignItems":"center","gap":"8px"}}>
              {" "}
              <span style={{"width":"12px","height":"12px","transform":"rotate(45deg)","background":"var(--warn)","margin":"0 3px"}} />
              {" "}
              <span style={{"fontSize":"22px","fontWeight":"700"}}>
                {"바닥 물고임"}
              </span>
              {" "}
              <span className="mono" style={{"marginLeft":"auto","fontSize":"13px","fontWeight":"600","padding":"3px 8px","borderRadius":"4px","background":"var(--warn-bg)","color":"var(--warn)"}}>
                {"0.88"}
              </span>
              {" "}
            </div>
            {" "}
            <span className="lbl">
              {"AI 탐지 결과입니다. 사람이 확인해야 기록에 들어갑니다."}
            </span>
            {" "}
          </div>
          {" "}
          <dl style={{"margin":"0","display":"grid","gridTemplateColumns":"72px 1fr","gap":"8px 12px","fontSize":"14px","padding":"12px 14px","background":"var(--panel)","border":"1px solid var(--line)","borderRadius":"12px"}}>
            {" "}
            <dt className="lbl" style={{"alignSelf":"center"}}>
              {"위치"}
            </dt>
            <dd style={{"margin":"0"}}>
              {"WP2 펌프실 A · 펌프 B 아래"}
            </dd>
            {" "}
            <dt className="lbl" style={{"alignSelf":"center"}}>
              {"로봇 자세"}
            </dt>
            <dd style={{"margin":"0"}} className="mono">
              {"x 22.6 · y 18.1 · 92°"}
            </dd>
            {" "}
            <dt className="lbl" style={{"alignSelf":"center"}}>
              {"같은 위치"}
            </dt>
            <dd style={{"margin":"0"}}>
              {"지난 순찰(10-05)에는 없음"}
            </dd>
            {" "}
          </dl>
          {" "}
          <div style={{"display":"flex","flexDirection":"column","gap":"8px"}}>
            {" "}
            <span className="lbl">
              {"빠른 메모"}
            </span>
            {" "}
            <div style={{"display":"flex","flexWrap":"wrap","gap":"6px"}}>
              {" "}
              <button className="tag" aria-pressed="true">
                {"미끄럼 주의"}
              </button>
              {" "}
              <button className="tag" aria-pressed="true">
                {"누수 의심"}
              </button>
              {" "}
              <button className="tag" aria-pressed="false">
                {"조치 필요"}
              </button>
              {" "}
              <button className="tag" aria-pressed="false">
                {"+ 직접 입력"}
              </button>
              {" "}
            </div>
            {" "}
          </div>
          {" "}
          <div style={{"display":"flex","flexDirection":"column","gap":"8px","marginTop":"auto"}}>
            {" "}
            <button style={{"height":"56px","border":"0","borderRadius":"12px","background":"var(--accent)","color":"var(--on-accent)","fontWeight":"700","fontSize":"16px"}}>
              {"맞음 · 위험 요인으로 기록"}
            </button>
            {" "}
            <div style={{"display":"grid","gridTemplateColumns":"repeat(2,minmax(0,1fr))","gap":"8px"}}>
              {" "}
              <button style={{"height":"52px","border":"1px solid var(--line2)","borderRadius":"12px","background":"var(--panel)","fontWeight":"600"}}>
                {"오탐"}
              </button>
              {" "}
              <button style={{"height":"52px","border":"1px solid var(--line2)","borderRadius":"12px","background":"var(--panel)","fontWeight":"600"}}>
                {"나중에"}
              </button>
              {" "}
            </div>
            {" "}
          </div>
          {" "}
        </div>
        {" "}
        <div style={{"padding":"12px 16px 18px","background":"var(--panel)","borderTop":"1px solid var(--line)","marginTop":"12px"}}>
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
