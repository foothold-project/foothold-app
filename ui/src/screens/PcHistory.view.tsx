// 생성: scripts/dc2tsx.mjs (손 수정: 예시 자리마다 v.<이름> ?? 예시 — 실화면은 모든 자리를 넘김, 대조 시험은 예시 그대로)
// ← web/PcHistory.dc.html (시각 원본). 생성 뒤 손으로 실데이터 연결 — 다시 생성해 덮지 않는다.
/* eslint-disable */
import { Fragment } from 'react';
import { arr, css, fn, iv, ivs, str } from '../dc/jsx';
import { BrandLogo } from '../app/BrandLogo';   // 공식 로고(브랜드 변경)

export const PREVIEW = {"width":1440,"height":940};
export const FONTS = ["https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap"];
export const CSS = "\nbody{margin:0}\n.fh{--bg:#0B0E11;--panel:#12171C;--panel2:#182028;--line:#26313A;--line2:#34424D;--text:#E6EBEF;--muted:#9AA7B3;--accent:#38C6D9;--on-accent:#061014;--ok:#5AA9FF;--warn:#FFB547;--bad:#FF5A52;--stop:#D7261E;--acc-bg:rgba(56,198,217,.12);--warn-bg:rgba(255,181,71,.12);--bad-bg:rgba(255,90,82,.13);--ok-bg:rgba(90,169,255,.10);font-family:'IBM Plex Sans KR',system-ui,sans-serif;color:var(--text);background:var(--bg);-webkit-font-smoothing:antialiased}\n.fh.light{--bg:#EDEFEA;--panel:#FFFFFF;--panel2:#F5F6F2;--line:#D7DBD3;--line2:#C2C8BF;--text:#12171C;--muted:#4F5A64;--accent:#006D7A;--on-accent:#FFFFFF;--ok:#1F5FBF;--warn:#9A5800;--bad:#B3261E;--stop:#C8201A;--acc-bg:rgba(0,109,122,.08);--warn-bg:rgba(154,88,0,.09);--bad-bg:rgba(179,38,30,.08);--ok-bg:rgba(31,95,191,.08)}\n.mono{font-family:'JetBrains Mono',ui-monospace,monospace;font-variant-numeric:tabular-nums}\nbutton,input,select{font:inherit;color:inherit}\nbutton{cursor:pointer}\n.card{background:var(--panel);border:1px solid var(--line);border-radius:10px}\n.lbl{font-size:12px;color:var(--muted)}\n.sel{height:40px;padding:0 10px;border:1px solid var(--line2);border-radius:6px;background:var(--panel2);font-size:13px}\n.btn{height:40px;padding:0 14px;border:1px solid var(--line2);background:var(--panel2);border-radius:8px;display:inline-flex;align-items:center;gap:6px;font-weight:600;font-size:13px}\ntable{border-collapse:collapse;width:100%;font-size:13px}\nth{font-size:12px;font-weight:600;color:var(--muted);text-align:left;padding:10px 12px;border-bottom:1px solid var(--line2);white-space:nowrap}\ntd{padding:12px;border-bottom:1px solid var(--line);white-space:nowrap}\ntr:hover td{background:var(--panel2)}\n.r{text-align:right}\n.res{font-size:12px;font-weight:600;padding:3px 8px;border-radius:999px;white-space:nowrap}\n.res.ok{color:var(--ok);background:var(--ok-bg)}\n.res.warn{color:var(--warn);background:var(--warn-bg)}\n.res.bad{color:var(--bad);background:var(--bad-bg)}\n.res.stop{color:var(--muted);border:1px solid var(--line2)}\n.nav{display:flex;flex-direction:column;align-items:center;gap:4px;width:64px;padding:10px 0;border-radius:8px;font-size:11px;color:var(--muted);text-decoration:none}\n.nav:hover{color:var(--text);background:var(--panel2)}\n.nav.cur{color:var(--text);background:var(--acc-bg)}\n.nav.cur svg{color:var(--accent)}\n/* 승인 수정(10-12): PC 머리줄(STOP 포함)은 스크롤해도 화면 위에 남는다 — 불투명 배경(--panel)이 아래 내용을 가린 채 위에 놓임 */\nheader{position:sticky;top:0;z-index:10}\n";
/** 원본 틀이 읽는 값 이름 */
export type Vals = { h2?: any; status?: any; stopProps?: any; stats?: any; qProps?: any; sPer?: any; sTpl?: any; sRes?: any; sBy?: any; exP?: any; exT?: any; rows?: any; pgL?: any; pages?: any; themeClass?: any };

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
            <BrandLogo h={24} />
            {" "}
          </div>
          {" "}
          <div style={{"width":"1px","height":"32px","background":"var(--line)"}} />
          {" "}
          <div style={{"display":"flex","flexDirection":"column","gap":"2px"}}>
            {" "}
            <span style={{"fontSize":"12px","color":"var(--muted)"}}>
              {"기록"}
            </span>
            {" "}
            <span style={{"fontSize":"17px","fontWeight":"600"}}>
              {v.h2 ?? "임무 기록"}
            </span>
            {" "}
          </div>
          {" "}
          <div style={{"flex":"1"}} />
          {" "}
          {v.status ?? null}
