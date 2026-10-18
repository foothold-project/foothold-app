// 생성: scripts/dc2tsx.mjs ← web/PcSettings.dc.html (시각 원본). 생성 뒤 손으로 실데이터 연결 — 다시 생성해 덮지 않는다.
/* eslint-disable */
import { Fragment } from 'react';
import { arr, css, fn, iv, ivs, str } from '../dc/jsx';
import { BrandLogo } from '../app/BrandLogo';   // 공식 로고(브랜드 변경)

export const PREVIEW = {"width":1440,"height":1500};
export const FONTS = ["https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap"];
export const CSS = "\nbody{margin:0}\n.fh{--bg:#0B0E11;--panel:#12171C;--panel2:#182028;--line:#26313A;--line2:#34424D;--text:#E6EBEF;--muted:#9AA7B3;--accent:#38C6D9;--on-accent:#061014;--ok:#5AA9FF;--warn:#FFB547;--bad:#FF5A52;--stop:#D7261E;--acc-bg:rgba(56,198,217,.12);--warn-bg:rgba(255,181,71,.12);font-family:'IBM Plex Sans KR',system-ui,sans-serif;color:var(--text);background:var(--bg);-webkit-font-smoothing:antialiased}\n.fh.light{--bg:#EDEFEA;--panel:#FFFFFF;--panel2:#F5F6F2;--line:#D7DBD3;--line2:#C2C8BF;--text:#12171C;--muted:#4F5A64;--accent:#006D7A;--on-accent:#FFFFFF;--ok:#1F5FBF;--warn:#9A5800;--bad:#B3261E;--stop:#C8201A;--acc-bg:rgba(0,109,122,.08);--warn-bg:rgba(154,88,0,.09)}\n.mono{font-family:'JetBrains Mono',ui-monospace,monospace;font-variant-numeric:tabular-nums}\nbutton,input,select{font:inherit;color:inherit}\nbutton{cursor:pointer}\n.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:18px 20px;display:flex;flex-direction:column;gap:14px;scroll-margin-top:12px}\n.card h2{margin:0;font-size:17px;font-weight:700}\n.lbl{font-size:12px;color:var(--muted)}\n.btn{height:40px;padding:0 14px;border:1px solid var(--line2);background:var(--panel2);border-radius:8px;display:inline-flex;align-items:center;justify-content:center;gap:6px;font-weight:600;font-size:13px}\n.btn.pri{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}\n.inp{height:40px;padding:0 12px;border:1px solid var(--line2);border-radius:6px;background:var(--panel2);font-size:14px;box-sizing:border-box}\n.set{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:16px;align-items:center;padding:12px 0;border-top:1px solid var(--line)}\n.set .t{display:flex;flex-direction:column;gap:3px}\n.set .t b{font-size:14px;font-weight:600}\n.lock{font-size:12px;color:var(--muted);display:inline-flex;align-items:center;gap:4px}\n.sw{position:relative;width:46px;height:26px;border-radius:13px;border:0;background:var(--line2);padding:0}\n.sw span{position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#FFFFFF;transition:left .15s}\n.sw[aria-checked=\"true\"]{background:var(--accent)}\n.sw[aria-checked=\"true\"] span{left:23px}\ntable{border-collapse:collapse;width:100%;font-size:13px}\nth{font-size:12px;font-weight:600;color:var(--muted);text-align:left;padding:8px 10px;border-bottom:1px solid var(--line2)}\ntd{padding:10px;border-bottom:1px solid var(--line)}\n.sub{display:block;padding:9px 12px;border-radius:6px;font-size:14px;color:var(--muted);text-decoration:none}\n.sub:hover{background:var(--panel2);color:var(--text)}\n.sub.cur{background:var(--acc-bg);color:var(--text);font-weight:600}\n.nav{display:flex;flex-direction:column;align-items:center;gap:4px;width:64px;padding:10px 0;border-radius:8px;font-size:11px;color:var(--muted);text-decoration:none}\n.nav:hover{color:var(--text);background:var(--panel2)}\n.nav.cur{color:var(--text);background:var(--acc-bg)}\n.nav.cur svg{color:var(--accent)}\n/* 승인 수정(10-12): PC 머리줄(STOP 포함)은 스크롤해도 화면 위에 남는다 — 불투명 배경(--panel)이 아래 내용을 가린 채 위에 놓임 */\nheader{position:sticky;top:0;z-index:10}\n";
/** 원본 틀이 읽는 값 이름 */
export type Vals = { themeClass?: any; [k: string]: any };

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
              {v.hdrA ?? "설정 · 관리자만 바꿀 수 있음"}
            </span>
            {" "}
            <span style={{"fontSize":"17px","fontWeight":"600"}}>
              {"설정"}
            </span>
            {" "}
          </div>
          {" "}
          <div style={{"flex":"1"}} />
          {" "}
          <span className="lbl">
            {v.hdrNote ?? "모든 변경은 누가·언제 바꿨는지 기록에 남습니다"}
          </span>
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
                {v.stopSub ?? "스페이스 · 명령 0·잠금"}
              </span>
            </span>
            {" "}
          </button>
          {v.stopHelp ?? null}
          {" "}
        </header>
        {" "}
        <div style={{"flex":"1","display":"flex","flexWrap":"wrap","minHeight":"0"}}>
          {" "}
          <nav aria-label="주 메뉴" style={{"flex":"0 0 76px","display":"flex","flexDirection":"column","alignItems":"center","gap":"4px","padding":"12px 6px","borderRight":"1px solid var(--line)","background":"var(--panel)"}}>
            {" "}
            <a className="nav" href="#/Fleet">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <circle cx="12" cy="12" r="8" />
                <circle cx="12" cy="12" r="3" />
                <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
              </svg>
              {"관제"}
            </a>
            {" "}
            <a className="nav" href="#/PcPlan">
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
            <a className="nav cur" href="#/PcSettings" aria-current="page">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <circle cx="12" cy="12" r="3" />
                <path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1" />
              </svg>
              {"설정"}
            </a>
            {" "}
          </nav>
          {" "}
          <main style={{"flex":"999 1 600px","minWidth":"0","display":"flex","flexWrap":"wrap","gap":"16px","padding":"16px","alignContent":"flex-start"}}>
            {" "}
            <nav aria-label="설정 항목" style={{"flex":"1 1 200px","maxWidth":"220px","display":"flex","flexDirection":"column","gap":"2px"}}>
              {" "}
              <a className="sub cur" href="#safety">
                {"안전 정책"}
              </a>
              {" "}
              <a className="sub" href="#alerts">
                {"알림"}
              </a>
              {" "}
              <a className="sub" href="#thresholds">
                {"경보 기준"}
              </a>
              {" "}
              <a className="sub" href="#accounts">
                {"계정 · 권한"}
              </a>
              {" "}
              <a className="sub" href="#records">
                {"기록 · 보존"}
              </a>
              {" "}
              <a className="sub" href="#display">
                {"화면"}
              </a>
              {" "}
              <a className="sub" href="#network">
                {"서버 · 네트워크"}
              </a>
              {" "}
            </nav>
            {" "}
            <div style={{"flex":"999 1 560px","minWidth":"0","maxWidth":"920px","display":"flex","flexDirection":"column","gap":"16px"}}>
              {" "}
              <section id="safety" className="card" aria-label="안전 정책">
                {" "}
                <h2>
                  {"안전 정책"}
                </h2>
                {" "}
                <span className="lbl" style={{"lineHeight":"1.5"}}>
                  {v.safetyLbl ?? "모든 임무 양식에 공통으로 적용됩니다. 값은 현장에서 잰 뒤 고정합니다(지금은 임시값)."}
                </span>
                {" "}
                <div>
                  {" "}
                  <div className="set">
                    <span className="t">
                      <b>
                        {"통신 끊김으로 판정하는 시간"}
                      </b>
                      <span className="lbl">
                        {"이 시간이 지나면 아래 동작을 시작합니다"}
                      </span>
                    </span>{v.sv?.[0] ?? (<>
                    <span style={{"display":"flex","alignItems":"center","gap":"8px"}}>
                      <input className="inp mono" style={{"width":"80px","textAlign":"right"}} defaultValue="5" />
                      <span className="lbl">
                        {"초 · 임시"}
                      </span>
                    </span>
                  </>)}</div>
                  {" "}
                  <div className="set">
                    <span className="t">
                      <b>
                        {"통신이 끊기면"}
                      </b>
                      <span className="lbl">
                        {v.lostLbl ?? "자율 이동 중일 때. 직접 조종 중이면 항상 그 자리 정지"}
                      </span>
                    </span>{v.sv?.[1] ?? (<>
                    <select className="inp">
                      <option>
                        {"마지막 통신 지점으로 후퇴"}
                      </option>
                      <option>
                        {"그 자리 정지"}
                      </option>
                    </select>
                  </>)}</div>
                  {" "}
                  <div className="set">
                    <span className="t">
                      <b>
                        {"영상 멎음 기준"}
                      </b>
                      <span className="lbl">
                        {"넘으면 영상에 기대는 조종·임무를 멈추고 잠급니다"}
                      </span>
                    </span>{v.sv?.[2] ?? (<>
                    <span style={{"display":"flex","alignItems":"center","gap":"8px"}}>
                      <input className="inp mono" style={{"width":"80px","textAlign":"right"}} defaultValue="1.0" />
                      <span className="lbl">
                        {"초 · 임시"}
                      </span>
                    </span>
                  </>)}</div>
                  {" "}
                  <div className="set">
                    <span className="t">
                      <b>
                        {"손을 뗐을 때 서버 정지 (deadman)"}
                      </b>
                      <span className="lbl">
                        {"구현 설정값 · 현장 정지 시간을 보증하지 않음"}
                      </span>
                    </span>{v.sv?.[3] ?? (<>
                    <span className="lock">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                        <rect x="5" y="11" width="14" height="10" rx="2" />
                        <path d="M8 11V7a4 4 0 018 0v4" />
                      </svg>
                      <span className="mono">
                        {"0.3 s"}
                      </span>
                      {" · 고정"}
                    </span>
                  </>)}</div>
                  {" "}
                  <div className="set">
                    <span className="t">
                      <b>
                        {"다시 연결되면 자동으로 이어 가기"}
                      </b>
                      <span className="lbl">
                        {"사람이 상태를 확인하고 «정지 해제 → 임무 계속»을 눌러야 합니다"}
                      </span>
                    </span>{v.sv?.[4] ?? (<>
                    <span className="lock">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                        <rect x="5" y="11" width="14" height="10" rx="2" />
                        <path d="M8 11V7a4 4 0 018 0v4" />
                      </svg>
                      {"꺼짐 · 고정"}
                    </span>
                  </>)}</div>
                  {" "}
                  <div className="set">
                    <span className="t">
                      <b>
                        {"최대 속도"}
                      </b>
                      <span className="lbl">
                        {"자율 이동 · 직접 조종(느리게 / 보통)"}
                      </span>
                    </span>{v.sv?.[5] ?? (<>
                    <span className="mono" style={{"fontSize":"14px"}}>
                      {"0.5 · 0.3 / 0.6 m/s"}
                    </span>
                  </>)}</div>
                  {" "}
                  <div className="set">
                    <span className="t">
                      <b>
                        {"배터리 복귀 기준"}
                      </b>
                      <span className="lbl">
                        {"남은 양이 이 아래면 임무를 끝내고 복귀를 시작"}
                      </span>
                    </span>{v.sv?.[6] ?? (<>
                    <span style={{"display":"flex","alignItems":"center","gap":"8px"}}>
                      <input className="inp mono" style={{"width":"80px","textAlign":"right"}} defaultValue="20" />
                      <span className="lbl">
                        {"%"}
                      </span>
                    </span>
                  </>)}</div>
                  {" "}
                </div>
                {" "}
              </section>
              {" "}
              <section id="alerts" className="card" aria-label="알림">
                {" "}
                <h2>
                  {v.alertsH ?? "알림"}
                </h2>
                {" "}
                <div>
                  {" "}
                  <div className="set">
                    <span className="t">
                      <b>
                        {"PC 경보음"}
                      </b>
                      <span className="lbl">
                        {"위험 · 통신 끊김 · 확인 요청"}
                      </span>
                    </span>{v.sv?.[7] ?? (<>
                    <button className="sw" role="switch" aria-checked="true" aria-label="PC 경보음">
                      <span />
                    </button>
                  </>)}</div>
                  {" "}
                  <div className="set">
                    <span className="t">
                      <b>
                        {"휴대폰 진동"}
                      </b>
                      <span className="lbl">
                        {"주의 1회 · 위험 반복"}
                      </span>
                    </span>{v.sv?.[8] ?? (<>
                    <button className="sw" role="switch" aria-checked="true" aria-label="휴대폰 진동">
                      <span />
                    </button>
                  </>)}</div>
                  {" "}
                  <div className="set">
                    <span className="t">
                      <b>
                        {"잠금 화면 긴급 알림"}
                      </b>
                      <span className="lbl">
                        {"설치형 앱에서만 · 웹에서는 화면이 켜져 있어야 함"}
                      </span>
                    </span>{v.sv?.[9] ?? (<>
                    <button className="sw" role="switch" aria-checked="true" aria-label="잠금 화면 긴급 알림">
                      <span />
                    </button>
                  </>)}</div>
                  {" "}
                  <div className="set">
                    <span className="t">
                      <b>
                        {"무음 모드에서도 위험 경보 울리기"}
                      </b>
                      <span className="lbl">
                        {"휴대폰 설정에서 따로 허용해야 합니다"}
                      </span>
                    </span>{v.sv?.[10] ?? (<>
                    <button className="sw" role="switch" aria-checked="false" aria-label="무음 모드에서도 울리기">
                      <span />
                    </button>
                  </>)}</div>
                  {" "}
                  <div className="set">
                    <span className="t">
                      <b>
                        {"응답이 없으면 현장 책임자에게도"}
                      </b>
                      <span className="lbl">
                        {"위험 경보에 아무도 답하지 않을 때"}
                      </span>
                    </span>{v.sv?.[11] ?? (<>
                    <span style={{"display":"flex","alignItems":"center","gap":"8px"}}>
                      <input className="inp mono" style={{"width":"80px","textAlign":"right"}} defaultValue="30" />
                      <span className="lbl">
                        {"초 뒤"}
                      </span>
                    </span>
                  </>)}</div>
                  {" "}
                </div>
                {" "}
              </section>
              {" "}
              <section id="thresholds" className="card" aria-label="경보 기준">
                {" "}
                <h2>
                  {"경보 기준 · 가스 측정 모듈"}
                </h2>
                {" "}
                <span className="lbl" style={{"lineHeight":"1.5"}}>
                  {v.thLbl ?? "위험(법정) 값은 근거와 함께 고정합니다. 주의 값만 팀이 정합니다. 임무 양식의 경보 규칙은 이 값을 씁니다."}
                </span>
                {" "}
                <div style={{"overflowX":"auto"}}>
                  {" "}
                  <table>
                    <thead>
                      <tr>
                        <th>
                          {"항목"}
                        </th>
                        <th>
                          {"주의"}
                        </th>
                        <th>
                          {"위험"}
                        </th>
                        <th>
                          {"근거"}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
{v.thBody ?? (<>
                      <tr>
                        <td>
                          {"O₂"}
                        </td>
                        <td>
                          <span className="mono">
                            {"19.5 미만 · 22.5 이상"}
                          </span>
                        </td>
                        <td className="mono">
                          {"18 미만 · 23.5 이상 %"}
                        </td>
                        <td className="lbl">
                          {"예시 기준 · 검증 전"}
                        </td>
                      </tr>
                      <tr>
                        <td>
                          {"H₂S"}
                        </td>
                        <td>
                          <input className="inp mono" style={{"width":"72px","height":"34px","textAlign":"right"}} defaultValue="5" />
                          {" ppm"}
                        </td>
                        <td className="mono">
                          {"10 ppm 이상"}
                        </td>
                        <td className="lbl">
                          {"예시 기준 · 검증 전"}
                        </td>
                      </tr>
                      <tr>
                        <td>
                          {"CO"}
                        </td>
                        <td>
                          <input className="inp mono" style={{"width":"72px","height":"34px","textAlign":"right"}} defaultValue="15" />
                          {" ppm"}
                        </td>
                        <td className="mono">
                          {"30 ppm 이상"}
                        </td>
                        <td className="lbl">
                          {"예시 기준 · 검증 전"}
                        </td>
                      </tr>
                      <tr>
                        <td>
                          {"CO₂"}
                        </td>
                        <td>
                          <input className="inp mono" style={{"width":"72px","height":"34px","textAlign":"right"}} defaultValue="0.75" />
                          {" %"}
                        </td>
                        <td className="mono">
                          {"1.5% 이상"}
                        </td>
                        <td className="lbl">
                          {"예시 기준 · 검증 전"}
                        </td>
                      </tr>
                      <tr>
                        <td>
                          {"LEL"}
                        </td>
                        <td>
                          <input className="inp mono" style={{"width":"72px","height":"34px","textAlign":"right"}} defaultValue="5" />
                          {" %"}
                        </td>
                        <td className="mono">
                          {"10% 이상"}
                        </td>
                        <td className="lbl">
                          {"예시 기준 · 검증 전"}
                        </td>
                      </tr>
                    </>)}
