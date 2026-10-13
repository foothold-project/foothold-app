// 생성: scripts/dc2tsx.mjs ← web/MDrive.dc.html (시각 원본). 생성 뒤 손으로 실데이터 연결 — 다시 생성해 덮지 않는다.
/* eslint-disable */
import { Fragment } from 'react';
import { arr, css, fn, iv, ivs, str } from '../dc/jsx';

export const PREVIEW = {"width":844,"height":390};
export const FONTS = ["https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap"];
export const CSS = "\nbody{margin:0}\n.mono{font-family:'JetBrains Mono',ui-monospace,monospace;font-variant-numeric:tabular-nums}\nbutton{font:inherit;color:inherit;cursor:pointer}\n.hud{display:flex;align-items:center;gap:6px;height:32px;padding:0 10px;border-radius:6px;background:rgba(8,11,14,.66);color:#E6EBEF;font-size:12px;white-space:nowrap}\n.glass{background:rgba(8,11,14,.5);border:1.5px solid rgba(230,235,239,.45)}\n.pill{height:44px;padding:0 14px;border-radius:22px;border:1.5px solid rgba(230,235,239,.45);background:rgba(8,11,14,.55);color:#FFFFFF;font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px}\n";
/** 원본 틀이 읽는 값 이름 */
export type Vals = { moveLeft?: any; rotLeft?: any; [k: string]: any };

