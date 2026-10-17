// 생성: scripts/dc2tsx.mjs ← web/MHome.dc.html (시각 원본). 생성 뒤 손으로 실데이터 연결 — 다시 생성해 덮지 않는다.
/* eslint-disable */
import { Fragment } from 'react';
import { arr, css, fn, iv, ivs, str } from '../dc/jsx';

export const PREVIEW = {"width":390,"height":844};
export const FONTS = ["https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap"];
export const CSS = "\nbody{margin:0}\n.fh{--bg:#0B0E11;--panel:#12171C;--panel2:#182028;--line:#26313A;--line2:#34424D;--text:#E6EBEF;--muted:#9AA7B3;--accent:#38C6D9;--on-accent:#061014;--ok:#5AA9FF;--warn:#FFB547;--bad:#FF5A52;--stop:#D7261E;--map:#0E1317;--wall:#4C5A66;--warn-bg:rgba(255,181,71,.12);--acc-bg:rgba(56,198,217,.12);font-family:'IBM Plex Sans KR',system-ui,sans-serif;color:var(--text);background:var(--bg);-webkit-font-smoothing:antialiased}\n.fh.light{--bg:#EDEFEA;--panel:#FFFFFF;--panel2:#F5F6F2;--line:#D7DBD3;--line2:#C2C8BF;--text:#12171C;--muted:#4F5A64;--accent:#006D7A;--on-accent:#FFFFFF;--ok:#1F5FBF;--warn:#9A5800;--bad:#B3261E;--stop:#C8201A;--map:#F8F9F5;--wall:#7C8790;--warn-bg:rgba(154,88,0,.09);--acc-bg:rgba(0,109,122,.08)}\n.mono{font-family:'JetBrains Mono',ui-monospace,monospace;font-variant-numeric:tabular-nums}\nbutton{font:inherit;color:inherit;cursor:pointer}\n.card{background:var(--panel);border:1px solid var(--line);border-radius:12px}\n.lbl{font-size:12px;color:var(--muted)}\n.g{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--panel2)}\n.g.warn{border-color:var(--warn);background:var(--warn-bg)}\n.tabb{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;height:52px;font-size:11px;color:var(--muted);text-decoration:none}\n.tabb.cur{color:var(--accent);font-weight:600}\n";
/** 원본 틀이 읽는 값 이름 */
export type Vals = { themeClass?: any; missionLine?: any; isBase?: any; isGas?: any; hasFind?: any;
  name?: any; linkLine?: any; status?: any; alertP?: any; alertN?: any; mtagHide?: any; big?: any; segsP?: any; segs?: any; rest?: any; pick?: any; map?: any;
  bodyOverflow?: any; tTitle?: any; tSub?: any; grid?: any; tilesHide?: any; tiles?: any; acts?: any; pbP?: any; pbT?: any; ends?: any; stopProps?: any; safe?: any };

