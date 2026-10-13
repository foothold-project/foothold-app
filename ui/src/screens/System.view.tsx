// 생성: scripts/dc2tsx.mjs ← web/System.dc.html (시각 원본). 생성 뒤 손으로 실데이터 연결 — 다시 생성해 덮지 않는다.
/* eslint-disable */
import { Fragment } from 'react';
import { arr, css, fn, iv, ivs, str } from '../dc/jsx';

export const PREVIEW = {"width":1440,"height":1560};
export const FONTS = ["https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap"];
export const CSS = "\nbody{margin:0}\n.fh{--bg:#0B0E11;--panel:#12171C;--panel2:#182028;--line:#26313A;--line2:#34424D;--text:#E6EBEF;--muted:#9AA7B3;--accent:#38C6D9;--on-accent:#061014;--ok:#5AA9FF;--warn:#FFB547;--bad:#FF5A52;--stop:#D7261E;--acc-bg:rgba(56,198,217,.12);--warn-bg:rgba(255,181,71,.12);--bad-bg:rgba(255,90,82,.13);--ok-bg:rgba(90,169,255,.10);font-family:'IBM Plex Sans KR',system-ui,sans-serif;color:var(--text);background:var(--bg);-webkit-font-smoothing:antialiased}\n.fh.light{--bg:#EDEFEA;--panel:#FFFFFF;--panel2:#F5F6F2;--line:#D7DBD3;--line2:#C2C8BF;--text:#12171C;--muted:#4F5A64;--accent:#006D7A;--on-accent:#FFFFFF;--ok:#1F5FBF;--warn:#9A5800;--bad:#B3261E;--stop:#C8201A;--acc-bg:rgba(0,109,122,.08);--warn-bg:rgba(154,88,0,.09);--bad-bg:rgba(179,38,30,.08);--ok-bg:rgba(31,95,191,.08)}\n.mono{font-family:'JetBrains Mono',ui-monospace,monospace;font-variant-numeric:tabular-nums}\nbutton{font:inherit;color:inherit}\nh2{margin:0;font-size:20px;font-weight:700}\n.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:20px;display:flex;flex-direction:column;gap:14px}\n.lbl{font-size:12px;color:var(--muted)}\n.sw{display:grid;grid-template-columns:40px 1fr auto auto;gap:12px;align-items:center;font-size:13px;padding:6px 0;border-top:1px solid var(--line)}\n.sw i{width:40px;height:28px;border-radius:4px;border:1px solid rgba(128,128,128,.35);display:block}\n.pr{display:flex;flex-direction:column;gap:4px;padding:14px;border:1px solid var(--line);border-radius:8px;background:var(--panel2)}\n.btn{height:44px;padding:0 16px;border:1px solid var(--line2);background:var(--panel2);border-radius:8px;display:inline-flex;align-items:center;gap:8px;font-weight:600;font-size:14px}\n";
/** 원본 틀이 읽는 값 이름 */
export type Vals = { themeClass?: any };

