// 생성: scripts/dc2tsx.mjs (손 수정: 예시 자리마다 v.<이름> ?? 예시 — 실화면은 모든 자리를 넘김, 대조 시험은 예시 그대로)
// ← web/MHistory.dc.html (시각 원본). 생성 뒤 손으로 실데이터 연결 — 다시 생성해 덮지 않는다.
/* eslint-disable */
import { Fragment } from 'react';
import { arr, css, fn, iv, ivs, str } from '../dc/jsx';

export const PREVIEW = {"width":390,"height":844};
export const FONTS = ["https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap"];
export const CSS = "\nbody{margin:0}\n.fh{--bg:#0B0E11;--panel:#12171C;--panel2:#182028;--line:#26313A;--line2:#34424D;--text:#E6EBEF;--muted:#9AA7B3;--accent:#38C6D9;--on-accent:#061014;--ok:#5AA9FF;--warn:#FFB547;--bad:#FF5A52;--stop:#D7261E;--acc-bg:rgba(56,198,217,.12);--warn-bg:rgba(255,181,71,.12);--bad-bg:rgba(255,90,82,.13);--ok-bg:rgba(90,169,255,.10);font-family:'IBM Plex Sans KR',system-ui,sans-serif;color:var(--text);background:var(--bg);-webkit-font-smoothing:antialiased}\n.fh.light{--bg:#EDEFEA;--panel:#FFFFFF;--panel2:#F5F6F2;--line:#D7DBD3;--line2:#C2C8BF;--text:#12171C;--muted:#4F5A64;--accent:#006D7A;--on-accent:#FFFFFF;--ok:#1F5FBF;--warn:#9A5800;--bad:#B3261E;--stop:#C8201A;--acc-bg:rgba(0,109,122,.08);--warn-bg:rgba(154,88,0,.09);--bad-bg:rgba(179,38,30,.08);--ok-bg:rgba(31,95,191,.08)}\n.mono{font-family:'JetBrains Mono',ui-monospace,monospace;font-variant-numeric:tabular-nums}\nbutton{font:inherit;color:inherit;cursor:pointer}\n.lbl{font-size:12px;color:var(--muted)}\n.chip{height:36px;padding:0 14px;border:1px solid var(--line2);border-radius:18px;background:var(--panel);font-size:13px;white-space:nowrap}\n.chip[aria-pressed=\"true\"]{border-color:var(--accent);background:var(--acc-bg);font-weight:600}\n.it{display:grid;grid-template-columns:1fr auto;gap:4px 10px;padding:12px 14px;border:1px solid var(--line);border-radius:12px;background:var(--panel);text-decoration:none;color:inherit}\n.res{font-size:12px;font-weight:600;padding:3px 8px;border-radius:999px;white-space:nowrap;justify-self:end;align-self:start}\n.res.ok{color:var(--ok);background:var(--ok-bg)}.res.warn{color:var(--warn);background:var(--warn-bg)}.res.bad{color:var(--bad);background:var(--bad-bg)}.res.stop{color:var(--muted);border:1px solid var(--line2)}\n.day{font-size:12px;font-weight:700;color:var(--muted);letter-spacing:.04em;padding:6px 2px 0}\n.tabb{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;height:52px;font-size:11px;color:var(--muted);text-decoration:none}\n.tabb.cur{color:var(--accent);font-weight:600}\n";
/** 원본 틀이 읽는 값 이름 */
export type Vals = { cnt?: any; status?: any; chips?: any; chipOn?: any; chipT?: any; list?: any; listOverflow?: any; stopProps?: any; themeClass?: any };