</tbody>
                  </table>
                  {" "}
                </div>
                {" "}
              </section>
              {" "}
              <section id="accounts" className="card" aria-label="계정과 권한">
                {" "}
                <div style={{"display":"flex","alignItems":"center","gap":"8px"}}>
                  <h2>
                    {"계정 · 권한"}
                  </h2>
                  <div style={{"flex":"1"}} />
                  <button className="btn pri" {...v.addP}>
                    {"사람 추가"}
                  </button>
                </div>
                {" "}
                <div style={{"overflowX":"auto"}}>
                  {" "}
                  <table>
                    <thead>
                      <tr>
                        <th>
                          {"이름"}
                        </th>
                        <th>
                          {"역할"}
                        </th>
                        <th>
                          {"할 수 있는 일"}
                        </th>
                        <th>
                          {"마지막 접속"}
                        </th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
{v.accRows ?? (<>
                      <tr>
                        <td style={{"fontWeight":"600"}}>
                          {"운영자 A"}
                        </td>
                        <td>
                          {"관리자"}
                        </td>
                        <td className="lbl">
                          {"조종 · 임무 · 지도 · 설정"}
                        </td>
                        <td className="mono">
                          {"지금 · 관제 노트북 1"}
                        </td>
                        <td>
                          <a href="#" style={{"color":"var(--accent)"}}>
                            {"편집"}
                          </a>
                        </td>
                      </tr>
                      <tr>
                        <td style={{"fontWeight":"600"}}>
                          {"운영자 B"}
                        </td>
                        <td>
                          {"운영자"}
                        </td>
                        <td className="lbl">
                          {"조종 · 임무 · 발견물 확인"}
                        </td>
                        <td className="mono">
                          {"10-11 16:40"}
                        </td>
                        <td>
                          <a href="#" style={{"color":"var(--accent)"}}>
                            {"편집"}
                          </a>
                        </td>
                      </tr>
                      <tr>
                        <td style={{"fontWeight":"600"}}>
                          {"운영자 C"}
                        </td>
                        <td>
                          {"운영자"}
                        </td>
                        <td className="lbl">
                          {"조종 · 임무 · 발견물 확인"}
                        </td>
                        <td className="mono">
                          {"10-11 11:12"}
                        </td>
                        <td>
                          <a href="#" style={{"color":"var(--accent)"}}>
                            {"편집"}
                          </a>
                        </td>
                      </tr>
                      <tr>
                        <td style={{"fontWeight":"600"}}>
                          {"[이름]"}
                        </td>
                        <td>
                          {"현장 책임자"}
                        </td>
                        <td className="lbl">
                          {"보기 · 출발 승인 · 보고서 서명"}
                        </td>
                        <td className="mono">
                          {"—"}
                        </td>
                        <td>
                          <a href="#" style={{"color":"var(--accent)"}}>
                            {"편집"}
                          </a>
                        </td>
                      </tr>
                    </>)}