export function View({ v }: { v: Vals }) {
  return (
    <>
      {" "}
      {" "}
      <div className={`${str(v.themeClass)}` as any} style={{"width":"390px","height":"844px","boxSizing":"border-box","display":"flex","flexDirection":"column","overflow":"hidden"}}>
        {" "}
        <header style={{"display":"flex","alignItems":"center","gap":"10px","padding":"14px 16px 10px"}}>
          {" "}
          <div style={{"display":"flex","flexDirection":"column","gap":"2px","minWidth":"0","flex":"1"}}>
            {" "}
            <span style={{"fontSize":"18px","fontWeight":"700"}}>
              {v.name ?? "GO2-01"}
            </span>
            {" "}
            {v.linkLine ?? (<>            <span style={{"fontSize":"13px","color":"var(--muted)"}}>
              <span style={{"color":"var(--ok)"}}>
                {"●"}
              </span>
              {" 연결 "}
              <span className="mono">
                {"−62 dBm"}
              </span>
              {" · 배터리 "}
              <span className="mono">
                {"68%"}
              </span>
            </span></>)}
{v.status ?? null}
            {" "}
          </div>
          {" "}
          {" "}
          <a href="#/MAlerts" aria-label="알림 3건" {...v.alertP} style={{"position":"relative","width":"44px","height":"44px","border":"1px solid var(--line2)","borderRadius":"10px","background":"var(--panel)","display":"grid","placeItems":"center","boxSizing":"border-box","color":"inherit","textDecoration":"none"}}>
            {" "}
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="M6 16V11a6 6 0 0112 0v5l2 2H4z" />
              <path d="M10 20a2 2 0 004 0" />
            </svg>
            {" "}
            <span className="mono" style={{"position":"absolute","top":"-6px","right":"-6px","minWidth":"20px","height":"20px","padding":"0 5px","boxSizing":"border-box","borderRadius":"10px","background":"var(--warn)","color":"#1A1206","fontSize":"11px","fontWeight":"700","display":"grid","placeItems":"center"}}>
              {v.alertN ?? "3"}
            </span>
            {" "}
          </a>
          {" "}
        </header>
        {" "}
        <div style={{"flex":"1","minHeight":"0","overflow":"hidden","overflowY":v.bodyOverflow,"display":"flex","flexDirection":"column","gap":"10px","padding":"0 16px"}}>
          {" "}
          <section className="card" aria-label="진행 중 임무" style={{"overflow":"hidden"}}>
            {" "}
            <div style={{"padding":"12px 14px 10px","display":"flex","flexDirection":"column","gap":"8px"}}>
              {" "}
              <div style={{"display":"flex","justifyContent":"space-between","alignItems":"center","gap":"8px"}}>
                {" "}
                <span className="lbl">
                  {iv(v.missionLine)}
                </span>
                {" "}
                <span hidden={v.mtagHide} style={{"fontSize":"12px","fontWeight":"600","color":"var(--accent)","background":"var(--acc-bg)","padding":"3px 8px","borderRadius":"999px"}}>
                  {v.mtagHide === undefined ? "자율 이동" : "수동 진행"}
                </span>
                {" "}
              </div>
              {" "}
              <span style={{"fontSize":"20px","fontWeight":"700","lineHeight":"1.3"}}>
                {v.big ?? "4/6 · WP3 집수정으로 이동 중"}
              </span>
              {" "}
              <div style={{"display":"grid","gridTemplateColumns":"repeat(6,minmax(0,1fr))","gap":"4px"}} aria-label="6단계 중 3단계 완료" {...v.segsP}>
{v.segs ?? (<>
                {" "}
                <span style={{"height":"6px","borderRadius":"3px","background":"var(--ok)"}} />
                <span style={{"height":"6px","borderRadius":"3px","background":"var(--ok)"}} />
                <span style={{"height":"6px","borderRadius":"3px","background":"var(--ok)"}} />
                <span style={{"height":"6px","borderRadius":"3px","background":"var(--accent)"}} />
                <span style={{"height":"6px","borderRadius":"3px","background":"var(--line2)"}} />
                <span style={{"height":"6px","borderRadius":"3px","background":"var(--line2)"}} />
</>)}
                {" "}
              </div>
              {" "}
              {v.rest ?? (<><span className="lbl">
                {"남은 "}
                <span className="mono">
                  {"6 m"}
                </span>
                {" · 예상 임무 종료 "}
                <span className="mono">
                  {"10:58"}
                </span>
                {" · 복귀 여유 "}
                <span className="mono">
                  {"41분"}
                </span>
              </span></>)}
{v.pick ?? null}
              {" "}
            </div>
            {" "}
            {v.map ?? (<><svg viewBox="420 120 520 260" style={{"width":"100%","height":"132px","display":"block","borderTop":"1px solid var(--line)"}} role="img" aria-label="미니맵: 로봇이 집수정 쪽으로 이동 중">
              <rect x="420" y="120" width="520" height="260" style={{"fill":"var(--map)"}} />
              <g style={{"stroke":"var(--wall)"}} strokeWidth="6" fill="none">
                <path d="M440 300H300M500 300H770M830 300H960M640 40V300M380 380H750M810 380H960M600 380V580" />
              </g>
              <polyline points="470,180 470,340 780,340 780,404" fill="none" style={{"stroke":"var(--accent)"}} strokeWidth="5" />
              <polyline points="780,404 780,480" fill="none" style={{"stroke":"var(--muted)"}} strokeWidth="3" strokeDasharray="8 6" />
              <circle cx="470" cy="180" r="13" style={{"fill":"var(--ok)"}} />
              <circle cx="780" cy="490" r="14" style={{"fill":"var(--map)","stroke":"var(--accent)"}} strokeWidth="3" />
              <rect x="531" y="221" width="16" height="16" transform="rotate(45 539 229)" style={{"fill":"var(--warn)"}} />
              <g transform="translate(780 404) rotate(180)">
                <path d="M0 0 L-40 -84 A92 92 0 0 1 40 -84 Z" style={{"fill":"var(--accent)"}} opacity=".16" />
                <path d="M0 -16 L11 11 L0 5 L-11 11 Z" style={{"fill":"var(--accent)"}} />
              </g>
            </svg></>)}
            {" "}
          </section>
          {" "}
          {v.isBase ? (<>
            {" "}
            <section className="card" aria-label="다음 지점에서 할 일" style={{"padding":"12px 14px","display":"flex","flexDirection":"column","gap":"10px"}}>
              {" "}
              <div style={{"display":"flex","justifyContent":"space-between","alignItems":"baseline"}}>
                <span style={{"fontWeight":"600"}}>
                  {v.tTitle ?? "WP3에서 할 일"}
                </span>
                <span className="lbl">
                  {v.tSub ?? "임무 양식의 모듈"}
                </span>
              </div>
              {" "}
              <div style={{"display":"grid","gridTemplateColumns":"22px 1fr","gap":"8px 10px","alignItems":"center","fontSize":"14px"}}>
{v.grid ?? (<>
                {" "}
                <span style={{"width":"12px","height":"12px","borderRadius":"50%","border":"2px solid var(--line2)","justifySelf":"center"}} />
                <span>
                  {"사진 · 전방 1장"}
                </span>
                {" "}
                <span style={{"width":"12px","height":"12px","borderRadius":"50%","border":"2px solid var(--accent)","justifySelf":"center"}} />
                <span>
                  <b>
                    {"운영자 확인"}
                  </b>
                  {" · 도착하면 진동으로 알려 드립니다"}
                </span>
                {" "}
</>)}
              </div>
              {" "}
              <div hidden={v.tilesHide} style={{"display":v.tilesHide ? "none" : "grid","gridTemplateColumns":"repeat(3,minmax(0,1fr))","gap":"6px"}}>
{v.tiles ?? (<>
                {" "}
                <div style={{"aspectRatio":"4/3","borderRadius":"6px","background":"#0D1317"}} />
                <div style={{"aspectRatio":"4/3","borderRadius":"6px","background":"#111A1F"}} />
                <div style={{"aspectRatio":"4/3","borderRadius":"6px","border":"1.5px dashed var(--line2)","display":"grid","placeItems":"center"}} className="lbl">
                  {"WP3"}
                </div>
                {" "}
</>)}
              </div>
{v.acts ?? null}
              {" "}
            </section>
            {" "}
          </>) : null}
          {" "}
          {v.isGas ? (<>
            {" "}
            <section className="card" aria-label="가스 측정" style={{"padding":"12px 14px","display":"flex","flexDirection":"column","gap":"8px"}}>
              {" "}
              <div style={{"display":"flex","justifyContent":"space-between","alignItems":"baseline"}}>
                <span style={{"fontWeight":"600"}}>
                  {"가스"}
                </span>
                <span className="lbl">
                  {"1초 전 · 4종 + CO₂"}
                </span>
              </div>
              {" "}
              <div style={{"display":"grid","gridTemplateColumns":"repeat(3,minmax(0,1fr))","gap":"6px"}}>
                {" "}
                <div className="g">
                  <span className="lbl">
                    {"O₂ "}
                    <span style={{"color":"var(--ok)"}}>
                      {"●"}
                    </span>
                  </span>
                  <span className="mono" style={{"fontSize":"18px","fontWeight":"600"}}>
                    {"20.4"}
                    <span style={{"fontSize":"11px","color":"var(--muted)"}}>
                      {" %"}
                    </span>
                  </span>
                </div>
                {" "}
                <div className="g warn">
                  <span className="lbl" style={{"color":"var(--warn)","fontWeight":"600"}}>
                    {"H₂S ▲ 주의"}
                  </span>
                  <span className="mono" style={{"fontSize":"18px","fontWeight":"700","color":"var(--warn)"}}>
                    {"6.8"}
                    <span style={{"fontSize":"11px"}}>
                      {" ppm"}
                    </span>
                  </span>
                </div>
                {" "}
                <div className="g">
                  <span className="lbl">
                    {"CO "}
                    <span style={{"color":"var(--ok)"}}>
                      {"●"}
                    </span>
                  </span>
                  <span className="mono" style={{"fontSize":"18px","fontWeight":"600"}}>
                    {"3"}
                    <span style={{"fontSize":"11px","color":"var(--muted)"}}>
                      {" ppm"}
                    </span>
                  </span>
                </div>
                {" "}
                <div className="g">
                  <span className="lbl">
                    {"LEL "}
                    <span style={{"color":"var(--ok)"}}>
                      {"●"}
                    </span>
                  </span>
                  <span className="mono" style={{"fontSize":"18px","fontWeight":"600"}}>
                    {"1"}
                    <span style={{"fontSize":"11px","color":"var(--muted)"}}>
                      {" %"}
                    </span>
                  </span>
                </div>
                {" "}
                <div className="g">
                  <span className="lbl">
                    {"CO₂ "}
                    <span style={{"color":"var(--ok)"}}>
                      {"●"}
                    </span>
                  </span>
                  <span className="mono" style={{"fontSize":"18px","fontWeight":"600"}}>
                    {"0.21"}
                    <span style={{"fontSize":"11px","color":"var(--muted)"}}>
                      {" %"}
                    </span>
                  </span>
                </div>
                {" "}
                <div className="g" style={{"justifyContent":"center"}}>
                  <span className="lbl">
                    {"H₂S 기준"}
                  </span>
                  <span className="mono" style={{"fontSize":"13px","fontWeight":"600"}}>
                    {"10 ppm 미만"}
                  </span>
                </div>
                {" "}
              </div>
              {" "}
            </section>
            {" "}
          </>) : null}
          {" "}
          {v.hasFind ? (<>
            {" "}
            <a href="#/MFinding" className="card" style={{"display":"flex","alignItems":"center","gap":"12px","padding":"12px 14px","textDecoration":"none","color":"inherit","minHeight":"44px"}}>
              {" "}
              <span style={{"width":"12px","height":"12px","transform":"rotate(45deg)","background":"var(--warn)","flex":"none","margin":"0 4px"}} />
              {" "}
              <span style={{"display":"flex","flexDirection":"column","gap":"2px","flex":"1"}}>
                <span style={{"fontWeight":"600"}}>
                  {"발견물 2건 확인 대기"}
                </span>
                <span className="lbl">
                  {"바닥 물고임 · 보온재 손상"}
                </span>
              </span>
              {" "}
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M9 6l6 6-6 6" />
              </svg>
              {" "}
            </a>
            {" "}
          </>) : null}
          {" "}
          <div style={{"display":"grid","gridTemplateColumns":"repeat(2,minmax(0,1fr))","gap":"8px"}}>
            {" "}
            <button {...v.pbP} style={{"height":"52px","border":"1px solid var(--line2)","borderRadius":"10px","background":"var(--panel)","fontWeight":"600","display":"flex","alignItems":"center","justifyContent":"center","gap":"8px"}}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M8 5v14M16 5v14" />
              </svg>
              {v.pbT ?? "일시정지"}
            </button>
            {" "}
            <a href="#/MDrive" style={{"height":"52px","borderRadius":"10px","background":"var(--accent)","color":"var(--on-accent)","fontWeight":"700","display":"flex","alignItems":"center","justifyContent":"center","gap":"8px","textDecoration":"none"}}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <circle cx="12" cy="12" r="8" />
                <circle cx="12" cy="12" r="2.5" />
              </svg>
              {"조종 화면"}
            </a>
            {" "}
          </div>
{v.ends ?? null}
          {" "}
        </div>
        {" "}
        <nav aria-label="주 메뉴" style={{"display":"flex","borderTop":"1px solid var(--line)","background":"var(--panel)","marginTop":"10px"}}>
          {" "}
          <a className="tabb cur" href="#/MHome" aria-current="page">
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
          <a className="tabb" href="#/MHistory">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <rect x="5" y="3" width="14" height="18" rx="2" />
              <path d="M9 8h6M9 12h6" />
            </svg>
            {"기록"}
          </a>
          {" "}
        </nav>
        {" "}
        <div style={{"padding":"8px 16px 18px","background":"var(--panel)"}}>
          {" "}
          <button aria-label="비상 정지" {...v.stopProps} style={{"width":"100%","height":"64px","border":"0","borderRadius":"12px","background":"var(--stop)","color":"#FFFFFF","display":"flex","alignItems":"center","justifyContent":"center","gap":"12px"}}>
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
              {"입력 차단·잠금"}
            </span>
            {" "}
          </button>
          {v.safe ?? null}
          {" "}
        </div>
        {" "}
      </div>
      {" "}
    </>
  );
}