export function View({ v }: { v: Vals }) {
  return (
    <>
      {" "}
      {" "}
      <div className={`${str(v.themeClass)}` as any} style={{"minHeight":"100vh"}}>
        {" "}
        <div style={{"maxWidth":"1280px","margin":"0 auto","padding":"40px 24px 64px","display":"flex","flexDirection":"column","gap":"20px"}}>
          {" "}
          <header style={{"display":"flex","flexDirection":"column","gap":"8px"}}>
            {" "}
            <span style={{"fontSize":"12px","letterSpacing":".14em","fontWeight":"700","color":"var(--accent)"}}>
              {"FOOTHOLD · 디자인 시스템 v1"}
            </span>
            {" "}
            <h1 style={{"margin":"0","fontSize":"34px","fontWeight":"700","letterSpacing":"-.01em","textWrap":"balance"}}>
              {"위험 현장에서 한눈에 읽히는 관제 화면"}
            </h1>
            {" "}
            <p style={{"margin":"0","maxWidth":"720px","color":"var(--muted)","fontSize":"15px","lineHeight":"1.65","textWrap":"pretty"}}>
              {"운영자는 급하고, 장갑을 꼈고, 햇빛 아래서 로봇과 화면을 번갈아 봅니다. 모든 규칙은 이 상황에서 출발합니다."}
              {" 이 화면은 원본 시안 참고용입니다 — 아래 색·글꼴 값은 옛 시안 값이며, 현재 공식 규격은 "}<a href="./brand/SOURCE.md" style={{"color":"var(--accent)"}}>{"foothold-brand 7afd241 (brand/SOURCE.md)"}</a>{" 입니다."}
            </p>
            {" "}
          </header>
          {" "}
          <section className="card" aria-label="원칙">
            {" "}
            <h2>
              {"원칙"}
            </h2>
            {" "}
            <div style={{"display":"grid","gridTemplateColumns":"repeat(auto-fit,minmax(min(260px,100%),1fr))","gap":"10px"}}>
              {" "}
              <div className="pr">
                <b>
                  {"멈춤은 언제나 같은 자리"}
                </b>
                <span className="lbl" style={{"lineHeight":"1.5"}}>
                  {"STOP은 모든 화면에서 같은 위치·크기·색. 확인 창 없이 한 번에."}
                </span>
              </div>
              {" "}
              <div className="pr">
                <b>
                  {"지도가 중심"}
                </b>
                <span className="lbl" style={{"lineHeight":"1.5"}}>
                  {"위치·경로·측정값·발견물을 지도 한 장에 겹쳐 상황을 읽게 합니다."}
                </span>
              </div>
              {" "}
              <div className="pr">
                <b>
                  {"색만으로 말하지 않는다"}
                </b>
                <span className="lbl" style={{"lineHeight":"1.5"}}>
                  {"상태는 색 + 모양(● ▲ ■) + 글자. 흑백 인쇄에서도 구분됩니다."}
                </span>
              </div>
              {" "}
              <div className="pr">
                <b>
                  {"자동 조치는 이유와 함께"}
                </b>
                <span className="lbl" style={{"lineHeight":"1.5"}}>
                  {"로봇이 스스로 한 일은 무엇을, 왜(어떤 정책), 언제 했는지 함께 보여 줍니다."}
                </span>
              </div>
              {" "}
              <div className="pr">
                <b>
                  {"모르는 값은 모른다고"}
                </b>
                <span className="lbl" style={{"lineHeight":"1.5"}}>
                  {"끊기거나 멎은 값은 흐리게 하고 «마지막 수신 n초 전»을 붙입니다. 추정은 «예상»이라 씁니다."}
                </span>
              </div>
              {" "}
              <div className="pr">
                <b>
                  {"AI는 제안, 판단은 사람"}
                </b>
                <span className="lbl" style={{"lineHeight":"1.5"}}>
                  {"탐지 결과는 «확인 대기»로 들어오고, 사람이 «맞음»을 눌러야 기록에 남습니다."}
                </span>
              </div>
              {" "}
            </div>
            {" "}
          </section>
          {" "}
          <div style={{"display":"grid","gridTemplateColumns":"repeat(auto-fit,minmax(min(560px,100%),1fr))","gap":"20px"}}>
            {" "}
            <section className="card" aria-label="색">
              {" "}
              <h2>
                {"색 토큰"}
              </h2>
              {" "}
              <span className="lbl">
                {"어두운 = 관제 PC·야간·실내 · 밝은 = 야외·직사광선. 배치는 같고 색만 바뀝니다."}
              </span>
              {" "}
              <div>
                {" "}
                <div className="sw" style={{"borderTop":"0"}}>
                  <span />
                  <span className="lbl">
                    {"역할"}
                  </span>
                  <span className="lbl">
                    {"어두운"}
                  </span>
                  <span className="lbl">
                    {"밝은"}
                  </span>
                </div>
                {" "}
                <div className="sw">
                  <span style={{"display":"flex","gap":"2px"}}>
                    <i style={{"width":"19px","background":"#0B0E11"}} />
                    <i style={{"width":"19px","background":"#EDEFEA"}} />
                  </span>
                  <span>
                    {"바탕"}
                  </span>
                  <span className="mono">
                    {"#0B0E11"}
                  </span>
                  <span className="mono">
                    {"#EDEFEA"}
                  </span>
                </div>
                {" "}
                <div className="sw">
                  <span style={{"display":"flex","gap":"2px"}}>
                    <i style={{"width":"19px","background":"#12171C"}} />
                    <i style={{"width":"19px","background":"#FFFFFF"}} />
                  </span>
                  <span>
                    {"카드"}
                  </span>
                  <span className="mono">
                    {"#12171C"}
                  </span>
                  <span className="mono">
                    {"#FFFFFF"}
                  </span>
                </div>
                {" "}
                <div className="sw">
                  <span style={{"display":"flex","gap":"2px"}}>
                    <i style={{"width":"19px","background":"#E6EBEF"}} />
                    <i style={{"width":"19px","background":"#12171C"}} />
                  </span>
                  <span>
                    {"글자"}
                  </span>
                  <span className="mono">
                    {"#E6EBEF"}
                  </span>
                  <span className="mono">
                    {"#12171C"}
                  </span>
                </div>
                {" "}
                <div className="sw">
                  <span style={{"display":"flex","gap":"2px"}}>
                    <i style={{"width":"19px","background":"#9AA7B3"}} />
                    <i style={{"width":"19px","background":"#4F5A64"}} />
                  </span>
                  <span>
                    {"보조 글자 (4.5:1 이상)"}
                  </span>
                  <span className="mono">
                    {"#9AA7B3"}
                  </span>
                  <span className="mono">
                    {"#4F5A64"}
                  </span>
                </div>
                {" "}
                <div className="sw">
                  <span style={{"display":"flex","gap":"2px"}}>
                    <i style={{"width":"19px","background":"#38C6D9"}} />
                    <i style={{"width":"19px","background":"#006D7A"}} />
                  </span>
                  <span>
                    {"강조 · 주 버튼 · 로봇"}
                  </span>
                  <span className="mono">
                    {"#38C6D9"}
                  </span>
                  <span className="mono">
                    {"#006D7A"}
                  </span>
                </div>
                {" "}
                <div className="sw">
                  <span style={{"display":"flex","gap":"2px"}}>
                    <i style={{"width":"19px","background":"#5AA9FF"}} />
                    <i style={{"width":"19px","background":"#1F5FBF"}} />
                  </span>
                  <span>
                    {"● 정상"}
                  </span>
                  <span className="mono">
                    {"#5AA9FF"}
                  </span>
                  <span className="mono">
                    {"#1F5FBF"}
                  </span>
                </div>
                {" "}
                <div className="sw">
                  <span style={{"display":"flex","gap":"2px"}}>
                    <i style={{"width":"19px","background":"#FFB547"}} />
                    <i style={{"width":"19px","background":"#9A5800"}} />
                  </span>
                  <span>
                    {"▲ 주의"}
                  </span>
                  <span className="mono">
                    {"#FFB547"}
                  </span>
                  <span className="mono">
                    {"#9A5800"}
                  </span>
                </div>
                {" "}
                <div className="sw">
                  <span style={{"display":"flex","gap":"2px"}}>
                    <i style={{"width":"19px","background":"#FF5A52"}} />
                    <i style={{"width":"19px","background":"#B3261E"}} />
                  </span>
                  <span>
                    {"■ 위험 (경보 띠는 둘 다 #B3261E)"}
                  </span>
                  <span className="mono">
                    {"#FF5A52"}
                  </span>
                  <span className="mono">
                    {"#B3261E"}
                  </span>
                </div>
                {" "}
                <div className="sw">
                  <span style={{"display":"flex","gap":"2px"}}>
                    <i style={{"width":"19px","background":"#D7261E"}} />
                    <i style={{"width":"19px","background":"#C8201A"}} />
                  </span>
                  <span>
                    {"STOP 전용 · 다른 곳에 쓰지 않음"}
                  </span>
                  <span className="mono">
                    {"#D7261E"}
                  </span>
                  <span className="mono">
                    {"#C8201A"}
                  </span>
                </div>
                {" "}
              </div>
              {" "}
              <span className="lbl" style={{"lineHeight":"1.5"}}>
                {"정상을 초록이 아닌 파랑으로 둔 이유: 적록 색약에서 주의(주황)와 구분되고, 밝기 차이도 큽니다."}
              </span>
              {" "}
            </section>
            {" "}
            <section className="card" aria-label="글꼴">
              {" "}
              <h2>
                {"글꼴"}
              </h2>
              {" "}
              <div style={{"display":"flex","flexDirection":"column","gap":"10px"}}>
                {" "}
                <div style={{"display":"flex","alignItems":"baseline","gap":"16px","borderTop":"1px solid var(--line)","paddingTop":"10px"}}>
                  <span className="lbl mono" style={{"width":"72px"}}>
                    {"28 / 700"}
                  </span>
                  <span style={{"fontSize":"28px","fontWeight":"700"}}>
                    {"경보 제목"}
                  </span>
                </div>
                {" "}
                <div style={{"display":"flex","alignItems":"baseline","gap":"16px","borderTop":"1px solid var(--line)","paddingTop":"10px"}}>
                  <span className="lbl mono" style={{"width":"72px"}}>
                    {"17 / 600"}
                  </span>
                  <span style={{"fontSize":"17px","fontWeight":"600"}}>
                    {"화면 제목 · 현재 단계"}
                  </span>
                </div>
                {" "}
                <div style={{"display":"flex","alignItems":"baseline","gap":"16px","borderTop":"1px solid var(--line)","paddingTop":"10px"}}>
                  <span className="lbl mono" style={{"width":"72px"}}>
                    {"14 / 400"}
                  </span>
                  <span style={{"fontSize":"14px"}}>
                    {"본문 · 버튼 · 목록"}
                  </span>
                </div>
                {" "}
                <div style={{"display":"flex","alignItems":"baseline","gap":"16px","borderTop":"1px solid var(--line)","paddingTop":"10px"}}>
                  <span className="lbl mono" style={{"width":"72px"}}>
                    {"12 / 400"}
                  </span>
                  <span style={{"fontSize":"12px","color":"var(--muted)"}}>
                    {"보조 설명 · 최소 크기"}
                  </span>
                </div>
                {" "}
                <div style={{"display":"flex","alignItems":"baseline","gap":"16px","borderTop":"1px solid var(--line)","paddingTop":"10px"}}>
                  <span className="lbl mono" style={{"width":"72px"}}>
                    {"26 / 600"}
                  </span>
                  <span className="mono" style={{"fontSize":"26px","fontWeight":"600"}}>
                    {"12.4 ppm · 10:46:08"}
                  </span>
                </div>
                {" "}
              </div>
              {" "}
              <span className="lbl" style={{"lineHeight":"1.5"}}>
                {"IBM Plex Sans KR — 한글 본문. JetBrains Mono — 측정값·시각·좌표(자릿수 고정으로 값이 바뀌어도 흔들리지 않음)."}
              </span>
              {" "}
            </section>
            {" "}
          </div>
          {" "}
          <section className="card" aria-label="상태 언어">
            {" "}
            <h2>
              {"상태 언어"}
            </h2>
            {" "}
            <div style={{"display":"grid","gridTemplateColumns":"repeat(auto-fit,minmax(min(220px,100%),1fr))","gap":"10px"}}>
              {" "}
              <div className="pr" style={{"borderColor":"var(--ok)"}}>
                <b style={{"color":"var(--ok)"}}>
                  {"● 정상"}
                </b>
                <span className="lbl" style={{"lineHeight":"1.5"}}>
                  {"기준 안. 조치 없음. 화면에서 조용히."}
                </span>
              </div>
              {" "}
              <div className="pr" style={{"borderColor":"var(--warn)","background":"var(--warn-bg)"}}>
                <b style={{"color":"var(--warn)"}}>
                  {"▲ 주의"}
                </b>
                <span className="lbl" style={{"lineHeight":"1.5"}}>
                  {"팀이 정한 주의값(기본 기준의 50%) 이상. 진동 1회, 테두리 강조."}
                </span>
              </div>
              {" "}
              <div className="pr" style={{"borderColor":"var(--bad)","background":"var(--bad-bg)"}}>
                <b style={{"color":"var(--bad)"}}>
                  {"■ 위험"}
                </b>
                <span className="lbl" style={{"lineHeight":"1.5"}}>
                  {"법정 기준 초과·통신 끊김. 경보 띠 + 소리 + 반복 진동 + 휴대폰 긴급 알림."}
                </span>
              </div>
              {" "}
              <div className="pr" style={{"opacity":".62"}}>
                <b>
                  {"○ 멎음 · 미확인"}
                </b>
                <span className="lbl" style={{"lineHeight":"1.5"}}>
                  {"값이 없거나 오래됨. 흐리게 + «마지막 수신 n초 전». 숫자를 지어내지 않습니다."}
                </span>
              </div>
              {" "}
            </div>
            {" "}
          </section>
          {" "}
          <div style={{"display":"grid","gridTemplateColumns":"repeat(auto-fit,minmax(min(560px,100%),1fr))","gap":"20px"}}>
            {" "}
            <section className="card" aria-label="STOP과 버튼">
              {" "}
              <h2>
                {"STOP과 버튼"}
              </h2>
              {" "}
              <div style={{"display":"flex","flexWrap":"wrap","gap":"16px","alignItems":"center"}}>
                {" "}
                <button aria-label="비상 정지" style={{"height":"52px","minWidth":"136px","padding":"0 18px","border":"0","borderRadius":"8px","background":"var(--stop)","color":"#FFFFFF","display":"flex","alignItems":"center","gap":"10px","boxShadow":"0 0 0 3px rgba(215,38,30,.22)"}}>
                  {" "}
                  <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M8 2h8l6 6v8l-6 6H8l-6-6V8z" fill="none" stroke="#FFFFFF" strokeWidth="2" />
                    <rect x="8" y="8" width="8" height="8" fill="#FFFFFF" />
                  </svg>
                  {" "}
                  <span style={{"fontWeight":"700","fontSize":"19px","letterSpacing":".08em"}}>
                    {"STOP"}
                  </span>
                  {" "}
                </button>
                {" "}
                <span className="lbl" style={{"flex":"1","minWidth":"220px","lineHeight":"1.55"}}>
                  {"PC: 머리줄 오른쪽 끝, 52 px, 스페이스 키. 휴대폰 세로: 맨 아래 전체 폭 64 px. 휴대폰 가로: 오른쪽 위 132×64. 해제는 STOP과 다른 자리의 «정지 해제» → «임무 계속» 두 번."}
                </span>
                {" "}
              </div>
              {" "}
              <div style={{"display":"flex","flexWrap":"wrap","gap":"8px","alignItems":"center"}}>
                {" "}
                <button className="btn" style={{"background":"var(--accent)","borderColor":"var(--accent)","color":"var(--on-accent)"}}>
                  {"주 버튼"}
                </button>
                {" "}
                <button className="btn">
                  {"보조 버튼"}
                </button>
                {" "}
                <button className="btn" style={{"background":"var(--line)","borderColor":"var(--line)","color":"var(--muted)"}} disabled={!!(true)}>
                  {"임무 시작"}
                </button>
                {" "}
                <span style={{"fontSize":"12px","color":"var(--warn)"}}>
                  {"▲ 막힌 버튼은 숨기지 않고 한 줄 이유를 붙입니다"}
                </span>
                {" "}
              </div>
              {" "}
              <div className="lbl" style={{"lineHeight":"1.6"}}>
                {"누르는 곳 최소 44 px(휴대폰 주요 동작 52–56 px), 서로 8 px 이상. 화면마다 주 버튼은 하나. 되돌릴 수 있는 일은 확인 창 대신 «취소». 되돌릴 수 없는 장비 작업만 2초 길게 누르기."}
              </div>
              {" "}
            </section>
            {" "}
            <section className="card" aria-label="지도 기호">
              {" "}
              <h2>
                {"지도 기호"}
              </h2>
              {" "}
              <div style={{"display":"grid","gridTemplateColumns":"repeat(auto-fit,minmax(min(220px,100%),1fr))","gap":"10px 16px","fontSize":"13px"}}>
                {" "}
                <span style={{"display":"flex","alignItems":"center","gap":"10px"}}>
                  <svg width="28" height="28" viewBox="-16 -16 32 32" aria-hidden="true">
                    <path d="M0 -12 L9 9 L0 4 L-9 9 Z" style={{"fill":"var(--accent)"}} />
                  </svg>
                  {"로봇 · 방향 · 시야 부채꼴"}
                </span>
                {" "}
                <span style={{"display":"flex","alignItems":"center","gap":"10px"}}>
                  <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
                    <rect x="2" y="2" width="24" height="24" rx="4" fill="none" style={{"stroke":"var(--text)"}} strokeWidth="2" />
                  </svg>
                  {"S 출발점"}
                </span>
                {" "}
                <span style={{"display":"flex","alignItems":"center","gap":"10px"}}>
                  <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
                    <circle cx="14" cy="14" r="11" style={{"fill":"var(--ok)"}} />
                  </svg>
                  {"측정 완료 지점"}
                </span>
                {" "}
                <span style={{"display":"flex","alignItems":"center","gap":"10px"}}>
                  <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
                    <circle cx="14" cy="14" r="11" fill="none" style={{"stroke":"var(--accent)"}} strokeWidth="3" />
                  </svg>
                  {"다음 지점"}
                </span>
                {" "}
                <span style={{"display":"flex","alignItems":"center","gap":"10px"}}>
                  <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
                    <rect x="8" y="8" width="12" height="12" transform="rotate(45 14 14)" style={{"fill":"var(--warn)"}} />
                  </svg>
                  {"발견물 (확인 대기·맞음)"}
                </span>
                {" "}
                <span style={{"display":"flex","alignItems":"center","gap":"10px"}}>
                  <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
                    <circle cx="14" cy="14" r="11" fill="none" style={{"stroke":"var(--bad)"}} strokeWidth="3" />
                    <text x="14" y="19" textAnchor="middle" fontSize="13" fontWeight="700" style={{"fill":"var(--bad)"}} fontFamily="JetBrains Mono, monospace">
                      {"R"}
                    </text>
                  </svg>
                  {"후퇴 지점"}
                </span>
                {" "}
                <span style={{"display":"flex","alignItems":"center","gap":"10px"}}>
                  <span style={{"width":"28px","height":"18px","background":"var(--bad-bg)","border":"1px dashed var(--bad)"}} />
                  {"진입 금지 (Nav2 keepout)"}
                </span>
                {" "}
                <span style={{"display":"flex","alignItems":"center","gap":"10px"}}>
                  <span style={{"width":"28px","height":"18px","background":"var(--warn-bg)","border":"1px dashed var(--warn)"}} />
                  {"통신 약함 (지난 순찰 기록)"}
                </span>
                {" "}
              </div>
              {" "}
            </section>
            {" "}
          </div>
          {" "}
          <section className="card" aria-label="임무 구조">
            {" "}
            <h2>
              {"임무 = 고정된 뼈대 + 고를 수 있는 모듈"}
            </h2>
            {" "}
            <p style={{"margin":"0","maxWidth":"820px","color":"var(--muted)","fontSize":"14px","lineHeight":"1.65"}}>
              {"분야를 정하지 않아도 앱이 흔들리지 않게, 화면과 보고서를 «뼈대»와 «모듈 칸»으로 나눕니다. 임무 양식에 모듈을 넣고 빼면 관제 화면의 패널, 경보, 보고서의 표 열과 절이 따라 바뀝니다. 뼈대는 어떤 임무에서도 그대로입니다."}
            </p>
            {" "}
            <div style={{"display":"grid","gridTemplateColumns":"repeat(auto-fit,minmax(min(260px,100%),1fr))","gap":"10px"}}>
              {" "}
              <div className="pr">
                <b>
                  {"뼈대 · 언제나 같음"}
                </b>
                <span className="lbl" style={{"lineHeight":"1.6"}}>
                  {"지도 · 영상 · 로봇 상태 · 임무 단계 · 사건 기록 · STOP · 통신 끊김 정책 · 보고서의 개요·경로·지점별 결과·서명"}
                </span>
              </div>
              {" "}
              <div className="pr">
                <b>
                  {"모듈 · 양식마다 다름"}
                </b>
                <span className="lbl" style={{"lineHeight":"1.6"}}>
                  {"사진 · 운영자 확인 · AI 탐지 · 가스 측정 · 대기 · 음성 방송 · (장비가 생기면) 열화상 · 계기판 판독"}
                </span>
              </div>
              {" "}
              <div className="pr">
                <b>
                  {"모듈 하나가 가져오는 것"}
                </b>
                <span className="lbl" style={{"lineHeight":"1.6"}}>
                  {"① 계획 화면의 설정 칸 ② 관제 화면의 패널 ③ 경보 규칙의 조건 ④ 보고서의 표 열·절. 새 분야는 모듈 하나를 더하는 일입니다."}
                </span>
              </div>
              {" "}
              <div className="pr">
                <b>
                  {"장비가 없는 모듈"}
                </b>
                <span className="lbl" style={{"lineHeight":"1.6"}}>
                  {"로봇에 등록된 장비만 고를 수 있습니다. 없는 장비를 쓰는 양식은 «실행할 수 없음 + 이유»로 보입니다."}
                </span>
              </div>
              {" "}
            </div>
            {" "}
          </section>
          {" "}
          <section className="card" aria-label="경보 단계">
            {" "}
            <h2>
              {"경보가 사람에게 닿는 순서"}
            </h2>
            {" "}
            <div style={{"display":"grid","gridTemplateColumns":"repeat(auto-fit,minmax(min(220px,100%),1fr))","gap":"10px"}}>
              {" "}
              <div className="pr">
                <span className="mono lbl">
                  {"0 s"}
                </span>
                <b>
                  {"로봇이 먼저 조치"}
                </b>
                <span className="lbl" style={{"lineHeight":"1.5"}}>
                  {"임무 설정의 정책대로 일시정지·후퇴. 사람의 응답을 기다리지 않습니다."}
                </span>
              </div>
              {" "}
              <div className="pr">
                <span className="mono lbl">
                  {"0 s"}
                </span>
                <b>
                  {"모든 화면에 경보 띠"}
                </b>
                <span className="lbl" style={{"lineHeight":"1.5"}}>
                  {"PC 소리, 휴대폰 진동 + 잠금 화면 긴급 알림. 무음 모드에서도 울림(설정)."}
                </span>
              </div>
              {" "}
              <div className="pr">
                <span className="mono lbl">
                  {"30 s"}
                </span>
                <b>
                  {"응답이 없으면 넓힌다"}
                </b>
                <span className="lbl" style={{"lineHeight":"1.5"}}>
                  {"현장 책임자에게 같은 경보를 보냅니다. 기록에 «미응답 30초» 남김."}
                </span>
              </div>
              {" "}
              <div className="pr">
                <span className="mono lbl">
                  {"확인"}
                </span>
                <b>
                  {"사람이 다음 행동을 고른다"}
                </b>
                <span className="lbl" style={{"lineHeight":"1.5"}}>
                  {"후퇴 계속 · 그 자리 정지 · 직접 조종. 자동 재개는 없습니다."}
                </span>
              </div>
              {" "}
            </div>
            {" "}
          </section>
          {" "}
        </div>
        {" "}
      </div>
      {" "}
    </>
  );
}
