// 생성: scripts/dc2tsx.mjs ← web/PcMissions.dc.html (시각 원본). 생성 뒤 손으로 실데이터 연결 — 다시 생성해 덮지 않는다.
/* eslint-disable */
import { Fragment } from 'react';
import { arr, css, fn, iv, ivs, str } from '../dc/jsx';
import { BrandLogo } from '../app/BrandLogo';   // 공식 로고(브랜드 변경)

export const PREVIEW = {"width":1440,"height":1100};
export const FONTS = ["https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap"];
export const CSS = "\nbody{margin:0}\n.fh{--bg:#0B0E11;--panel:#12171C;--panel2:#182028;--line:#26313A;--line2:#34424D;--text:#E6EBEF;--muted:#9AA7B3;--accent:#38C6D9;--on-accent:#061014;--ok:#5AA9FF;--warn:#FFB547;--bad:#FF5A52;--stop:#D7261E;--acc-bg:rgba(56,198,217,.12);--warn-bg:rgba(255,181,71,.12);--bad-bg:rgba(255,90,82,.13);font-family:'IBM Plex Sans KR',system-ui,sans-serif;color:var(--text);background:var(--bg);-webkit-font-smoothing:antialiased}\n.fh.light{--bg:#EDEFEA;--panel:#FFFFFF;--panel2:#F5F6F2;--line:#D7DBD3;--line2:#C2C8BF;--text:#12171C;--muted:#4F5A64;--accent:#006D7A;--on-accent:#FFFFFF;--ok:#1F5FBF;--warn:#9A5800;--bad:#B3261E;--stop:#C8201A;--acc-bg:rgba(0,109,122,.08);--warn-bg:rgba(154,88,0,.09);--bad-bg:rgba(179,38,30,.08)}\n.mono{font-family:'JetBrains Mono',ui-monospace,monospace;font-variant-numeric:tabular-nums}\nbutton,input,textarea{font:inherit;color:inherit}\nbutton{cursor:pointer}\nbutton[disabled]{cursor:not-allowed;opacity:.5}\n.card{background:var(--panel);border:1px solid var(--line);border-radius:10px}\n.btn{height:40px;padding:0 14px;border:1px solid var(--line2);background:var(--panel2);border-radius:8px;display:inline-flex;align-items:center;justify-content:center;gap:6px;font-weight:600;font-size:13px}\n.btn.pri{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}\n.btn.danger{color:var(--bad);border-color:var(--bad)}\n.lbl{font-size:12px;color:var(--muted)}\n.inp{height:42px;padding:0 12px;border:1px solid var(--line2);border-radius:6px;background:var(--panel2);font-size:15px;box-sizing:border-box;width:100%}\n.tp{display:flex;flex-direction:column;gap:6px;padding:12px;border:1px solid var(--line);border-radius:8px;background:var(--panel2);text-align:left;width:100%}\n.tp.sel{border-color:var(--accent);background:var(--acc-bg)}\n.kind{font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;border:1px solid var(--line2);color:var(--muted);white-space:nowrap}\n.kind.base{border-color:var(--accent);color:var(--accent)}\n.kind.draft{border-style:dashed}\n.sec{padding:16px 18px;border-top:1px solid var(--line);display:flex;flex-direction:column;gap:12px}\n.sec h3{margin:0;font-size:15px;font-weight:600;display:flex;align-items:center;gap:8px}\n.mod{display:grid;grid-template-columns:18px 30px 1fr auto;gap:10px;align-items:center;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--panel2)}\n.mod.blocked{border-color:var(--warn);background:var(--warn-bg)}\n.mi{width:30px;height:30px;border-radius:6px;background:var(--acc-bg);color:var(--accent);display:grid;place-items:center;font-size:12px;font-weight:700}\n.pal{height:36px;padding:0 12px;border:1px dashed var(--line2);border-radius:999px;background:transparent;font-size:13px;display:flex;align-items:center;gap:6px}\n.pal:hover{border-color:var(--accent);border-style:solid}\n.x{width:32px;height:32px;border:0;border-radius:6px;background:transparent;color:var(--muted);display:grid;place-items:center}\n.x:hover{background:var(--bad-bg);color:var(--bad)}\n.rule{display:grid;grid-template-columns:1fr 20px 1fr auto;gap:10px;align-items:center;padding:10px 12px;border:1px solid var(--line);border-radius:8px;font-size:13px}\n.auto{font-size:12px;padding:4px 10px;border-radius:6px;background:var(--panel2);border:1px solid var(--line2);white-space:nowrap}\n.auto.fixed{color:var(--muted);border-style:dashed}\n.nav{display:flex;flex-direction:column;align-items:center;gap:4px;width:64px;padding:10px 0;border-radius:8px;font-size:11px;color:var(--muted);text-decoration:none}\n.nav:hover{color:var(--text);background:var(--panel2)}\n.nav.cur{color:var(--text);background:var(--acc-bg)}\n.nav.cur svg{color:var(--accent)}\n/* 승인 수정(10-12): PC 머리줄(STOP 포함)은 스크롤해도 화면 위에 남는다 — 불투명 배경(--panel)이 아래 내용을 가린 채 위에 놓임 */\nheader{position:sticky;top:0;z-index:10}\n";
/** 원본 틀이 읽는 값 이름 */
export type Vals = { themeClass?: any; count?: any; add?: any; items?: any; cur?: any; dup?: any; remove?: any; rename?: any; redesc?: any; mods?: any; noMods?: any; palette?: any; rules?: any; addRule?: any; panels?: any; sections?: any; cols?: any; hasToast?: any; toastName?: any; undo?: any; status?: any; stopProps?: any; planHref?: any; nmP?: any; dsP?: any; msg?: any; offL?: any; ruleWhy?: any; fixed?: any; addRuleProps?: any; stopSub?: any; stopHelp?: any; lockNote?: any; ruleSub?: any };