</tbody>
                  </table>
                  {" "}
                </div>
                {" "}
                <span className="lbl">
                  {"모든 역할은 STOP을 누를 수 있습니다. 조종은 한 번에 한 사람만 합니다."}
                </span>
                {" "}
              </section>
              {" "}
              <section id="records" className="card" aria-label="기록과 보존">
                {" "}
                <h2>
                  {"기록 · 보존"}
                </h2>
                {" "}
                <div>
                  {" "}
                  <div className="set">
                    <span className="t">
                      <b>
                        {"가스 측정이 들어간 임무 기록"}
                      </b>
                      <span className="lbl">
                        {"측정자 · 일시 · 장소 · 수치 · 영상"}
                      </span>
                    </span>{v.sv?.[12] ?? (<>
                    <span className="lock">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                        <rect x="5" y="11" width="14" height="10" rx="2" />
                        <path d="M8 11V7a4 4 0 018 0v4" />
                      </svg>
                      {"3년 · 예시 기준 · 검증 전"}
                    </span>
                  </>)}</div>
                  {" "}
                  <div className="set">
                    <span className="t">
                      <b>
                        {"그 밖의 임무 기록"}
                      </b>
                      <span className="lbl">
                        {"영상 원본은 용량이 커서 따로 정할 수 있습니다"}
                      </span>
                    </span>{v.sv?.[13] ?? (<>
                    <select className="inp">
                      <option>
                        {"1년"}
                      </option>
                      <option>
                        {"6개월"}
                      </option>
                      <option>
                        {"3년"}
                      </option>
                    </select>
                  </>)}</div>
                  {" "}
                  <div className="set">
                    <span className="t">
                      <b>
                        {"보고서 기본 형식"}
                      </b>
                    </span>{v.sv?.[14] ?? (<>
                    <select className="inp">
                      <option>
                        {"PDF + CSV 원자료"}
                      </option>
                      <option>
                        {"PDF만"}
                      </option>
                    </select>
                  </>)}</div>
                  {" "}
                  <div className="set">
                    <span className="t">
                      <b>
                        {"저장 공간"}
                      </b>
                      <span className="lbl">
                        {"현장 서버"}
                      </span>
                    </span>{v.sv?.[15] ?? (<>
                    <span className="mono" style={{"fontSize":"14px"}}>
                      {"[사용량] / [전체]"}
                    </span>
                  </>)}</div>
                  {" "}
                </div>
                {" "}
              </section>
              {" "}
              <section id="display" className="card" aria-label="화면">
                {" "}
                <h2>
                  {"화면"}
                </h2>
                {" "}
                <div>
                  {" "}
                  <div className="set">
                    <span className="t">
                      <b>
                        {"테마"}
                      </b>
                      <span className="lbl">
                        {"자동 = PC 어두운 · 휴대폰 밝은"}
                      </span>
                    </span>{v.sv?.[16] ?? (<>
                    <div role="radiogroup" aria-label="테마" style={{"display":"flex","border":"1px solid var(--line2)","borderRadius":"6px","overflow":"hidden"}}>
                      <button role="radio" aria-checked="true" style={{"height":"36px","padding":"0 12px","border":"0","background":"var(--acc-bg)","fontSize":"13px","fontWeight":"600"}}>
                        {"자동"}
                      </button>
                      <button role="radio" aria-checked="false" style={{"height":"36px","padding":"0 12px","border":"0","background":"transparent","fontSize":"13px"}}>
                        {"어두운"}
                      </button>
                      <button role="radio" aria-checked="false" style={{"height":"36px","padding":"0 12px","border":"0","background":"transparent","fontSize":"13px"}}>
                        {"밝은"}
                      </button>
                    </div>
                  </>)}</div>
                  {" "}
                  <div className="set">
                    <span className="t">
                      <b>
                        {"휴대폰 조종 막대 배치"}
                      </b>
                    </span>{v.sv?.[17] ?? (<>
                    <select className="inp">
                      <option>
                        {"왼쪽 이동 · 오른쪽 회전"}
                      </option>
                      <option>
                        {"왼쪽 회전 · 오른쪽 앞뒤"}
                      </option>
                    </select>
                  </>)}</div>
                  {" "}
                  <div className="set">
                    <span className="t">
                      <b>
                        {"미니맵 위치 (휴대폰 가로)"}
                      </b>
                    </span>{v.sv?.[18] ?? (<>
                    <select className="inp">
                      <option>
                        {"왼쪽 위"}
                      </option>
                      <option>
                        {"오른쪽 위"}
                      </option>
                    </select>
                  </>)}</div>
                  {" "}
                {v.dispExtra ?? null}