<button aria-label="비상 정지" {...v.stopProps} style={{"height":"52px","minWidth":"136px","padding":"0 18px","border":"0","borderRadius":"8px","background":"var(--stop)","color":"#FFFFFF","display":"flex","alignItems":"center","gap":"10px","boxShadow":"0 0 0 3px rgba(215,38,30,.22)"}}>
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
            <a className="nav cur" href="#/PcHistory" aria-current="page">
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
            <a className="nav" href="#/PcRobot">
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
          <main style={{"flex":"999 1 600px","minWidth":"0","display":"flex","flexDirection":"column","gap":"12px","padding":"12px"}}>
            {" "}
            <section aria-label="요약" style={{"display":"grid","gridTemplateColumns":"repeat(auto-fit,minmax(min(200px,100%),1fr))","gap":"12px"}}>
              {" "}
              <div className="card" style={{"padding":"14px 16px","display":"flex","flexDirection":"column","gap":"4px"}}>
                <span className="lbl">
                  {v.stats?.[0]?.[0] ?? "최근 30일 임무"}
                </span>
                <span className="mono" style={{"fontSize":"26px","fontWeight":"600"}}>
                  {v.stats?.[0]?.[1] ?? "23"}
                </span>
                <span className="lbl">
                  {v.stats?.[0]?.[2] ?? "완료 19 · 중단 4"}
                </span>
              </div>
              {" "}
              <div className="card" style={{"padding":"14px 16px","display":"flex","flexDirection":"column","gap":"4px"}}>
                <span className="lbl">
                  {v.stats?.[1]?.[0] ?? "경보 규칙 발동"}
                </span>
                <span className="mono" style={{"fontSize":"26px","fontWeight":"600","color":"var(--bad)"}}>
                  {v.stats?.[1]?.[1] ?? "2"}
                </span>
                <span className="lbl">
                  {v.stats?.[1]?.[2] ?? "자동 후퇴 2 · 사람 개입 0"}
                </span>
              </div>
              {" "}
              <div className="card" style={{"padding":"14px 16px","display":"flex","flexDirection":"column","gap":"4px","borderColor":"var(--warn)"}}>
                <span className="lbl">
                  {v.stats?.[2]?.[0] ?? "발견물 확인 대기"}
                </span>
                <span className="mono" style={{"fontSize":"26px","fontWeight":"600","color":"var(--warn)"}}>
                  {v.stats?.[2]?.[1] ?? "1"}
                </span>
                <a href="#/PcReview" style={{"fontSize":"12px","color":"var(--accent)"}}>
                  {v.stats?.[2]?.[2] ?? "지금 확인 →"}
                </a>
              </div>
              {" "}
              <div className="card" style={{"padding":"14px 16px","display":"flex","flexDirection":"column","gap":"4px"}}>
                <span className="lbl">
                  {v.stats?.[3]?.[0] ?? "평균 소요 · 주행"}
                </span>
                <span className="mono" style={{"fontSize":"26px","fontWeight":"600"}}>
                  {v.stats?.[3]?.[1] ?? "19분"}
                </span>
                <span className="lbl">
                  {v.stats?.[3]?.[2] ?? "평균 136 m · 통신 끊김 3회"}
                </span>
              </div>
              {" "}
            </section>
            {" "}
            <section aria-label="기록 목록" className="card" style={{"display":"flex","flexDirection":"column"}}>
              {" "}
              <div role="search" style={{"display":"flex","flexWrap":"wrap","gap":"8px","alignItems":"center","padding":"12px 14px","borderBottom":"1px solid var(--line)"}}>
                {" "}
                <label style={{"position":"relative","flex":"1 1 220px","maxWidth":"320px"}}>
                  {" "}
                  <span className="lbl" style={{"position":"absolute","left":"-9999px"}}>
                    {"검색"}
                  </span>
                  {" "}
                  <input className="sel" style={{"width":"100%","boxSizing":"border-box","paddingLeft":"34px"}} placeholder="임무 이름 · 장소 · 기록 번호" {...v.qProps} />
                  {" "}
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{"position":"absolute","left":"11px","top":"12px","color":"var(--muted)"}} aria-hidden="true">
                    <circle cx="11" cy="11" r="7" />
                    <path d="M20 20l-4-4" />
                  </svg>
                  {" "}
                </label>
                {" "}
                <select className="sel" aria-label="기간" {...v.sPer?.p}>
{v.sPer?.o ?? (<>
                  <option>
                    {"최근 30일"}
                  </option>
                  <option>
                    {"오늘"}
                  </option>
                  <option>
                    {"최근 7일"}
                  </option>
                </>)}
