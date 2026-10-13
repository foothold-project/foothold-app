// 생성: scripts/dc2tsx.mjs ← web/Report.dc.html (시각 원본). 생성 뒤 손으로 실데이터 연결 — 다시 생성해 덮지 않는다.
/* eslint-disable */
import { Fragment } from 'react';
import { arr, css, fn, iv, ivs, str } from '../dc/jsx';

export const PREVIEW = {"width":794,"height":1123};
export const FONTS = ["https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap"];
export const CSS = "\nbody{margin:0;background:#FFFFFF}\n.mono{font-family:'JetBrains Mono',ui-monospace,monospace;font-variant-numeric:tabular-nums}\ntable{border-collapse:collapse;width:100%}\nth{font-size:12px;font-weight:600;color:#3D464E;text-align:right;padding:7px 8px;border-bottom:1.5px solid #12171C;white-space:nowrap}\ntd{font-size:13px;padding:7px 8px;border-bottom:1px solid #C9CEC6;text-align:right;white-space:nowrap}\nth:first-child,td:first-child{text-align:left}\nth.l,td.l{text-align:left}\n.k{font-size:12px;color:#4F5A64}\n.iv{display:grid;grid-template-columns:72px 1fr;gap:6px}\n.thumb{display:flex;flex-direction:column;gap:4px}\n";
/** 원본 틀이 읽는 값 이름 */
export type Vals = { title?: any; tplLine?: any; wpLine?: any; isGas?: any; resColor?: any; resHead?: any; resBody?: any; todo?: any; isBase?: any; isPatrol?: any; modLine?: any; gasPath?: any; fullPath?: any; findPins?: any; mapCap?: any; hasFind?: any; signA?: any; keep?: any };