</div>
                {" "}
              </section>
              {" "}
              <section id="network" className="card" aria-label="서버와 네트워크">
                {" "}
                <h2>
                  {"서버 · 네트워크"}
                </h2>
                {" "}
                <div>
                  {" "}
                  <div className="set">
                    <span className="t">
                      <b>
                        {"현장 서버"}
                      </b>
                      <span className="lbl">
                        {"로봇 PC의 관문 · 인터넷 없이 동작"}
                      </span>
                    </span>{v.sv?.[19] ?? (<>
                    <span className="mono" style={{"fontSize":"14px"}}>
                      {"[서버 주소] · "}
                      <span style={{"color":"var(--ok)"}}>
                        {"●"}
                      </span>
                      {" 정상"}
                    </span>
                  </>)}</div>
                  {" "}
                  <div className="set">
                    <span className="t">
                      <b>
                        {"인증서"}
                      </b>
                      <span className="lbl">
                        {"휴대폰·노트북에 설치한 현장 인증서"}
                      </span>
                    </span>{v.sv?.[20] ?? (<>
                    <span className="mono" style={{"fontSize":"14px"}}>
                      {"만료 [날짜]"}
                    </span>
                  </>)}</div>
                  {" "}
                  <div className="set">
                    <span className="t">
                      <b>
                        {"앱 버전"}
                      </b>
                      <span className="lbl">
                        {"임무 중에는 업데이트하지 않습니다"}
                      </span>
                    </span>{v.sv?.[21] ?? (<>
                    <span className="mono" style={{"fontSize":"14px"}}>
                      {"[버전]"}
                    </span>
                  </>)}</div>
                  {" "}
                </div>
                {" "}
              </section>
{v.limits ?? null}
              {" "}
            </div>
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