export function View({ v }: { v: Vals }) {
  return (
    <>
      {" "}
      {" "}
      <div className={`${str(v.themeClass)}` as any} style={{"minHeight":"100vh","display":"flex","flexDirection":"column","position":"relative"}}>
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
              {"임무 · 양식"}
            </span>
            {" "}
            <span style={{"fontSize":"17px","fontWeight":"600"}}>
              {"임무 양식 관리"}
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
            <a className="nav" href="#/Main">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <circle cx="12" cy="12" r="8" />
                <circle cx="12" cy="12" r="3" />
                <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
              </svg>
              {"관제"}
            </a>
            {" "}
            <a className="nav cur" href="#/PcMissions" aria-current="page">
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
          <main style={{"flex":"999 1 600px","minWidth":"0","display":"flex","flexWrap":"wrap","gap":"12px","padding":"12px","alignContent":"flex-start"}}>
            {" "}
            <section aria-label="임무 양식 목록" className="card" style={{"flex":"1 1 300px","maxWidth":"380px","minWidth":"0","padding":"14px","display":"flex","flexDirection":"column","gap":"10px"}}>
              {" "}
              <div style={{"display":"flex","alignItems":"center","gap":"8px"}}>
                {" "}
                <span style={{"fontWeight":"600","fontSize":"15px"}}>
                  {"임무 양식"}
                </span>
                {" "}
                <span className="mono lbl">
                  {iv(v.count)}
                </span>
                {" "}
                <div style={{"flex":"1"}} />
                {" "}
                <button className="btn pri" onClick={fn(v.add)}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                  {"새 임무"}
                </button>
                {" "}
              </div>
              {" "}
              <span className="lbl" style={{"lineHeight":"1.5"}}>
                {"임무 = 지점에서 할 일(모듈) + 경보 규칙. 관제 화면과 보고서는 고른 모듈에 맞춰 자동으로 구성됩니다."}
              </span>
              {" "}
              {arr(v.items).map((it: any, i7: number) => (<Fragment key={i7}>
                {" "}
                <button className={`tp ${str(it?.cls)}` as any} onClick={fn(it?.pick)} aria-pressed={`${str(it?.pressed)}` as any}>
                  {" "}
                  <span style={{"display":"flex","justifyContent":"space-between","gap":"8px","alignItems":"center","width":"100%"}}>
                    <b style={{"fontSize":"14px"}}>
                      {iv(it?.name)}
                    </b>
                    <span className={`kind ${str(it?.kindCls)}` as any}>
                      {iv(it?.kind)}
                    </span>
                  </span>
                  {" "}
                  <span className="lbl">
                    {iv(it?.summary)}
                  </span>
                  {" "}
                  {it?.blocked ? (<>
                    <span style={{"fontSize":"12px","color":"var(--warn)","fontWeight":"600"}}>
                      {"▲ 이 로봇에 없는 장비가 있어 실행할 수 없음"}
                    </span>
                  </>) : null}
                  {" "}
                  <span className="lbl mono">
                    {iv(it?.meta)}
                  </span>
                  {" "}
                </button>
                {" "}
              </Fragment>))}
              {" "}
            </section>
            {" "}
            <section aria-label="임무 양식 편집" className="card" style={{"flex":"999 1 560px","minWidth":"0","display":"flex","flexDirection":"column"}}>
              {" "}
              <div style={{"padding":"16px 18px","display":"flex","flexDirection":"column","gap":"10px"}}>
                {" "}
                <div style={{"display":"flex","flexWrap":"wrap","gap":"8px","alignItems":"center"}}>
                  {" "}
                  <span className={`kind ${str(v.cur?.kindCls)}` as any}>
                    {iv(v.cur?.kind)}
                  </span>
                  {" "}
                  <span className="lbl">
                    {iv(v.cur?.saved)}
                  </span>
                  {" "}
                  <div style={{"flex":"1"}} />
                  {" "}
                  <button className="btn" onClick={fn(v.dup)}>
                    {"복제"}
                  </button>
                  {" "}
                  <button className="btn danger" onClick={fn(v.remove)} disabled={!!(v.cur?.locked)}>
                    {"삭제"}
                  </button>
                  {" "}
                  <a className="btn pri" href={v.planHref ?? "#/PcPlan"} style={{"textDecoration":"none"}}>
                    {"이 양식으로 임무 계획"}
                  </a>
                  {" "}
                </div>
                {" "}
                {v.cur?.locked ? (<>
                  <span style={{"fontSize":"12px","color":"var(--muted)"}}>
                    {v.lockNote ?? "기본 양식은 지우거나 고칠 수 없습니다. 복제해서 고치세요."}
                  </span>
                </>) : null}
                {" "}
                <label className="lbl" htmlFor="nm">
                  {"임무 이름"}
                </label>
                {" "}
                <input id="nm" className="inp" value={str(v.cur?.name)} onChange={fn(v.rename)} readOnly={!!(v.cur?.locked)} {...v.nmP} />
                {" "}
                <label className="lbl" htmlFor="ds">
                  {"설명 · 운영자에게 보이는 한 줄"}
                </label>
                {" "}
                <input id="ds" className="inp" style={{"fontSize":"14px"}} value={str(v.cur?.desc)} onChange={fn(v.redesc)} readOnly={!!(v.cur?.locked)} {...v.dsP} />
                {v.msg ?? null}
                {" "}
              </div>
              {" "}
              <div className="sec">
                {" "}
                <h3>
                  {"지점에서 할 일 "}
                  <span className="lbl" style={{"fontWeight":"400"}}>
                    {"위에서부터 차례로 실행 · 이동은 늘 포함"}
                  </span>
                </h3>
                {" "}
                <div style={{"display":"flex","flexDirection":"column","gap":"6px"}}>
                  {" "}
                  {arr(v.mods).map((m: any, i9: number) => (<Fragment key={i9}>
                    {" "}
                    <div className={`mod ${str(m?.cls)}` as any}>
                      {" "}
                      <span aria-hidden="true" style={{"color":"var(--muted)"}}>
                        {"⋮⋮"}
                      </span>
                      {" "}
                      <span className="mi mono">
                        {iv(m?.no)}
                      </span>
                      {" "}
                      <span style={{"display":"flex","flexDirection":"column","gap":"2px","minWidth":"0"}}>
                        <b style={{"fontSize":"14px"}}>
                          {iv(m?.type)}
                        </b>
                        <span className="lbl" {...m?.detProps}>
                          {iv(m?.detail)}
                        </span>
                      </span>
                      {" "}
                      <button className="x" aria-label={`${str(m?.delLabel)}` as any} onClick={fn(m?.del)} disabled={!!(v.cur?.locked)}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                          <path d="M6 6l12 12M18 6L6 18" />
                        </svg>
                      </button>
                      {" "}
                    </div>
                    {" "}
                  </Fragment>))}
                  {" "}
                  {v.noMods ? (<>
                    <div className="lbl" style={{"padding":"14px","border":"1px dashed var(--line2)","borderRadius":"8px","textAlign":"center"}}>
                      {"아직 할 일이 없습니다. 아래에서 모듈을 더하세요. 비워 두면 «이동만» 하는 임무가 됩니다."}
                    </div>
                  </>) : null}
                  {" "}
                </div>
                {" "}
                <div style={{"display":"flex","flexWrap":"wrap","gap":"6px","alignItems":"center"}}>
                  {" "}
                  <span className="lbl" style={{"marginRight":"4px"}}>
                    {"모듈 더하기"}
                  </span>
                  {" "}
                  {arr(v.palette).map((p: any, i9: number) => (<Fragment key={i9}>
                    {" "}
                    <button className="pal" {...(p?.btnP ?? { onClick: fn(p?.add), disabled: !!(p?.off), title: `${str(p?.why)}` })}>{/* U4-c btnP: 못 더하는 칩 = 회색 + 누르면 이유(더하기 0) */}
                      {"+ "}
                      {iv(p?.type)}
                    </button>
                    {" "}
                  </Fragment>))}
                  {" "}
                </div>
                {" "}
                <span className="lbl">
                  {v.offL ?? "열화상 · 장비 없음(로봇에 등록된 장비만 고를 수 있습니다)"}
                </span>
                {" "}
              </div>
              {" "}
              <div className="sec">
                {" "}
                <h3>
                  {"경보 규칙 "}
                  <span className="lbl" style={{"fontWeight":"400"}}>
                    {v.ruleSub ?? "조건이 맞으면 로봇이 먼저 조치하고 사람에게 알립니다"}
                  </span>
                </h3>
                {v.ruleWhy ?? null}
                <div style={{"display":"flex","flexDirection":"column","gap":"6px"}}>
                  {" "}
                  {arr(v.rules).map((r: any, i9: number) => (<Fragment key={i9}>
                    {" "}
                    <div className="rule">
                      {" "}
                      <span>
                        <span className="lbl">
                          {"만약"}
                        </span>
                        <br />
                        <b>
                          {iv(r?.cond)}
                        </b>
                      </span>
                      {" "}
                      <span aria-hidden="true" style={{"color":"var(--muted)"}}>
                        {"→"}
                      </span>
                      {" "}
                      <span>
                        <span className="lbl">
                          {"그러면"}
                        </span>
                        <br />
                        <b>
                          {iv(r?.act)}
                        </b>
                      </span>
                      {" "}
                      <button className="x" aria-label="규칙 삭제" onClick={fn(r?.del)} disabled={!!(v.cur?.locked)}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                          <path d="M6 6l12 12M18 6L6 18" />
                        </svg>
                      </button>
                      {" "}
                    </div>
                    {" "}
                  </Fragment>))}
                  {" "}
                  {v.fixed ?? (<><div className="rule" style={{"borderStyle":"dashed","color":"var(--muted)"}}>
                    {" "}
                    <span>
                      <span className="lbl">
                        {"항상 적용 (끌 수 없음)"}
                      </span>
                      <br />
                      {"통신 끊김 5초"}
                    </span>
                    {" "}
                    <span aria-hidden="true">
                      {"→"}
                    </span>
                    {" "}
                    <span>
                      <span className="lbl" />
                      <br />
                      {"마지막 통신 지점으로 후퇴"}
                    </span>
                    {" "}
                    <span />
                    {" "}
                  </div></>)}
                  {" "}
                </div>
                {" "}
                <div>
                  <button className="btn" onClick={fn(v.addRule)} disabled={!!(v.cur?.locked)} {...v.addRuleProps}>
                    {"+ 규칙 추가"}
                  </button>
                </div>
                {" "}
              </div>
              {" "}
              <div className="sec" style={{"background":"var(--panel2)","borderRadius":"0 0 10px 10px"}}>
                {" "}
                <h3>
                  {"이 임무에서 자동으로 구성되는 것"}
                </h3>
                {" "}
                <div style={{"display":"grid","gridTemplateColumns":"repeat(auto-fit,minmax(min(260px,100%),1fr))","gap":"16px"}}>
                  {" "}
                  <div style={{"display":"flex","flexDirection":"column","gap":"8px"}}>
                    {" "}
                    <span className="lbl">
                      {"관제 화면 패널"}
                    </span>
                    {" "}
                    <div style={{"display":"flex","flexWrap":"wrap","gap":"6px"}}>
                      {" "}
                      <span className="auto fixed">
                        {"지도 · 영상 · 로봇 상태 · 단계 · STOP"}
                      </span>
                      {" "}
                      {arr(v.panels).map((pn: any, i11: number) => (<Fragment key={i11}>
                        <span className="auto">
                          {iv(pn)}
                        </span>
                      </Fragment>))}
                      {" "}
                    </div>
                    {" "}
                  </div>
                  {" "}
                  <div style={{"display":"flex","flexDirection":"column","gap":"8px"}}>
                    {" "}
                    <span className="lbl">
                      {"보고서 구성"}
                    </span>
                    {" "}
                    <div style={{"display":"flex","flexWrap":"wrap","gap":"6px"}}>
                      {" "}
                      <span className="auto fixed">
                        {"개요 · 경로 지도 · 지점별 결과 · 서명"}
                      </span>
                      {" "}
                      {arr(v.sections).map((sc: any, i11: number) => (<Fragment key={i11}>
                        <span className="auto">
                          {iv(sc)}
                        </span>
                      </Fragment>))}
                      {" "}
                    </div>
                    {" "}
                    <span className="lbl">
                      {"지점별 결과 표의 열: "}
                      <span style={{"color":"var(--text)"}}>
                        {iv(v.cols)}
                      </span>
                    </span>
                    {" "}
                  </div>
                  {" "}
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
        {v.hasToast ? (<>
          {" "}
          <div role="status" style={{"position":"absolute","left":"50%","bottom":"24px","transform":"translateX(-50%)","display":"flex","alignItems":"center","gap":"14px","padding":"12px 14px 12px 18px","borderRadius":"10px","background":"var(--text)","color":"var(--bg)","fontSize":"14px","boxShadow":"0 8px 24px rgba(0,0,0,.35)"}}>
            {" "}
            <span>
              {"«"}
              {iv(v.toastName)}
              {"» 삭제됨 · 이 양식으로 한 지난 기록은 그대로 남습니다"}
            </span>
            {" "}
            <button onClick={fn(v.undo)} style={{"height":"36px","padding":"0 12px","border":"0","borderRadius":"6px","background":"var(--accent)","color":"var(--on-accent)","fontWeight":"700"}}>
              {"되돌리기"}
            </button>
            {" "}
          </div>
          {" "}
        </>) : null}
        {" "}
      </div>
      {" "}
    </>
  );
}