export function View({ v }: { v: Vals }) {
  return (
    <>
      {" "}
      {" "}
      <div style={{"width":"794px","height":"1123px","boxSizing":"border-box","padding":"52px 56px 44px","background":"#FFFFFF","color":"#12171C","fontFamily":"'IBM Plex Sans KR',system-ui,sans-serif","display":"flex","flexDirection":"column","gap":"16px"}}>
        {" "}
        <header style={{"display":"flex","justifyContent":"space-between","alignItems":"flex-start","gap":"16px","paddingBottom":"12px","borderBottom":"2px solid #12171C"}}>
          {" "}
          <div style={{"display":"flex","flexDirection":"column","gap":"4px"}}>
            {" "}
            <span style={{"fontSize":"12px","letterSpacing":".14em","fontWeight":"700","color":"#006D7A"}}>
              {"FOOTHOLD · 임무 기록"}
            </span>
            {" "}
            <h1 style={{"margin":"0","fontSize":"24px","fontWeight":"700","letterSpacing":"-.01em"}}>
              {iv(v.title)}
            </h1>
            {" "}
          </div>
          {" "}
          <div style={{"display":"flex","flexDirection":"column","alignItems":"flex-end","gap":"2px"}}>
            {" "}
            <span className="k">
              {"기록 번호"}
            </span>
            <span className="mono" style={{"fontSize":"14px","fontWeight":"600"}}>
              {"FH-20261012-03"}
            </span>
            {" "}
          </div>
          {" "}
        </header>
        {" "}
        <section style={{"display":"grid","gridTemplateColumns":"repeat(2,minmax(0,1fr))","gap":"8px 24px","fontSize":"13px"}}>
          {" "}
          <div className="iv">
            <span className="k">
              {"장소"}
            </span>
            <span>
              {"[현장명] B1"}
            </span>
          </div>
          {" "}
          <div className="iv">
            <span className="k">
              {"일시"}
            </span>
            <span className="mono">
              {"2026-10-12 10:31–10:52"}
            </span>
          </div>
          {" "}
          <div className="iv">
            <span className="k">
              {"운영자"}
            </span>
            <span>
              {"운영자 A"}
            </span>
          </div>
          {" "}
          <div className="iv">
            <span className="k">
              {"로봇"}
            </span>
            <span>
              {"Unitree Go2 EDU · GO2-01"}
            </span>
          </div>
          {" "}
          <div className="iv">
            <span className="k">
              {"임무 양식"}
            </span>
            <span>
              {iv(v.tplLine)}
            </span>
          </div>
          {" "}
          <div className="iv">
            <span className="k">
              {"지점"}
            </span>
            <span>
              {iv(v.wpLine)}
            </span>
          </div>
          {" "}
          {v.isGas ? (<>
            {" "}
            <div className="iv">
              <span className="k">
                {"측정 장비"}
              </span>
              <span>
                {"[검지기 모델] 4종 + CO₂ · 범프 테스트 "}
                <span className="mono">
                  {"10:20"}
                </span>
              </span>
            </div>
            {" "}
            <div className="iv">
              <span className="k">
                {"판정 기준"}
              </span>
              <span>
                {"예시 기준 · 검증 전"}
              </span>
            </div>
            {" "}
          </>) : null}
          {" "}
        </section>
        {" "}
        <section style={css(`display:flex;gap:16px;align-items:stretch;border:2px solid ${str(v.resColor)};border-radius:6px;padding:12px 16px`)}>
          {" "}
          <div style={{"display":"flex","flexDirection":"column","gap":"2px","flex":"1"}}>
            {" "}
            <span style={css(`font-size:12px;font-weight:700;color:${str(v.resColor)}`)}>
              {"임무 결과"}
            </span>
            {" "}
            <span style={css(`font-size:20px;font-weight:700;color:${str(v.resColor)}`)}>
              {iv(v.resHead)}
            </span>
            {" "}
            <span style={{"fontSize":"13px","lineHeight":"1.5"}}>
              {iv(v.resBody)}
            </span>
            {" "}
          </div>
          {" "}
          <div style={{"width":"1px","background":"#D7DBD3"}} />
          {" "}
          <div style={{"display":"flex","flexDirection":"column","gap":"2px","width":"190px"}}>
            {" "}
            <span style={{"fontSize":"12px","fontWeight":"700","color":"#3D464E"}}>
              {"필요 조치"}
            </span>
            {" "}
            <span style={{"fontSize":"13px","lineHeight":"1.5"}}>
              {iv(v.todo)}
            </span>
            {" "}
          </div>
          {" "}
        </section>
        {" "}
        <section style={{"display":"flex","flexDirection":"column","gap":"6px"}}>
          {" "}
          <h2 style={{"margin":"0","fontSize":"15px","fontWeight":"700"}}>
            {"지점별 결과"}
          </h2>
          {" "}
          {v.isGas ? (<>
            {" "}
            <table>
              {" "}
              <thead>
                <tr>
                  <th>
                    {"지점"}
                  </th>
                  <th>
                    {"측정 시각"}
                  </th>
                  <th>
                    {"O₂ %"}
                  </th>
                  <th>
                    {"H₂S ppm"}
                  </th>
                  <th>
                    {"CO ppm"}
                  </th>
                  <th>
                    {"LEL %"}
                  </th>
                  <th>
                    {"CO₂ %"}
                  </th>
                  <th className="l">
                    {"판정"}
                  </th>
                </tr>
              </thead>
              {" "}
              <tbody>
                {" "}
                <tr style={{"background":"#F2F3F0"}}>
                  <td className="k">
                    {"적정 기준"}
                  </td>
                  <td />
                  <td className="mono k">
                    {"18 – 23.5 미만"}
                  </td>
                  <td className="mono k">
                    {"10 미만"}
                  </td>
                  <td className="mono k">
                    {"30 미만"}
                  </td>
                  <td className="mono k">
                    {"10 미만*"}
                  </td>
                  <td className="mono k">
                    {"1.5 미만"}
                  </td>
                  <td />
                </tr>
                {" "}
                <tr>
                  <td>
                    {"WP1 계단실 하부"}
                  </td>
                  <td className="mono">
                    {"10:33:20"}
                  </td>
                  <td className="mono">
                    {"20.9"}
                  </td>
                  <td className="mono">
                    {"0.0"}
                  </td>
                  <td className="mono">
                    {"2"}
                  </td>
                  <td className="mono">
                    {"0"}
                  </td>
                  <td className="mono">
                    {"0.08"}
                  </td>
                  <td className="l">
                    {"● 적정"}
                  </td>
                </tr>
                {" "}
                <tr>
                  <td>
                    {"WP2 펌프실 A"}
                  </td>
                  <td className="mono">
                    {"10:39:44"}
                  </td>
                  <td className="mono">
                    {"20.6"}
                  </td>
                  <td className="mono">
                    {"1.2"}
                  </td>
                  <td className="mono">
                    {"2"}
                  </td>
                  <td className="mono">
                    {"0"}
                  </td>
                  <td className="mono">
                    {"0.12"}
                  </td>
                  <td className="l">
                    {"● 적정"}
                  </td>
                </tr>
                {" "}
                <tr>
                  <td>
                    <b>
                      {"WP3 집수정"}
                    </b>
                  </td>
                  <td className="mono">
                    {"10:46:08"}
                  </td>
                  <td className="mono">
                    {"19.6"}
                  </td>
                  <td className="mono" style={{"color":"#B3261E","fontWeight":"700"}}>
                    {"12.4 ■"}
                  </td>
                  <td className="mono">
                    {"4"}
                  </td>
                  <td className="mono">
                    {"2"}
                  </td>
                  <td className="mono">
                    {"0.34"}
                  </td>
                  <td className="l" style={{"color":"#B3261E","fontWeight":"700"}}>
                    {"■ 부적정"}
                  </td>
                </tr>
                {" "}
                <tr>
                  <td>
                    {"WP4 배관 구역"}
                  </td>
                  <td className="mono">
                    {"—"}
                  </td>
                  <td className="mono">
                    {"—"}
                  </td>
                  <td className="mono">
                    {"—"}
                  </td>
                  <td className="mono">
                    {"—"}
                  </td>
                  <td className="mono">
                    {"—"}
                  </td>
                  <td className="mono">
                    {"—"}
                  </td>
                  <td className="l" style={{"color":"#4F5A64"}}>
                    {"미측정 · 중단"}
                  </td>
                </tr>
                {" "}
              </tbody>
              {" "}
            </table>
            {" "}
            <span className="k">
              {"* 표의 기준값은 예시 기준 · 검증 전입니다. 실제 적용 기준이 아닙니다."}
            </span>
            {" "}
          </>) : null}
          {" "}
          {v.isBase ? (<>
            {" "}
            <table>
              {" "}
              <thead>
                <tr>
                  <th>
                    {"지점"}
                  </th>
                  <th>
                    {"도착 시각"}
                  </th>
                  <th>
                    {"도착 오차"}
                  </th>
                  <th>
                    {"사진"}
                  </th>
                  <th className="l">
                    {"운영자 판단"}
                  </th>
                  <th className="l">
                    {"판정"}
                  </th>
                </tr>
              </thead>
              {" "}
              <tbody>
                {" "}
                <tr>
                  <td>
                    {"WP1 계단실 하부"}
                  </td>
                  <td className="mono">
                    {"10:33:02"}
                  </td>
                  <td className="mono">
                    {"0.2 m"}
                  </td>
                  <td className="mono">
                    {"1"}
                  </td>
                  <td className="l k">
                    {"—"}
                  </td>
                  <td className="l">
                    {"● 완료"}
                  </td>
                </tr>
                {" "}
                <tr>
                  <td>
                    {"WP2 펌프실 A"}
                  </td>
                  <td className="mono">
                    {"10:39:30"}
                  </td>
                  <td className="mono">
                    {"0.3 m"}
                  </td>
                  <td className="mono">
                    {"1"}
                  </td>
                  <td className="l">
                    {"맞음 · 운영자 A "}
                    <span className="mono k">
                      {"10:40:30"}
                    </span>
                  </td>
                  <td className="l">
                    {"● 완료"}
                  </td>
                </tr>
                {" "}
                <tr>
                  <td>
                    {"WP3 집수정"}
                  </td>
                  <td className="mono">
                    {"10:45:20"}
                  </td>
                  <td className="mono">
                    {"0.3 m"}
                  </td>
                  <td className="mono">
                    {"1"}
                  </td>
                  <td className="l">
                    {"다시 보기 → 맞음 "}
                    <span className="mono k">
                      {"10:47:02"}
                    </span>
                  </td>
                  <td className="l">
                    {"● 완료"}
                  </td>
                </tr>
                {" "}
                <tr>
                  <td>
                    {"WP4 배관 구역"}
                  </td>
                  <td className="mono">
                    {"10:49:41"}
                  </td>
                  <td className="mono">
                    {"0.4 m"}
                  </td>
                  <td className="mono">
                    {"1"}
                  </td>
                  <td className="l k">
                    {"—"}
                  </td>
                  <td className="l">
                    {"● 완료"}
                  </td>
                </tr>
                {" "}
              </tbody>
              {" "}
            </table>
            {" "}
          </>) : null}
          {" "}
          {v.isPatrol ? (<>
            {" "}
            <table>
              {" "}
              <thead>
                <tr>
                  <th>
                    {"지점"}
                  </th>
                  <th>
                    {"도착 시각"}
                  </th>
                  <th>
                    {"사진"}
                  </th>
                  <th>
                    {"탐지"}
                  </th>
                  <th>
                    {"사람 확인"}
                  </th>
                  <th className="l">
                    {"판정"}
                  </th>
                </tr>
              </thead>
              {" "}
              <tbody>
                {" "}
                <tr>
                  <td>
                    {"WP1 계단실 하부"}
                  </td>
                  <td className="mono">
                    {"10:33:02"}
                  </td>
                  <td className="mono">
                    {"3"}
                  </td>
                  <td className="mono">
                    {"0"}
                  </td>
                  <td className="mono">
                    {"—"}
                  </td>
                  <td className="l">
                    {"● 이상 없음"}
                  </td>
                </tr>
                {" "}
                <tr>
                  <td>
                    {"WP2 펌프실 A"}
                  </td>
                  <td className="mono">
                    {"10:39:30"}
                  </td>
                  <td className="mono">
                    {"3"}
                  </td>
                  <td className="mono">
                    {"2"}
                  </td>
                  <td className="mono">
                    {"맞음 2"}
                  </td>
                  <td className="l" style={{"color":"#9A5800","fontWeight":"700"}}>
                    {"▲ 조치 필요"}
                  </td>
                </tr>
                {" "}
                <tr>
                  <td>
                    {"복도 (이동 중)"}
                  </td>
                  <td className="mono">
                    {"10:40:58"}
                  </td>
                  <td className="mono">
                    {"1"}
                  </td>
                  <td className="mono">
                    {"1"}
                  </td>
                  <td className="mono">
                    {"맞음 1"}
                  </td>
                  <td className="l">
                    {"● 기록 · 문 열림"}
                  </td>
                </tr>
                {" "}
                <tr>
                  <td>
                    {"WP3 집수정"}
                  </td>
                  <td className="mono">
                    {"10:45:20"}
                  </td>
                  <td className="mono">
                    {"3"}
                  </td>
                  <td className="mono">
                    {"0"}
                  </td>
                  <td className="mono">
                    {"—"}
                  </td>
                  <td className="l">
                    {"● 이상 없음"}
                  </td>
                </tr>
                {" "}
                <tr>
                  <td>
                    {"WP4 배관 구역"}
                  </td>
                  <td className="mono">
                    {"10:49:41"}
                  </td>
                  <td className="mono">
                    {"3"}
                  </td>
                  <td className="mono">
                    {"1"}
                  </td>
                  <td className="mono">
                    {"오탐 1"}
                  </td>
                  <td className="l">
                    {"● 이상 없음"}
                  </td>
                </tr>
                {" "}
              </tbody>
              {" "}
            </table>
            {" "}
          </>) : null}
          {" "}
          <span className="k">
            {"이 표의 열은 임무 양식에 들어 있는 모듈("}
            {iv(v.modLine)}
            {")에서 만들어졌습니다."}
          </span>
          {" "}
        </section>
        {" "}
        <section style={{"display":"grid","gridTemplateColumns":"minmax(0,1.15fr) minmax(0,1fr)","gap":"16px"}}>
          {" "}
          <figure style={{"margin":"0","display":"flex","flexDirection":"column","gap":"6px"}}>
            {" "}
            <h2 style={{"margin":"0","fontSize":"15px","fontWeight":"700"}}>
              {"이동 경로"}
            </h2>
            {" "}
            <svg viewBox="40 40 920 545" style={{"width":"100%","height":"auto","border":"1px solid #C9CEC6"}} role="img" aria-label="지도: 출발점에서 측정 지점을 지난 경로">
              <rect x="40" y="40" width="920" height="545" fill="#FFFFFF" />
              <rect x="43" y="43" width="254" height="194" fill="#F4E3E1" />
              <g stroke="#6E7881" strokeWidth="6" fill="none">
                <rect x="40" y="40" width="920" height="540" />
                <path d="M40 240H200M260 240H300M300 40V300M300 300H440M500 300H770M830 300H960M640 40V300M40 380H120M180 380H330M380 380H750M810 380H960M240 380V580M600 380V580" />
              </g>
              <polyline points="120,540 150,450 150,340 470,340 470,180 470,340 780,340 780,476" fill="none" stroke="#006D7A" strokeWidth="6" display={`${str(v.gasPath)}` as any} />
              <polyline points="780,476 780,340 700,340" fill="none" stroke="#B3261E" strokeWidth="5" strokeDasharray="12 8" display={`${str(v.gasPath)}` as any} />
              <polyline points="120,540 150,450 150,340 470,340 470,180 470,340 780,340 780,490 780,340 800,340 800,170 800,340 150,340 150,450 120,540" fill="none" stroke="#006D7A" strokeWidth="6" strokeLinejoin="round" display={`${str(v.fullPath)}` as any} />
              <g fontFamily="JetBrains Mono, monospace" fontWeight="700" fontSize="22" textAnchor="middle">
                <circle cx="150" cy="450" r="20" fill="#12171C" />
                <text x="150" y="458" fill="#FFFFFF">
                  {"1"}
                </text>
                <circle cx="470" cy="180" r="20" fill="#12171C" />
                <text x="470" y="188" fill="#FFFFFF">
                  {"2"}
                </text>
                <g display={`${str(v.gasPath)}` as any}>
                  <rect x="760" y="470" width="40" height="40" fill="#B3261E" />
                  <text x="780" y="498" fill="#FFFFFF">
                    {"3"}
                  </text>
                  <circle cx="800" cy="170" r="20" fill="#FFFFFF" stroke="#6E7881" strokeWidth="3" />
                  <text x="800" y="178" fill="#4F5A64">
                    {"4"}
                  </text>
                  <circle cx="700" cy="340" r="18" fill="#FFFFFF" stroke="#B3261E" strokeWidth="3" />
                  <text x="700" y="348" fill="#B3261E">
                    {"R"}
                  </text>
                </g>
                <g display={`${str(v.fullPath)}` as any}>
                  <circle cx="780" cy="490" r="20" fill="#12171C" />
                  <text x="780" y="498" fill="#FFFFFF">
                    {"3"}
                  </text>
                  <circle cx="800" cy="170" r="20" fill="#12171C" />
                  <text x="800" y="178" fill="#FFFFFF">
                    {"4"}
                  </text>
                </g>
              </g>
              <g display={`${str(v.findPins)}` as any}>
                <rect x="528" y="218" width="22" height="22" transform="rotate(45 539 229)" fill="#9A5800" />
                <rect x="394" y="249" width="22" height="22" transform="rotate(45 405 260)" fill="#9A5800" />
              </g>
              <g fontFamily="IBM Plex Sans KR, sans-serif" fontSize="22" fill="#4F5A64">
                <text x="60" y="80" fill="#B3261E">
                  {"진입 금지"}
                </text>
                <text x="320" y="80">
                  {"펌프실 A"}
                </text>
                <text x="660" y="80">
                  {"배관 구역"}
                </text>
                <text x="620" y="420">
                  {"집수정"}
                </text>
              </g>
            </svg>
            {" "}
            <figcaption className="k">
              {iv(v.mapCap)}
            </figcaption>
            {" "}
          </figure>
          {" "}
          <div style={{"display":"flex","flexDirection":"column","gap":"8px"}}>
            {" "}
            {v.isBase ? (<>
              {" "}
              <h2 style={{"margin":"0","fontSize":"15px","fontWeight":"700"}}>
                {"지점 사진"}
              </h2>
              {" "}
              <div style={{"display":"grid","gridTemplateColumns":"repeat(2,minmax(0,1fr))","gap":"8px"}}>
                {" "}
                <div className="thumb">
                  <svg viewBox="0 0 160 90" style={{"width":"100%","height":"auto"}} aria-hidden="true">
                    <rect width="160" height="90" fill="#1A2126" />
                    <polygon points="0,90 160,90 110,48 50,48" fill="#2A343B" />
                  </svg>
                  <span className="k">
                    {"WP1 · "}
                    <span className="mono">
                      {"10:33"}
                    </span>
                  </span>
                </div>
                {" "}
                <div className="thumb">
                  <svg viewBox="0 0 160 90" style={{"width":"100%","height":"auto"}} aria-hidden="true">
                    <rect width="160" height="90" fill="#1A2126" />
                    <polygon points="0,90 160,90 118,48 42,48" fill="#2A343B" />
                    <circle cx="118" cy="38" r="18" fill="#26313A" />
                  </svg>
                  <span className="k">
                    {"WP2 · "}
                    <span className="mono">
                      {"10:39"}
                    </span>
                  </span>
                </div>
                {" "}
                <div className="thumb">
                  <svg viewBox="0 0 160 90" style={{"width":"100%","height":"auto"}} aria-hidden="true">
                    <rect width="160" height="90" fill="#1A2126" />
                    <polygon points="0,90 160,90 100,52 60,52" fill="#2A343B" />
                    <rect x="60" y="24" width="40" height="28" fill="#0E1317" />
                  </svg>
                  <span className="k">
                    {"WP3 · "}
                    <span className="mono">
                      {"10:45"}
                    </span>
                  </span>
                </div>
                {" "}
                <div className="thumb">
                  <svg viewBox="0 0 160 90" style={{"width":"100%","height":"auto"}} aria-hidden="true">
                    <rect width="160" height="90" fill="#1A2126" />
                    <rect x="0" y="30" width="160" height="10" fill="#3A4852" />
                    <rect x="0" y="50" width="160" height="6" fill="#3A4852" />
                  </svg>
                  <span className="k">
                    {"WP4 · "}
                    <span className="mono">
                      {"10:49"}
                    </span>
                  </span>
                </div>
                {" "}
              </div>
              {" "}
            </>) : null}
            {" "}
            {v.hasFind ? (<>
              {" "}
              <h2 style={{"margin":"0","fontSize":"15px","fontWeight":"700"}}>
                {"확인된 발견물"}
              </h2>
              {" "}
              <div style={{"display":"grid","gridTemplateColumns":"96px 1fr","gap":"10px","alignItems":"start"}}>
                {" "}
                <svg viewBox="0 0 640 360" style={{"width":"96px","height":"54px"}} aria-hidden="true">
                  <rect width="640" height="360" fill="#1A2126" />
                  <polygon points="0,360 640,360 470,190 170,190" fill="#2A343B" />
                  <ellipse cx="330" cy="292" rx="150" ry="30" fill="#4C6876" />
                  <rect x="170" y="252" width="320" height="76" fill="none" stroke="#FFB547" strokeWidth="10" />
                </svg>
                {" "}
                <div style={{"display":"flex","flexDirection":"column","gap":"2px","fontSize":"13px"}}>
                  <b>
                    {"바닥 물고임 · WP2"}
                  </b>
                  <span className="k">
                    {"미끄럼 주의 · 펌프 B 씰 누수 의심"}
                  </span>
                  <span className="k">
                    {"확인 운영자 A "}
                    <span className="mono">
                      {"10:55"}
                    </span>
                  </span>
                </div>
                {" "}
              </div>
              {" "}
              <div style={{"display":"grid","gridTemplateColumns":"96px 1fr","gap":"10px","alignItems":"start"}}>
                {" "}
                <svg viewBox="0 0 640 360" style={{"width":"96px","height":"54px"}} aria-hidden="true">
                  <rect width="640" height="360" fill="#1A2126" />
                  <rect x="0" y="120" width="640" height="60" fill="#3A4852" />
                  <rect x="290" y="110" width="140" height="80" fill="#6B5A4A" />
                  <rect x="270" y="96" width="180" height="108" fill="none" stroke="#5AA9FF" strokeWidth="10" />
                </svg>
                {" "}
                <div style={{"display":"flex","flexDirection":"column","gap":"2px","fontSize":"13px"}}>
                  <b>
                    {"배관 보온재 손상 · WP2"}
                  </b>
                  <span className="k">
                    {"교체 필요"}
                  </span>
                  <span className="k">
                    {"확인 운영자 A "}
                    <span className="mono">
                      {"10:56"}
                    </span>
                  </span>
                </div>
                {" "}
              </div>
              {" "}
              <span className="k">
                {"AI 탐지는 사람이 «맞음»으로 확인한 것만 싣습니다. 오탐은 원자료에만 남깁니다."}
              </span>
              {" "}
            </>) : null}
            {" "}
          </div>
          {" "}
        </section>
        {" "}
        <section style={{"display":"grid","gridTemplateColumns":"repeat(2,minmax(0,1fr))","gap":"16px","marginTop":"auto"}}>
          {" "}
          <div style={{"border":"1px solid #9AA3A9","borderRadius":"4px","padding":"10px 12px","height":"64px","display":"flex","flexDirection":"column","justifyContent":"space-between"}}>
            <span className="k">
              {iv(v.signA)}
            </span>
            <span style={{"display":"flex","justifyContent":"space-between","fontSize":"13px"}}>
              <span>
                {"운영자 A"}
              </span>
              <span className="k">
                {"(서명)"}
              </span>
            </span>
          </div>
          {" "}
          <div style={{"border":"1px solid #9AA3A9","borderRadius":"4px","padding":"10px 12px","height":"64px","display":"flex","flexDirection":"column","justifyContent":"space-between"}}>
            <span className="k">
              {"현장 책임자 확인"}
            </span>
            <span style={{"display":"flex","justifyContent":"space-between","fontSize":"13px"}}>
              <span>
                {"[이름]"}
              </span>
              <span className="k">
                {"(서명)"}
              </span>
            </span>
          </div>
          {" "}
        </section>
        {" "}
        <footer style={{"display":"flex","justifyContent":"space-between","gap":"12px","paddingTop":"10px","borderTop":"1px solid #C9CEC6","fontSize":"12px","color":"#4F5A64"}}>
          {" "}
          <span>
            {iv(v.keep)}
          </span>
          {" "}
          <span className="mono">
            {"1 / 1"}
          </span>
          {" "}
        </footer>
        {" "}
      </div>
      {" "}
    </>
  );
}