</select>
                {" "}
                <select className="sel" aria-label="임무 양식" {...v.sTpl?.p}>
{v.sTpl?.o ?? (<>
                  <option>
                    {"모든 양식"}
                  </option>
                  <option>
                    {"지점 확인 다녀오기"}
                  </option>
                  <option>
                    {"가스 사전 측정"}
                  </option>
                  <option>
                    {"시설 순찰"}
                  </option>
                </>)}
</select>
                {" "}
                <select className="sel" aria-label="결과" {...v.sRes?.p}>
{v.sRes?.o ?? (<>
                  <option>
                    {"모든 결과"}
                  </option>
                  <option>
                    {"완료"}
                  </option>
                  <option>
                    {"조치 필요"}
                  </option>
                  <option>
                    {"경보 · 중단"}
                  </option>
                </>)}
</select>
                {" "}
                <select className="sel" aria-label="운영자" {...v.sBy?.p}>
{v.sBy?.o ?? (<>
                  <option>
                    {"모든 운영자"}
                  </option>
                </>)}
</select>
                {" "}
                <div style={{"flex":"1"}} />
                {" "}
                <button className="btn" {...v.exP}>
                  {v.exT ?? "선택 내보내기 (PDF · CSV)"}
                </button>
                {" "}
              </div>
              {" "}
              <div style={{"overflowX":"auto"}}>
                {" "}
                <table>
                  {" "}
                  <thead>
                    <tr>
                      <th>
                        {"일시"}
                      </th>
                      <th>
                        {"임무"}
                      </th>
                      <th>
                        {"양식"}
                      </th>
                      <th>
                        {"장소"}
                      </th>
                      <th>
                        {"운영자"}
                      </th>
                      <th className="r">
                        {"소요"}
                      </th>
                      <th className="r">
                        {"지점"}
                      </th>
                      <th>
                        {"결과"}
                      </th>
                      <th className="r">
                        {"발견물"}
                      </th>
                      <th>
                        {"보고서"}
                      </th>
                    </tr>
                  </thead>
                  {" "}
                  <tbody>
{v.rows ?? (<>
                    {" "}
                    <tr>
                      <td className="mono">
                        {"10-12 10:31"}
                      </td>
                      <td>
                        <a href="#/PcReview" style={{"color":"inherit","fontWeight":"600"}}>
                          {"지하 펌프실 사전 측정"}
                        </a>
                      </td>
                      <td>
                        {"가스 사전 측정"}
                      </td>
                      <td>
                        {"[현장명] B1"}
                      </td>
                      <td>
                        {"운영자 A"}
                      </td>
                      <td className="mono r">
                        {"21분"}
                      </td>
                      <td className="mono r">
                        {"3/4"}
                      </td>
                      <td>
                        <span className="res bad">
                          {"■ 경보 · 중단"}
                        </span>
                      </td>
                      <td className="mono r">
                        {"2 "}
                        <span style={{"color":"var(--warn)"}}>
                          {"· 대기 1"}
                        </span>
                      </td>
                      <td>
                        <a href="#/Report" style={{"color":"var(--accent)"}}>
                          {"PDF"}
                        </a>
                      </td>
                    </tr>
                    {" "}
                    <tr>
                      <td className="mono">
                        {"10-12 09:05"}
                      </td>
                      <td style={{"fontWeight":"600"}}>
                        {"출입로 확인"}
                      </td>
                      <td>
                        {"지점 확인 다녀오기"}
                      </td>
                      <td>
                        {"[현장명] B1"}
                      </td>
                      <td>
                        {"운영자 B"}
                      </td>
                      <td className="mono r">
                        {"9분"}
                      </td>
                      <td className="mono r">
                        {"2/2"}
                      </td>
                      <td>
                        <span className="res ok">
                          {"● 완료"}
                        </span>
                      </td>
                      <td className="mono r">
                        {"—"}
                      </td>
                      <td>
                        <a href="#/Report" style={{"color":"var(--accent)"}}>
                          {"PDF"}
                        </a>
                      </td>
                    </tr>
                    {" "}
                    <tr>
                      <td className="mono">
                        {"10-11 16:40"}
                      </td>
                      <td style={{"fontWeight":"600"}}>
                        {"B1 정기 순찰"}
                      </td>
                      <td>
                        {"시설 순찰"}
                      </td>
                      <td>
                        {"[현장명] B1"}
                      </td>
                      <td>
                        {"운영자 B"}
                      </td>
                      <td className="mono r">
                        {"24분"}
                      </td>
                      <td className="mono r">
                        {"4/4"}
                      </td>
                      <td>
                        <span className="res warn">
                          {"▲ 조치 필요"}
                        </span>
                      </td>
                      <td className="mono r">
                        {"3"}
                      </td>
                      <td>
                        <a href="#/Report" style={{"color":"var(--accent)"}}>
                          {"PDF"}
                        </a>
                      </td>
                    </tr>
                    {" "}
                    <tr>
                      <td className="mono">
                        {"10-11 11:12"}
                      </td>
                      <td style={{"fontWeight":"600"}}>
                        {"B1 정기 순찰"}
                      </td>
                      <td>
                        {"시설 순찰"}
                      </td>
                      <td>
                        {"[현장명] B1"}
                      </td>
                      <td>
                        {"운영자 C"}
                      </td>
                      <td className="mono r">
                        {"22분"}
                      </td>
                      <td className="mono r">
                        {"4/4"}
                      </td>
                      <td>
                        <span className="res ok">
                          {"● 완료"}
                        </span>
                      </td>
                      <td className="mono r">
                        {"0"}
                      </td>
                      <td>
                        <a href="#/Report" style={{"color":"var(--accent)"}}>
                          {"PDF"}
                        </a>
                      </td>
                    </tr>
                    {" "}
                    <tr>
                      <td className="mono">
                        {"10-10 15:02"}
                      </td>
                      <td style={{"fontWeight":"600"}}>
                        {"펌프실 재측정"}
                      </td>
                      <td>
                        {"가스 사전 측정"}
                      </td>
                      <td>
                        {"[현장명] B1"}
                      </td>
                      <td>
                        {"운영자 A"}
                      </td>
                      <td className="mono r">
                        {"17분"}
                      </td>
                      <td className="mono r">
                        {"4/4"}
                      </td>
                      <td>
                        <span className="res ok">
                          {"● 완료 · 적정"}
                        </span>
                      </td>
                      <td className="mono r">
                        {"0"}
                      </td>
                      <td>
                        <a href="#/Report" style={{"color":"var(--accent)"}}>
                          {"PDF"}
                        </a>
                      </td>
                    </tr>
                    {" "}
                    <tr>
                      <td className="mono">
                        {"10-10 14:20"}
                      </td>
                      <td style={{"fontWeight":"600"}}>
                        {"B1 지도 만들기"}
                      </td>
                      <td>
                        {"지도 만들기"}
                      </td>
                      <td>
                        {"[현장명] B1"}
                      </td>
                      <td>
                        {"운영자 A"}
                      </td>
                      <td className="mono r">
                        {"31분"}
                      </td>
                      <td className="mono r">
                        {"—"}
                      </td>
                      <td>
                        <span className="res ok">
                          {"● 지도 v3 저장"}
                        </span>
                      </td>
                      <td className="mono r">
                        {"—"}
                      </td>
                      <td>
                        <span className="lbl">
                          {"—"}
                        </span>
                      </td>
                    </tr>
                    {" "}
                    <tr>
                      <td className="mono">
                        {"10-09 10:18"}
                      </td>
                      <td style={{"fontWeight":"600"}}>
                        {"출입로 확인"}
                      </td>
                      <td>
                        {"지점 확인 다녀오기"}
                      </td>
                      <td>
                        {"[현장명] B1"}
                      </td>
                      <td>
                        {"운영자 C"}
                      </td>
                      <td className="mono r">
                        {"6분"}
                      </td>
                      <td className="mono r">
                        {"1/2"}
                      </td>
                      <td>
                        <span className="res stop">
                          {"STOP · 운영자 중단"}
                        </span>
                      </td>
                      <td className="mono r">
                        {"—"}
                      </td>
                      <td>
                        <a href="#/Report" style={{"color":"var(--accent)"}}>
                          {"PDF"}
                        </a>
                      </td>
                    </tr>
                    {" "}
                    <tr>
                      <td className="mono">
                        {"10-08 13:47"}
                      </td>
                      <td style={{"fontWeight":"600"}}>
                        {"펌프실 사전 측정"}
                      </td>
                      <td>
                        {"가스 사전 측정"}
                      </td>
                      <td>
                        {"[현장명] B1"}
                      </td>
                      <td>
                        {"운영자 A"}
                      </td>
                      <td className="mono r">
                        {"14분"}
                      </td>
                      <td className="mono r">
                        {"2/4"}
                      </td>
                      <td>
                        <span className="res bad">
                          {"■ 통신 끊김 · 후퇴"}
                        </span>
                      </td>
                      <td className="mono r">
                        {"0"}
                      </td>
                      <td>
                        <a href="#/Report" style={{"color":"var(--accent)"}}>
                          {"PDF"}
                        </a>
                      </td>
                    </tr>
                    {" "}
                  </>)}
</tbody>
                  {" "}
                </table>
                {" "}
              </div>
              {" "}
              <div style={{"display":"flex","flexWrap":"wrap","justifyContent":"space-between","alignItems":"center","gap":"8px","padding":"12px 14px"}}>
                {" "}
                <span className="lbl">
                  {v.pgL ?? "23건 중 1–8 · 가스 측정 기록은 3년, 그 밖의 기록은 1년 보존 (설정에서 변경)"}
                </span>
                {" "}
                <div style={{"display":"flex","gap":"4px"}}>
{v.pages ?? (<>
                  {" "}
                  <button className="btn" aria-label="이전 쪽" disabled={!!(true)} style={{"opacity":".5"}}>
                    {"‹"}
                  </button>
                  {" "}
                  <button className="btn" aria-current="page" style={{"background":"var(--acc-bg)","borderColor":"var(--accent)"}}>
                    {"1"}
                  </button>
                  {" "}
                  <button className="btn">
                    {"2"}
                  </button>
                  {" "}
                  <button className="btn">
                    {"3"}
                  </button>
                  {" "}
                  <button className="btn" aria-label="다음 쪽">
                    {"›"}
                  </button>
                  {" "}
                </>)}
</div>
                {" "}
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