export function View({ v }: { v: Vals }) {
  return (
    <>
      {" "}
      {" "}
      <div className={`${str(v.themeClass)}` as any} style={{"width":"390px","height":"844px","boxSizing":"border-box","display":"flex","flexDirection":"column","overflow":"hidden"}}>
        {" "}
        <header style={{"display":"flex","flexDirection":"column","gap":"10px","padding":"14px 16px 10px"}}>
          {" "}
          <div style={{"display":"flex","alignItems":"baseline","justifyContent":"space-between"}}>
            <span style={{"fontSize":"18px","fontWeight":"700"}}>
              {"기록"}
            </span>
            <span className="lbl">
              {v.cnt ?? "최근 30일 · 23건"}
            </span>
{v.status ?? null}
          </div>
          {" "}
          <div role="group" aria-label="거르기" style={{"display":"flex","gap":"6px","overflow":"hidden"}}>
            {" "}
            <button className="chip" aria-pressed={v.chips ? String(v.chipOn === 0) as any : "true"} onClick={v.chips?.[0]}>
              {v.chipT?.[0] ?? "전체"}
            </button>
            {" "}
            <button className="chip" aria-pressed={v.chips ? String(v.chipOn === 1) as any : "false"} onClick={v.chips?.[1]}>
              {v.chipT?.[1] ?? "내 임무"}
            </button>
            {" "}
            <button className="chip" aria-pressed={v.chips ? String(v.chipOn === 2) as any : "false"} onClick={v.chips?.[2]}>
              {v.chipT?.[2] ?? "경보 · 중단"}
            </button>
            {" "}
            <button className="chip" aria-pressed={v.chips ? String(v.chipOn === 3) as any : "false"} onClick={v.chips?.[3]}>
              {v.chipT?.[3] ?? "확인 대기"}
            </button>
            {" "}
          </div>
          {" "}
        </header>
        {" "}
        <div style={{"flex":"1","minHeight":"0","overflow":v.listOverflow ?? "hidden","display":"flex","flexDirection":"column","gap":"8px","padding":"0 16px"}}>
          {" "}
          {v.list ?? (<><span className="day">
            {"오늘 · 10월 12일"}
          </span>
          {" "}
          <a className="it" href="#/PcReview">
            {" "}
            <b style={{"fontSize":"15px"}}>
              {"지하 펌프실 사전 측정"}
            </b>
            <span className="res bad">
              {"■ 경보 · 중단"}
            </span>
            {" "}
            <span className="lbl">
              {"가스 사전 측정 · 운영자 A · "}
              <span className="mono">
                {"10:31 · 21분"}
              </span>
            </span>
            <span />
            {" "}
            <span style={{"fontSize":"12px","color":"var(--warn)","fontWeight":"600"}}>
              {"▲ 발견물 1건 확인 대기"}
            </span>
            <span />
            {" "}
          </a>
          {" "}
          <a className="it" href="#/Report">
            {" "}
            <b style={{"fontSize":"15px"}}>
              {"출입로 확인"}
            </b>
            <span className="res ok">
              {"● 완료"}
            </span>
            {" "}
            <span className="lbl">
              {"지점 확인 다녀오기 · 운영자 B · "}
              <span className="mono">
                {"09:05 · 9분"}
              </span>
            </span>
            <span />
            {" "}
          </a>
          {" "}
          <span className="day">
            {"어제 · 10월 11일"}
          </span>
          {" "}
          <a className="it" href="#/Report">
            {" "}
            <b style={{"fontSize":"15px"}}>
              {"B1 정기 순찰"}
            </b>
            <span className="res warn">
              {"▲ 조치 필요"}
            </span>
            {" "}
            <span className="lbl">
              {"시설 순찰 · 운영자 B · "}
              <span className="mono">
                {"16:40 · 24분"}
              </span>
            </span>
            <span />
            {" "}
            <span className="lbl">
              {"발견물 3건"}
            </span>
            <span />
            {" "}
          </a>
          {" "}
          <a className="it" href="#/Report">
            {" "}
            <b style={{"fontSize":"15px"}}>
              {"B1 정기 순찰"}
            </b>
            <span className="res ok">
              {"● 완료"}
            </span>
            {" "}
            <span className="lbl">
              {"시설 순찰 · 운영자 C · "}
              <span className="mono">
                {"11:12 · 22분"}
              </span>
            </span>
            <span />
            {" "}
          </a>
          {" "}
          <span className="day">
            {"10월 10일"}
          </span>
          {" "}
          <a className="it" href="#/Report">
            {" "}
            <b style={{"fontSize":"15px"}}>
              {"펌프실 재측정"}
            </b>
            <span className="res ok">
              {"● 적정"}
            </span>
            {" "}
            <span className="lbl">
              {"가스 사전 측정 · 운영자 A · "}
              <span className="mono">
                {"15:02 · 17분"}
              </span>
            </span>
            <span />
            {" "}
          </a>
          {" "}</>)}
</div>
        {" "}
        <nav aria-label="주 메뉴" style={{"display":"flex","borderTop":"1px solid var(--line)","background":"var(--panel)","marginTop":"10px"}}>
          {" "}
          <a className="tabb" href="#/MHome">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <circle cx="12" cy="12" r="8" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            {"현황"}
          </a>
          {" "}
          <a className="tabb" href="#/MMap">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z" />
            </svg>
            {"지도"}
          </a>
          {" "}
          <a className="tabb" href="#/MFinding">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <rect x="7" y="7" width="10" height="10" transform="rotate(45 12 12)" />
            </svg>
            {"발견물"}
          </a>
          {" "}
          <a className="tabb cur" href="#/MHistory" aria-current="page">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <rect x="5" y="3" width="14" height="18" rx="2" />
              <path d="M9 8h6M9 12h6" />
            </svg>
            {"기록"}
          </a>
          {" "}
        </nav>
        {" "}
        {" "}
      </div>
      {" "}
    </>
  );
}