export function View({ v }: { v: Vals }) {
  return (
    <>
      {" "}
      {" "}
      <div ref={v.rootRef} data-live-drive="" style={{"width":"844px","height":"390px","position":"relative","overflow":"hidden","background":"#05080A","fontFamily":"'Pretendard Variable', Pretendard, 'Malgun Gothic', sans-serif","color":"#E6EBEF"}}>
        {" "}
        <svg viewBox="0 0 844 390" preserveAspectRatio="xMidYMid slice" style={{"position":"absolute","inset":"0","width":"100%","height":"100%", ...(v.cam !== undefined ? {visibility:"hidden"} : {})}} role="img" aria-label="전방 카메라 영상 자리: 집수정으로 가는 통로">
          <defs>
            <radialGradient id="lamp" cx="50%" cy="90%" r="60%">
              <stop offset="0" stopColor="#FFFFFF" stopOpacity=".09" />
              <stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
            </radialGradient>
          </defs>
          <rect width="844" height="390" fill="#070A0C" />
          <polygon points="0,0 844,0 520,110 324,110" fill="#0A0E11" />
          <polygon points="0,0 324,110 324,236 0,390" fill="#0D1317" />
          <polygon points="844,0 520,110 520,236 844,390" fill="#0F151A" />
          <polygon points="0,390 844,390 520,236 324,236" fill="#131B20" />
          <rect x="324" y="110" width="196" height="126" fill="#040607" stroke="#26313A" strokeWidth="3" />
          <line x1="0" y1="70" x2="324" y2="140" stroke="#2C3A44" strokeWidth="11" />
          <line x1="0" y1="110" x2="324" y2="152" stroke="#25313A" strokeWidth="6" />
          <ellipse cx="420" cy="330" rx="130" ry="24" fill="#1C2C35" opacity=".9" />
          <rect width="844" height="390" fill="url(#lamp)" />
          <path d="M300 390 L392 250 M544 390 L452 250" stroke="#3ec7b4" strokeOpacity=".55" strokeWidth="2" strokeDasharray="6 6" />
          <path d="M422 186v16M414 194h16" stroke="#E6EBEF" strokeOpacity=".55" strokeWidth="1.5" />
        </svg>
{v.cam ?? null}
        {" "}
        <a href="#/MMap" aria-label="큰 지도 열기" style={{"position":"absolute","left":"44px","top":"14px","width":"172px","height":"104px","borderRadius":"8px","overflow":"hidden","border":"1.5px solid rgba(230,235,239,.45)","display":"block"}}>
          {" "}
          {v.mini ?? null}
          <svg viewBox="600 250 360 220" style={{"width":"100%","height":"100%","display":"block", ...(v.mini !== undefined ? {display:"none"} : {})}} aria-hidden="true">
            <rect x="600" y="250" width="360" height="220" fill="rgba(14,19,23,.82)" />
            <g stroke="#6B7A86" strokeWidth="6" fill="none">
              <path d="M500 300H770M830 300H960M380 380H750M810 380H960M600 380V580" />
            </g>
            <polyline points="600,340 780,340 780,404" fill="none" stroke="#3ec7b4" strokeWidth="6" />
            <circle cx="780" cy="455" r="13" fill="none" stroke="#3ec7b4" strokeWidth="3" />
            <g transform="translate(780 404) rotate(180)">
              <path d="M0 -18 L12 12 L0 6 L-12 12 Z" fill="#3ec7b4" />
            </g>
          </svg>
          {" "}
        </a>
        {" "}
        <div style={{"position":"absolute","left":"232px","right":"190px","top":"14px","display":"flex","flexWrap":"wrap","gap":"6px","alignContent":"flex-start"}}>
{v.huds ?? <>
          {" "}
          <span className="hud" style={{"background":"rgba(56,198,217,.9)","color":"#061014","fontWeight":"700"}}>
            {"직접 조종 · 임무 일시정지"}
          </span>
          {" "}
          <span className="hud">
            <span style={{"color":"#3ec7b4"}}>
              {"●"}
            </span>
            {"통신 "}
            <span className="mono">
              {"−64 dBm"}
            </span>
          </span>
          {" "}
          <span className="hud">
            <span style={{"color":"#3ec7b4"}}>
              {"●"}
            </span>
            {"영상 "}
            <span className="mono">
              {"0.19 s"}
            </span>
          </span>
          {" "}
          <span className="hud">
            <span style={{"color":"#3ec7b4"}}>
              {"●"}
            </span>
            <span className="mono">
              {"68%"}
            </span>
          </span>
          {" "}
</>}
        </div>
        {" "}
        <button aria-label="비상 정지" {...v.stopProps} style={{"position":"absolute","right":"44px","top":"14px","width":"132px","height":"64px","border":"0","borderRadius":"12px","background":"#a3342a","color":"#FFFFFF","display":"flex","alignItems":"center","justifyContent":"center","gap":"8px","boxShadow":"0 0 0 3px rgba(255,255,255,.18)"}}>
          {" "}
          <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M8 2h8l6 6v8l-6 6H8l-6-6V8z" fill="none" stroke="#FFFFFF" strokeWidth="2" />
            <rect x="8" y="8" width="8" height="8" fill="#FFFFFF" />
          </svg>
          {" "}
          <span style={{"fontWeight":"700","fontSize":"20px","letterSpacing":".08em"}}>
            {"STOP"}
          </span>
          {" "}
        </button>
{v.side ?? null}
        {" "}
        <div style={{"position":"absolute","left":"50%","top":"150px","transform":"translateX(-50%)","display":"flex","alignItems":"center","gap":"6px","height":"30px","padding":"0 12px","borderRadius":"15px","background":"rgba(220,154,48,.92)","color":"#12161d","fontSize":"12px","fontWeight":"700", ...(v.bannerS || {})}}>
          {v.banner ?? <>{"▲ 앞 장애물 "}
          <span className="mono">
            {"0.8 m"}
          </span>
          {" · 속도 자동 감속"}</>}
        </div>
        {" "}
        {v.moveLeft ? (<>
          {" "}
          <div style={{"position":"absolute","left":"44px","bottom":"22px","display":"flex","flexDirection":"column","alignItems":"center","gap":"6px"}}>
            {" "}
            <div className="glass" style={{"position":"relative","width":"140px","height":"140px","borderRadius":"50%"}} role="group" aria-label="이동 막대: 앞뒤와 옆걸음" {...v.stickP?.["이동 막대: 앞뒤와 옆걸음"]}>
              {" "}
              <svg viewBox="0 0 140 140" style={{"position":"absolute","inset":"0"}} aria-hidden="true">
                <g fill="none" stroke="#FFFFFF" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M70 16l-7 8h14zM70 124l-7-8h14zM16 70l8-7v14zM124 70l-8-7v14z" fill="#FFFFFF" />
                </g>
              </svg>
              {" "}
              <span ref={v.knobR?.["이동 막대: 앞뒤와 옆걸음"]} style={{"position":"absolute","left":"44px","top":"43px","width":"52px","height":"52px","borderRadius":"50%","background":"rgba(230,235,239,.92)","boxShadow":"0 2px 8px rgba(0,0,0,.4)"}} />
              {" "}
            </div>
            {" "}
            <span style={{"fontSize":"12px","fontWeight":"600","textShadow":"0 1px 2px #000"}}>
              {v.lbl?.["이동 · 앞뒤 · 옆"] ?? "이동 · 앞뒤 · 옆"}
            </span>
            {" "}
          </div>
          {" "}
          <div style={{"position":"absolute","right":"44px","bottom":"42px","display":"flex","flexDirection":"column","alignItems":"center","gap":"6px"}}>
            {" "}
            <div className="glass" style={{"position":"relative","width":"176px","height":"64px","borderRadius":"32px"}} role="group" aria-label="회전 막대: 왼쪽 오른쪽" {...v.stickP?.["회전 막대: 왼쪽 오른쪽"]}>
              {" "}
              <svg viewBox="0 0 176 64" style={{"position":"absolute","inset":"0"}} aria-hidden="true">
                <g fill="none" stroke="#FFFFFF" strokeWidth="2.4" strokeLinecap="round">
                  <path d="M34 22a12 12 0 1 0 6 10" />
                  <path d="M34 16v7h7" />
                  <path d="M142 22a12 12 0 1 1 -6 10" />
                  <path d="M142 16v7h-7" />
                </g>
              </svg>
              {" "}
              <span ref={v.knobR?.["회전 막대: 왼쪽 오른쪽"]} style={{"position":"absolute","left":"62px","top":"6px","width":"52px","height":"52px","borderRadius":"50%","background":"rgba(230,235,239,.92)","boxShadow":"0 2px 8px rgba(0,0,0,.4)"}} />
              {" "}
            </div>
            {" "}
            <span style={{"fontSize":"12px","fontWeight":"600","textShadow":"0 1px 2px #000"}}>
              {v.lbl?.["회전"] ?? "회전"}
            </span>
            {" "}
          </div>
          {" "}
        </>) : null}
        {" "}
        {v.rotLeft ? (<>
          {" "}
          <div style={{"position":"absolute","left":"44px","bottom":"42px","display":"flex","flexDirection":"column","alignItems":"center","gap":"6px"}}>
            {" "}
            <div className="glass" style={{"position":"relative","width":"176px","height":"64px","borderRadius":"32px"}} role="group" aria-label="회전 막대: 왼쪽 오른쪽" {...v.stickP?.["회전 막대: 왼쪽 오른쪽"]}>
              {" "}
              <svg viewBox="0 0 176 64" style={{"position":"absolute","inset":"0"}} aria-hidden="true">
                <g fill="none" stroke="#FFFFFF" strokeWidth="2.4" strokeLinecap="round">
                  <path d="M34 22a12 12 0 1 0 6 10" />
                  <path d="M34 16v7h7" />
                  <path d="M142 22a12 12 0 1 1 -6 10" />
                  <path d="M142 16v7h-7" />
                </g>
              </svg>
              {" "}
              <span ref={v.knobR?.["회전 막대: 왼쪽 오른쪽"]} style={{"position":"absolute","left":"62px","top":"6px","width":"52px","height":"52px","borderRadius":"50%","background":"rgba(230,235,239,.92)"}} />
              {" "}
            </div>
            {" "}
            <span style={{"fontSize":"12px","fontWeight":"600","textShadow":"0 1px 2px #000"}}>
              {v.lbl?.["회전"] ?? "회전"}
            </span>
            {" "}
          </div>
          {" "}
          <div style={{"position":"absolute","right":"62px","bottom":"22px","display":"flex","flexDirection":"column","alignItems":"center","gap":"6px"}}>
            {" "}
            <div className="glass" style={{"position":"relative","width":"64px","height":"150px","borderRadius":"32px"}} role="group" aria-label="앞뒤 막대" {...v.stickP?.["앞뒤 막대"]}>
              {" "}
              <svg viewBox="0 0 64 150" style={{"position":"absolute","inset":"0"}} aria-hidden="true">
                <path d="M32 14l-7 8h14zM32 136l-7-8h14z" fill="#FFFFFF" />
              </svg>
              {" "}
              <span ref={v.knobR?.["앞뒤 막대"]} style={{"position":"absolute","left":"6px","top":"49px","width":"52px","height":"52px","borderRadius":"50%","background":"rgba(230,235,239,.92)"}} />
              {" "}
            </div>
            {" "}
            <span style={{"fontSize":"12px","fontWeight":"600","textShadow":"0 1px 2px #000"}}>
              {v.lbl?.["앞뒤"] ?? "앞뒤"}
            </span>
            {" "}
          </div>
          {" "}
        </>) : null}
        {" "}
        <div style={{"position":"absolute","left":"50%","bottom":"20px","transform":"translateX(-50%)","display":"flex","gap":"8px"}}>
          {" "}
          <div role="radiogroup" aria-label="속도" style={{"display":"flex","height":"44px","borderRadius":"22px","border":"1.5px solid rgba(230,235,239,.45)","background":"rgba(8,11,14,.55)","overflow":"hidden"}}>
            {" "}
            <button role="radio" aria-checked="true" style={{"padding":"0 14px","border":"0","background":"rgba(230,235,239,.92)","color":"#0B0E11","fontSize":"13px","fontWeight":"700"}} {...v.r0}>
              {"느리게"}
            </button>
            {" "}
            <button role="radio" aria-checked="false" style={{"padding":"0 14px","border":"0","background":"transparent","color":"#FFFFFF","fontSize":"13px","fontWeight":"600"}} {...v.r1}>
              {"보통"}
            </button>
            {" "}
          </div>
          {" "}
          <button className="pill" {...v.poseP}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M5 18h14M8 18V9l4-4 4 4v9" />
            </svg>
            {"자세"}
          </button>
          {" "}
          <a className="pill" href="#/MHome" style={{"textDecoration":"none"}}>
            {v.backT ?? "임무로 돌아가기"}
          </a>
          {v.give ?? null}
          {" "}
        </div>
        {" "}
      </div>
      {" "}
    </>
  );
}
