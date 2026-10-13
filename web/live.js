// v2 시뮬 실연결 모드 — 주소에 ?live=v2 가 있을 때만 켜진다. 없으면 시안 그대로 두고 «시안 · 동작 안 함» 안내만 띄운다.
// 서버 sim/v2_link.py(127.0.0.1:8790)와 WebSocket 으로 잇는다. 안전 판단은 서버가 하고, 이 화면은 믿지 않는 층이다:
//   누르는 동안만 입력을 보내고, 연결·조종권·STOP·리셋·에피소드·시뮬 상태·확대/닫기·창 떠남이 바뀌면 모든 누름을 버린다(새로 눌러야 움직임).
// 시안 마크업은 바꾸지 않는다. 실연결 중에는 시안 예시값을 실제값이나 «미연결»로 바꾸고, 지원 안 되는 버튼은 눌러서 이유를 보게 한다.
(() => {
  const PAGE = location.pathname.split('/').pop();
  const LIVE_PAGES = ['Main.dc.html', 'MDrive.dc.html', 'MHome.dc.html', 'MMap.dc.html', 'MFinding.dc.html', 'MHistory.dc.html', 'MAlerts.dc.html', 'MAlert.dc.html',
    'PcMap.dc.html', 'PcMissions.dc.html', 'PcPlan.dc.html', 'PcHistory.dc.html', 'PcReview.dc.html', 'PcRobot.dc.html', 'PcSettings.dc.html', 'Report.dc.html'];   // System(디자인 체계)·로그인 빼고 전부
  // 8780 은 정적 미리보기 서버(WebSocket 없음) — 실연결은 v2_link(8790) 주소로 보낸다. 그 밖(8790·시험 8791)은 같은 origin.
  const LIVE_BASE = location.port === '8780' ? 'http://127.0.0.1:8790/' : '';
  const Q = new URLSearchParams(location.search);
  const live = Q.get('live') === 'v2';
  const LOGIN_PAGES = ['MLogin.dc.html', 'PcLogin.dc.html'];      // 보호 관문(https) 로그인에 연결
  const LAYOUTS = ['왼쪽 회전 · 오른쪽 앞뒤', '왼쪽 이동 · 오른쪽 회전'];   // 휴대폰 기본 = 처음 확정한 배치(왼쪽 회전·오른쪽 앞뒤)
  if (live && !LIVE_BASE && PAGE === 'MDrive.dc.html' && !Q.has('stickLayout')) {   // 시안 실행기가 읽기 전에 막대 배치를 주소에 넣는다
    let l = LAYOUTS[0]; try { l = JSON.parse(localStorage.getItem('fh.live.layout')) || l; } catch (_) { /* 저장 막힘: 기본 */ }
    Q.set('stickLayout', LAYOUTS.includes(l) ? l : LAYOUTS[0]); history.replaceState(null, '', `${PAGE}?${Q}`);
  }
  if (!live || LIVE_BASE) {
    if (LIVE_PAGES.includes(PAGE)) {
      const why = live ? '이 주소(8780)는 시안 미리보기 서버라 실연결이 안 됩니다' : '시안 화면입니다 · 버튼·STOP 은 로봇을 움직이거나 멈추지 않습니다';
      const go = () => designNote(why, `${LIVE_BASE}${PAGE}?live=v2`);
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
    }
    return;
  }
  function designNote(text, href) {
    const n = document.createElement('div'); n.setAttribute('role', 'note'); n.dataset.liveDesignNote = '1';
    n.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:60;display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center;max-width:calc(100vw - 24px);padding:8px 8px 8px 14px;border-radius:8px;background:rgba(26,18,6,.95);color:#FFB547;font:13px/1.4 system-ui,sans-serif';
    n.innerHTML = '<span></span><a style="color:#38C6D9;font-weight:700">v2 시뮬 실연결로 열기</a><button aria-label="안내 닫기" style="width:32px;height:32px;border:0;border-radius:6px;background:transparent;color:inherit;font-size:18px;cursor:pointer">×</button>';
    n.firstChild.textContent = text; n.querySelector('a').href = href; n.querySelector('button').onclick = () => n.remove();
    document.body.append(n);
  }

  const TRIAL = 'Gazebo · foothold-v2 시험 · 낙상·정지 지연 미검증';
  // RL 기록(online RESULT 「관찰」·ERRATA): 명령 0 뒤에도 1~2 s 안에 한 번 다시 움직일 수 있음(최대 약 .33 m/s·기울기 28°), 원인 미확인
  const RELURCH = '정지 뒤 1~2 s 안에 한 번 다시 움직일 수 있음(시뮬 기록 최대 약 .33 m/s·28°)';
  const NOMOVE = '후진·제자리 회전·옆걸음·저속은 시뮬에서 검증 안 됨 — 서버가 0으로 막습니다. 시험한 값: 앞 0.6 m/s, 앞+회전 ±0.5 rad/s';
  // 현재 v2 연결에서 안 되는 것(설정·로봇 화면·보고서에 같은 내용). 로봇 고유 한계로 단정하지 않고 미제공·미연결·미검증으로 나눈다.
  const UNSUP = [
    ['자동 목적지 이동·자동 복귀', '미연결 — Nav2 연결 없음, 실행 안 함. 임무는 운영자가 직접 조종하며 남기는 수동 진행 기록'],
    ['SLAM 지도·위치 맞추기', '미연결 — 지도는 시뮬 바닥 도면(±10 m), 위치는 Gazebo 정답 위치(GT)'],
    ['AI 탐지·발견물 판독', '미연결 — 사진은 운영자가 찍어 등록한 관찰'],
    ['뎁스 영상·3D 점군', '미제공 — 현재 v2 연결은 RGB 압축 영상만 보냄'],
    ['가스·측정값·통신 품질', '미제공 — 현재 v2 연결에 해당 값 없음'],
    ['구역 주행 제한(피하기·감속)', '미연결 — 구역은 그리기·저장·공유·표시만, 충돌·감속 보장 없음'],
    ['배터리', '미제공 — v2 시뮬 상태에 값 없음(Go2 배터리 자체가 없다는 뜻 아님)'],
    ['후진·제자리 회전·옆걸음·저속·자세', '미검증 — 시뮬에서 검증 안 됨, 서버가 0으로 막음'],
    ['실기 Go2', '미연결 — 현재 앱은 시뮬 연결만'],
    ['8790 주소로 다른 기기 접속', '8790 은 이 PC 전용(로그인 없음) — 휴대폰·다른 PC 는 보호 주소 https://…:8453 에서 로그인'],
    ['앱 설치 파일(APK·IPA)', '설치 파일 없음 — «홈 화면에 추가»한 웹 앱으로 사용 · 실제 iPhone 확인 전'],
    ['시뮬 끄기·연장', '앱에서 안 함 — 시작 30분 뒤 RL 쪽이 자동 종료, 자동 연장 없음'],
  ];
  const WHY = Object.fromEntries(UNSUP);
  const $ = (sel, r = document) => r.querySelector(sel);
  const $$ = (sel, r = document) => [...r.querySelectorAll(sel)];
  const byText = (sel, t, r = document) => $$(sel, r).find((e) => e.textContent.trim().startsWith(t));
  const ok = (v) => typeof v === 'number' && isFinite(v);
  const num = (v, d = 2, u = '') => (ok(v) ? v.toFixed(d) + u : '미확인');
  const sgn = (v, d = 2, u = '') => (ok(v) ? (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(d) + u : '미확인');
  const deg = (r) => (ok(r) ? (r * 180 / Math.PI).toFixed(0) + '°' : '미확인');
  const hms = (d) => d.toTimeString().slice(0, 8);
  const SRC = { gz_gt: 'Gazebo 정답값(GT)', fake_kinematic: '가짜 발행기(앱 시험용)' };
  const store = {                                                // 브라우저 저장(이 기기만). 막혀 있어도 화면은 돈다.
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (_) { return false; } },
  };

  const GATED = location.protocol === 'https:';                 // 보호 관문으로 연 화면(로그인 세션 있음)
  const PHONE = /iPhone|iPad|Android|Mobile/i.test(navigator.userAgent);
  const STANDALONE = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  let ws, conn = 0, st = null, firstVer = null, rid = 0; const pending = new Map();
  let lastMsg = 0, role = 'view', camURL = null, camFrames = [], sig = null;
  const zones = new Map();                      // 누르는 곳(막대·누름 버튼) → {pid, p}: 곳마다 손가락 하나, 전체 둘
  const keys = new Map();                       // 누르고 있는 화살표 키(Main)
  const intent = { fx: 0, fy: 0, fw: 0 };
  const knobs = [];

  function send(o) { if (ws && ws.readyState === 1) { ws.send(JSON.stringify(o)); return true; } return false; }
  // 응답이 오는 요청(사진·시뮬 시작): 서버가 rid 로 답한다. 5 s 안에 답 없으면 실패로
  function ask(op) {
    return new Promise((res) => {
      const id = ++rid; if (!send({ op, rid: id })) return res({ ok: false, text: '링크 끊김 — 보내지 못함' });
      const t = setTimeout(() => { pending.delete(id); res({ ok: false, text: '서버 응답 없음(5 s)' }); }, 5000);
      pending.set(id, (m) => { clearTimeout(t); res(m); });
    });
  }
  // 모든 누름 폐기: 지금 누르고 있는 손가락·키는 뗄 때까지 죽은 입력. 다시 눌러야 새 입력.
  function dropAll() {
    for (const [g, z] of zones) { g.classList.remove('lv-on'); try { g.releasePointerCapture(z.pid); } catch (_) { /* 이미 놓임 */ } }
    zones.clear(); keys.clear(); merge(); for (const k of knobs) k.style.transform = '';
  }
  function merge() {
    intent.fx = intent.fy = intent.fw = 0;
    for (const p of [...[...zones.values()].map((z) => z.p), ...keys.values()]) { intent.fx += p.fx; intent.fy += p.fy; intent.fw += p.fw; }
  }
  function hide() { dropAll(); send({ op: 'hidden' }); }
  const loginURL = () => `${PHONE ? 'MLogin' : 'PcLogin'}.dc.html?live=v2&next=${encodeURIComponent(location.pathname + location.search)}`;

  function connect() {
    ws = new WebSocket(`${GATED ? 'wss' : 'ws'}://${location.host}/ws`); ws.binaryType = 'blob'; conn += 1;
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') {                 // 카메라 jpeg
        if (camURL) URL.revokeObjectURL(camURL);
        camURL = URL.createObjectURL(e.data); const now = performance.now();
        camFrames = camFrames.filter((t) => now - t < 2000).concat(now);
        for (const img of $$('img[data-live-cam]')) img.src = camURL;
        return;
      }
      const m = JSON.parse(e.data);
      if (m.op === 'reply') { const f = pending.get(m.rid); if (f) { pending.delete(m.rid); f(m); } return; }
      st = m; lastMsg = performance.now(); role = st.role;
      if (firstVer == null) firstVer = st.ver;
      const s2 = [role, st.latch, st.reset_pending, st.resume_pending, st.episode, !!st.sim_block].join('|');
      if (s2 !== sig) { if (sig !== null) dropAll(); sig = s2; }   // 조종권·STOP·리셋·에피소드·시뮬 상태 변화 → 누름 폐기
      try { logServer(); } catch (_) { /* 기록 실패와 무관하게 표시·조종은 계속 */ }
      track(); refreshShared();
      paint();
    };
    ws.onclose = (e) => {
      dropAll(); role = 'view'; sig = null;
      if (e.code === 4401) { toast('로그인이 끝났습니다 — 다시 로그인'); return setTimeout(() => location.assign(loginURL()), 1200); }
      setTimeout(connect, 1000);
    };
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) hide(); });
  addEventListener('pagehide', hide);
  addEventListener('blur', dropAll);
  if (screen.orientation) screen.orientation.addEventListener('change', dropAll);
  document.addEventListener('fullscreenchange', () => { dropAll(); if (!document.fullscreenElement && big === 'fs') bigClose(); });
  setInterval(() => { if (role === 'control') send({ op: 'cmd', ...intent }); }, 50);   // 20 Hz, 손 떼면 0
  setInterval(() => {                                                                   // 링크 끊김: 표시 갱신 + 누름 폐기
    if (lastMsg && performance.now() - lastMsg > 1000) { dropAll(); paint(); }
  }, 500);

  // ---- 공통 UI: 안내 글·이유 버튼·옆 패널 ----
  const css = document.createElement('style');
  css.textContent = `
.lv-why{opacity:.5;cursor:help}
.pill{white-space:nowrap}
.lv-on{outline:3px solid #38C6D9;outline-offset:2px}
.lv-pad{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.lv-pad .btn{user-select:none;-webkit-user-select:none;touch-action:none}
.lv-drawer{position:fixed;z-index:45;display:flex;flex-direction:column;gap:10px;padding:14px;overflow:auto;background:var(--panel,#12171C);color:var(--text,#E6EBEF);border:1px solid var(--line2,#34424D);border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.45);font:13px/1.5 'IBM Plex Sans KR',system-ui,sans-serif}
.lv-drawer h2{font-size:16px;margin:0;flex:1}.lv-drawer h3{font-size:14px;margin:6px 0 0}
.lv-drawer p{margin:0;color:var(--muted,#9AA7B3)}
.lv-drawer button{min-height:44px;padding:0 14px;border:1px solid var(--line2,#34424D);border-radius:8px;background:var(--panel2,#182028);color:inherit;font:600 13px/1 inherit;cursor:pointer}
.lv-drawer dl{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;margin:0}.lv-drawer dt{color:var(--muted,#9AA7B3)}.lv-drawer dd{margin:0;font-family:'JetBrains Mono',monospace;word-break:break-all}
.lv-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.lv-photo{display:grid;grid-template-columns:120px 1fr;gap:8px;align-items:center}.lv-photo img{width:120px;border-radius:6px}
.lv-big{position:fixed!important;inset:0!important;z-index:44!important;border-radius:0!important;aspect-ratio:auto!important}
.lv-big img[data-live-cam],:fullscreen img[data-live-cam]{object-fit:contain!important}
.lv-bigbar{position:absolute;left:10px;right:52px;top:10px;z-index:2;display:none;flex-wrap:wrap;gap:8px;align-items:center;padding:8px;border-radius:8px;background:rgba(5,8,10,.8);color:#E6EBEF;font-size:13px}
.lv-bigbar .btn{height:44px;padding:0 14px;border:1px solid #34424D;border-radius:8px;background:#182028;color:#E6EBEF;font-weight:600}
.lv-bigbar .lv-stop{border:0;background:#D7261E;color:#fff;font-weight:700;letter-spacing:.06em;min-width:96px}
.lv-main{flex:1;min-width:0;display:grid;gap:14px;align-content:start;padding:16px}
.lv-mbody{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:10px;padding:10px 14px}
.lv-card{display:flex;flex-direction:column;gap:8px;min-width:0;padding:14px;border:1px solid var(--line);border-radius:10px;background:var(--panel);color:var(--text)}
.lv-card h2{margin:0;font-size:15px}.lv-card h3,.lv-mbody h3{margin:6px 0 0;font-size:13px}
.lv-col{display:flex;flex-direction:column;gap:8px;min-width:0}
.lv-note{margin:0;font-size:12px;line-height:1.45;color:var(--muted)}
.lv-status{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center;font-size:12px;color:var(--muted)}
.lv-status .lv-btn{min-height:30px;font-size:12px}
.lv-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:40px;padding:0 14px;border:1px solid var(--line2);border-radius:8px;background:var(--panel2);color:var(--text);font-family:inherit;font-size:13px;font-weight:600;text-decoration:none;cursor:pointer}
.lv-btn.pri{border-color:var(--accent);background:var(--accent);color:var(--on-accent,#05080A)}
.lv-btn.danger{border-color:var(--bad);color:var(--bad);background:transparent}
.lv-btn[aria-pressed=true]{border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}
.lv-btn:disabled{opacity:.45;cursor:not-allowed}
.lv-inp{min-height:40px;padding:6px 10px;border:1px solid var(--line2);border-radius:8px;background:var(--bg);color:var(--text);font-family:inherit;font-size:14px;min-width:0}
textarea.lv-inp{resize:vertical}
.lv-item{display:flex;flex-direction:column;gap:4px;width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--panel2);color:var(--text);font-family:inherit;font-size:13px;text-align:left;text-decoration:none;cursor:pointer}
.lv-item[aria-current=true]{border-color:var(--accent)}
.lv-ph{flex-direction:row;align-items:center}.lv-ph img{width:96px;height:64px;object-fit:cover;border-radius:6px;background:#05080A}
.lv-tag{display:inline-flex;align-items:center;min-height:22px;padding:0 8px;border-radius:11px;background:var(--panel2);border:1px solid var(--line2);font-size:12px;font-weight:600}
.lv-tag.ok{color:var(--ok);border-color:var(--ok)}.lv-tag.warn{color:var(--warn);border-color:var(--warn)}.lv-tag.bad{color:var(--bad);border-color:var(--bad)}.lv-tag.acc{color:var(--accent);border-color:var(--accent)}
.lv-warnbox{display:flex;flex-direction:column;gap:8px;padding:10px;border:1px solid var(--warn);border-radius:8px;font-size:13px}
.lv-map{position:relative;overflow:hidden;border-radius:8px;background:var(--map,#0E1317);min-height:120px}
.lv-mapbtns{position:absolute;right:8px;top:8px;z-index:2;display:flex;flex-direction:column;gap:6px}.lv-mapbtns .lv-btn{width:44px;min-height:44px;padding:0;font-size:18px}
.lv-wp{display:grid;grid-template-columns:28px minmax(0,1fr) auto;gap:8px;align-items:start;padding:8px 0;border-top:1px solid var(--line)}
.lv-wp>b{display:grid;place-items:center;width:26px;height:26px;border-radius:13px;border:2px solid var(--accent);font-size:12px}
.lv-thumb{width:72px;height:48px;object-fit:cover;border-radius:6px;background:#05080A}
.lv-grid2{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px}
.lv-g{display:flex;flex-direction:column;gap:2px;padding:8px;border-radius:8px;background:var(--panel2);font-size:13px;min-width:0;overflow-wrap:anywhere}.lv-g.warn b{color:var(--warn)}
.lv-tbl{width:100%;border-collapse:collapse;font-size:13px}.lv-tbl th,.lv-tbl td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}.lv-tbl a{color:var(--accent)}
.lv-dl{display:grid;grid-template-columns:auto 1fr;gap:3px 14px;margin:0;font-size:13px}.lv-dl dt{color:var(--muted)}.lv-dl dd{margin:0;overflow-wrap:anywhere}
.lv-rep{padding:48px 56px;color:#111;font-size:13px;line-height:1.5}.lv-rep h1{font-size:22px;margin:0 0 6px}.lv-rep h2{font-size:16px;margin:22px 0 6px}.lv-rep h3{font-size:14px;margin:12px 0 4px}
.lv-rep table{width:100%;border-collapse:collapse;margin:4px 0}.lv-rep th,.lv-rep td{border:1px solid #bbb;padding:4px 6px;text-align:left;vertical-align:top}
.lv-fstop{position:fixed;right:16px;bottom:16px;z-index:40;min-width:96px;height:56px;border:0;border-radius:10px;background:#D7261E;color:#fff;font-weight:700;letter-spacing:.06em;font-size:16px}
@media (max-width:900px){.lv-main{grid-template-columns:minmax(0,1fr)!important}}
@media print{.lv-noprint{display:none!important}body{background:#fff!important}}`;
  document.head.append(css);

  let toastEl, toastT;
  function toast(t) {
    if (!toastEl) {
      toastEl = document.createElement('div'); toastEl.setAttribute('role', 'status'); toastEl.dataset.liveToast = '1';
      toastEl.style.cssText = 'position:fixed;left:50%;top:96px;transform:translateX(-50%);z-index:50;max-width:90vw;padding:8px 14px;border-radius:8px;background:rgba(8,11,14,.92);color:#E6EBEF;font-size:13px;pointer-events:none';
    }
    (document.fullscreenElement || document.body).append(toastEl);   // 전체화면 안에서도 보이게
    toastEl.textContent = t; toastEl.style.display = 'block'; clearTimeout(toastT); toastT = setTimeout(() => { toastEl.style.display = 'none'; }, 3500);
  }
  // 지원 안 되는 버튼: 막아 두지 않고 누르면 이유를 보여 준다
  function why(el, text) {
    if (!el) return;
    el.disabled = false; el.setAttribute('aria-disabled', 'true'); el.title = text; el.classList.add('lv-why');
    el.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); toast(text); });
  }
  const setDis = (b, off, t) => { b.disabled = off; b.style.opacity = off ? '.45' : ''; if (t != null) b.title = t; };
  function save(name, blob, msg) {   // 내려받기. 실패는 알림(브라우저가 막은 경우 다운로드 목록 확인)
    try {
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000); toast(`${msg || `내려받기 요청: ${name}`} · 안 보이면 브라우저 다운로드 목록·권한 확인`);
    } catch (e) { toast(`내려받기 실패: ${e.message || e}`); }
  }

  let drawer = null;
  function openDrawer(title, build) {
    closeDrawer(); dropAll();
    drawer = document.createElement('div'); drawer.className = 'lv-drawer'; drawer.setAttribute('role', 'dialog'); drawer.setAttribute('aria-label', title);
    // 휴대폰 가로: 왼쪽(오른쪽 위 STOP 가리지 않게) · PC: 머리줄(STOP) 아래 오른쪽
    drawer.style.cssText = D ? 'left:8px;top:8px;bottom:8px;width:min(380px,calc(100vw - 200px))' : 'right:12px;top:84px;bottom:12px;width:min(440px,calc(100vw - 24px))';
    const head = document.createElement('div'); head.className = 'lv-row';
    const h = document.createElement('h2'); h.textContent = title;
    const x = document.createElement('button'); x.textContent = '닫기'; x.setAttribute('aria-label', `${title} 닫기 (Esc)`); x.onclick = closeDrawer;
    head.append(h, x); const body = document.createElement('div'); body.style.cssText = 'display:flex;flex-direction:column;gap:10px';
    drawer.append(head, body); ($('.fh') || document.body).append(drawer);
    drawer.paint = () => build(body); drawer.paint(); x.focus();
  }
  function closeDrawer() { if (drawer) { drawer.remove(); drawer = null; dropAll(); } }
  const show = (e, on) => { if (e.dataset.d == null) e.dataset.d = e.style.display; e.style.display = on ? e.dataset.d : 'none'; };   // 원본 인라인 display(grid·flex) 보존
  const el = (tag, text, attrs = {}) => { const e = document.createElement(tag); if (text != null) e.textContent = text; Object.assign(e, attrs); return e; };

  // ---- 이 브라우저의 실제 기록: 사진(이 탭 메모리)·조종 기록(이 브라우저 저장) — 시안 예시와 섞지 않는다 ----
  // 조종 기록 읽기: 배열·항목 최소 형식이 아니면 «읽기 실패» 안내 후 빈 기록으로 시작. 원래 값은 지우지 않고 다른 키에 새로 쓴다.
  const okRow = (x) => x && typeof x === 'object' && typeof x.t === 'string' && typeof x.kind === 'string' && typeof x.text === 'string';
  function loadLog(k) {
    let raw = null; try { raw = localStorage.getItem(k); } catch (_) { return { rows: [], bad: '브라우저 저장소 접근 막힘' }; }
    if (raw == null) return { rows: [] };
    try { const v = JSON.parse(raw); if (Array.isArray(v) && v.every(okRow)) return { rows: v }; } catch (_) { /* 아래로 */ }
    return { rows: [], bad: '저장된 형식이 맞지 않음' };
  }
  let LOGKEY = 'fh.live.log.v1', logBad = null;
  let { rows: log, bad } = loadLog(LOGKEY);
  if (bad) { logBad = bad; LOGKEY = 'fh.live.log.v1b'; const r2 = loadLog(LOGKEY); log = r2.bad ? [] : r2.rows; if (r2.bad) LOGKEY = null; }
  const seenEv = new Set();
  let quotaWarned = false;
  function note(kind, text, key) {
    try {
      const s = st && st.sim;
      log.push({ t: new Date().toISOString(), kind, text, key, episode: st ? st.episode : null, x: s ? s.x : null, y: s ? s.y : null, yaw: s ? s.yaw : null });
      if (log.length > 2000) log.splice(0, log.length - 2000);          // ponytail: 최근 2000건만. 더 필요하면 내보내기로 보관
      if ((!LOGKEY || !store.set(LOGKEY, log)) && !quotaWarned) { quotaWarned = true; toast('조종 기록을 브라우저에 저장하지 못함(공간·권한) — 이 화면에만 있음, 내보내기로 보관하세요'); }
    } catch (_) { /* 기록 실패가 조종 화면을 멈추게 하지 않는다 */ }
  }
  function logServer() {
    for (const e of (st.events || [])) {
      const k = `${e.t}|${e.text}`; if (seenEv.has(k)) continue; seenEv.add(k);
      if (!log.some((l) => l.key === k)) note('서버', `${e.t} ${e.text}`, k);
    }
  }
  // 사진 = 서버가 받은 최신 프레임을 서버가 그 순간의 GT·에피소드와 함께 저장(화면은 요청만). PC·휴대폰 모두 같은 서버 기록에 남는다.
  async function shoot() {   // → 사진 정보(url 등) | null(이유는 알림)
    const r = await ask('photo');
    if (!r.ok) { toast(r.text); return null; }
    const p = r.photo;
    note('사진', `사진 서버 저장 · 프레임 수신 ${p.frame_at.slice(11, 19)} · ${p.x == null ? '위치 미확인' : `x ${sgn(p.x)} y ${sgn(p.y)} m`} · ${p.url}`);
    loadMedia(); return p;
  }
  async function takePhoto() {
    const p = await shoot(); if (!p) return;
    const pos = p.x == null ? '위치 미확인' : `x ${sgn(p.x)} y ${sgn(p.y)} m · 방향 ${deg(p.yaw)}`;
    if (PHONE) return toast(`사진 서버 저장 · 프레임 수신 ${p.frame_at.slice(11, 19)} · ${pos} · «관찰»에서 분류`);
    const a = el('a', null, { href: p.url, download: p.url.split('/').pop() }); document.body.append(a); a.click(); a.remove();
    toast(`사진 서버 저장 + 내려받기 요청 · 프레임 수신 ${p.frame_at.slice(11, 19)} · ${pos}`);
  }
  function csv() {
    const q = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    return ['t,kind,text,episode,x,y,yaw', ...log.map((l) => [l.t, l.kind, l.text, l.episode, l.x, l.y, l.yaw].map(q).join(','))].join('\n');
  }
  // 기록: 서버 보관(모든 기기 공통 — 사진·사건) + 이 브라우저의 조작 기록. 예시 데이터와 섞지 않는다.
  function openRecords() {
    let srv = null, err = '', seen = '';
    const load = () => fetch('api/media', { cache: 'no-store', credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => { srv = d; err = ''; }).catch((e) => { err = e.message || String(e); }).finally(() => { seen = ''; if (drawer) drawer.paint(); });
    openDrawer('기록 · 실제 시뮬 기록', (b) => {
      const key = `${!!srv}|${err}|${log.length}`; if (key === seen) return; seen = key;
      b.replaceChildren(el('p', '예시 데이터가 아닙니다. 서버 보관 기록은 PC·휴대폰 어느 기기에서 열어도 같습니다.'),
        el('button', '서버 기록 새로 읽기', { onclick: load }));
      if (err) b.append(el('p', `서버 기록 읽기 실패 · ${err}`));
      else if (!srv) b.append(el('p', '서버 기록 읽는 중…'));
      else {
        b.append(el('h3', `사진 ${srv.photos.length}장 · 서버 보관`), el('p', 'Gazebo 렌더(실카메라 아님). 시각 = 서버가 프레임을 받은 시각 · 저장 시각.'));
        for (const p of srv.photos.slice(0, 40)) {
          const r = el('div', null, { className: 'lv-photo' }), cap = el('div');
          cap.append(el('div', `프레임 수신 ${p.frame_at.slice(5, 19).replace('T', ' ')} · episode ${p.episode} · ${p.by || ''}`),
            el('div', p.x == null ? '위치 미확인' : `GT(저장 요청 때 최신 · 프레임 동기 아님) x ${sgn(p.x)} y ${sgn(p.y)} m · ${deg(p.yaw)}`),
            el('a', '원본 내려받기', { href: p.url, download: p.url.split('/').pop(), style: 'color:var(--accent,#38C6D9)' }));
          r.append(el('img', null, { src: p.url, alt: `사진 ${p.frame_at}`, loading: 'lazy' }), cap); b.append(r);
        }
        b.append(el('button', '사진 정보 JSON 내보내기', { onclick: () => save(`foothold-v2-photos-${Date.now()}.json`, new Blob([JSON.stringify(srv.photos, null, 1)], { type: 'application/json' })) }));
        b.append(el('h3', `서버 사건 ${srv.events.length}건(최근 300)`));
        const dl = el('dl'); for (const e of srv.events.slice(0, 80)) dl.append(el('dt', (e.at || '').slice(5, 19).replace('T', ' ')), el('dd', e.text)); b.append(dl);
      }
      b.append(el('h3', `이 브라우저의 조작 기록 ${log.length}건`), el('p', !LOGKEY ? '브라우저에 저장 못 함 — 이 화면에만 있음, 내보내기로 보관하세요.' : `이 기기에만 저장(누른 버튼 등). 최근 2000건.${logBad ? ` 예전 기록 읽기 실패(${logBad}) — 원래 값은 지우지 않고 새 기록으로 시작.` : ''}`));
      const row = el('div', null, { className: 'lv-row' });
      row.append(el('button', 'JSON 내보내기', { onclick: () => save(`foothold-v2-log-${Date.now()}.json`, new Blob([JSON.stringify(log, null, 1)], { type: 'application/json' })) }),
        el('button', 'CSV 내보내기', { onclick: () => save(`foothold-v2-log-${Date.now()}.csv`, new Blob([csv()], { type: 'text/csv' })) }),
        el('button', '기록 지우기', { onclick: () => { if (confirm('이 브라우저의 조작 기록을 지울까요? (서버 기록은 그대로)')) { log.length = 0; if (LOGKEY) store.set(LOGKEY, log); seen = ''; drawer.paint(); } } }));
      b.append(row);
      const dl2 = el('dl'); for (const l of log.slice(-40).reverse()) dl2.append(el('dt', `${l.t.slice(11, 19)} ${l.kind}`), el('dd', l.text)); b.append(dl2);
    });
    load();
  }
  function stateRows() {   // 상태 상세: 서버가 준 원값 그대로(가공·추정 없음)
    const v = view(), r = [['링크', v.linkTxt], ['조종권', v.roleTxt], ['STOP 잠금', v.linkOk ? String(v.latch) : '미확인(링크 끊김)'], ['보낸 명령', v.sent],
      ['서버 이유', (st && st.reason) || '—'], ['state_age s', st ? num(st.state_age, 2) : '미확인'], ['cam_age s', st ? num(st.cam_age, 2) : '미확인'],
      ['episode', st ? String(st.episode) : '미확인'], ['배터리', '미연결(시뮬에 값 없음)'], ['이 기기', (st && st.me) || '미확인'],
      ['조종 중인 기기', (st && st.holder) || '없음'], ['시뮬 세션(RL 상태)', sessTxt() || '미확인'], ['화면 판', `${firstVer || '미확인'} (서버 지금 ${(st && st.ver) || '미확인'})`]];
    for (const [k, x] of Object.entries((st && st.sim) || {})) r.push([`sim.${k}`, typeof x === 'string' ? x : JSON.stringify(x)]);
    return r;
  }
  function rowsInto(dl) { dl.replaceChildren(); for (const [k, x] of stateRows()) dl.append(el('dt', k), el('dd', x)); }
  // 테마: 저장한 값이 있을 때만 바꾼다(없으면 시안 기본 — PC 어두운·휴대폰 밝은). 저장 실패해도 이번 화면은 고른 값으로
  let theme = store.get('fh.live.theme', null);
  function applyTheme() { const fh = $('.fh'); if (fh && (theme === 'light' || theme === 'dark')) fh.classList.toggle('light', theme === 'light'); }
  function settingsInto(b) {
    if (b.firstChild) return;
    const B = (t, fn) => el('button', t, { className: 'lv-btn', type: 'button', onclick: fn });
    if ($('.fh') && !D) {
      const t = B(''); const lab = () => { t.textContent = `테마: ${$('.fh').classList.contains('light') ? '밝은' : '어두운'} (눌러 바꾸기)`; };
      t.onclick = () => { theme = $('.fh').classList.contains('light') ? 'dark' : 'light'; applyTheme(); lab(); toast(store.set('fh.live.theme', theme) ? '테마 저장됨(이 브라우저)' : '테마 저장 실패(브라우저 저장 막힘) — 이번 화면에만 적용'); }; lab(); b.append(t);
    } else b.append(el('p', '가로 조종 화면은 영상 위 표시라 어두운 테마 고정입니다.', { className: 'lv-note' }));
    // 지도 기본 보기: 새 키(fh.live.mapmode). 옛 키 fh.live.follow(false=전체 맞춤)는 읽지 않는다 → 처음엔 누구나 로봇 중심
    const f = B(''); const lab = () => { f.textContent = `지도 기본: ${store.get('fh.live.mapmode', 'robot') === 'all' ? '전체 보기' : '로봇 중심(지도가 움직임)'} (눌러 바꾸기)`; };
    f.onclick = () => { const m = store.get('fh.live.mapmode', 'robot') === 'all' ? 'robot' : 'all'; if (!store.set('fh.live.mapmode', m)) toast('저장 실패 — 이번 화면에만'); for (const V of MAPS) V.setMode(m); lab(); }; lab(); b.append(f);
    if (D) {
      const cur = Q.get('stickLayout') || LAYOUTS[0];
      const lb = B(`막대 배치: ${cur} (눌러 바꾸기 · 화면 다시 열림)`, () => {
        if (role === 'control') return toast('조종 중에는 바꾸지 않습니다 — 조종권 반납 뒤');
        const nx = LAYOUTS[(LAYOUTS.indexOf(cur) + 1) % LAYOUTS.length];
        if (!store.set('fh.live.layout', nx)) toast('저장 실패 — 이번만 적용');
        Q.set('stickLayout', nx); location.replace(`${PAGE}?${Q}`);
      });
      b.append(lb, el('p', '앞뒤 막대: 앞만 움직입니다. 뒤로 당기면 후진 미검증이라 서버가 0으로 막습니다(이유 표시).', { className: 'lv-note' }));
    }
    if (D || M) b.append(B('기록 보기(사진·조종 기록)', openRecords));
    b.append(B('설치·접속 안내(QR·홈 화면 추가)', () => location.assign('start.html')));
    if (GATED) b.append(B(`로그아웃 · ${(st && st.me) || ''}`, async () => {
      dropAll(); send({ op: 'hidden' });                    // 조종권 해제 · 0 · STOP 잠금(서버)
      try { await fetch('api/logout', { method: 'POST', credentials: 'same-origin' }); } catch (_) { /* 아래로 */ }
      location.assign(loginURL());
    }));
    b.append(el('p', `화면 판 ${firstVer || '미확인'} · 서버 판 ${(st && st.ver) || '미확인'}${STANDALONE ? ' · 홈 화면 웹 앱' : ''}`, { className: 'lv-note' }));
    b.append(el('h3', '현재 v2 연결에서 안 되는 것(미제공·미연결·미검증)'));
    const dl = el('dl', null, { className: 'lv-dl' }); for (const [k, x] of UNSUP) dl.append(el('dt', k), el('dd', x)); b.append(dl);
    b.append(el('p', `주의: ${RELURCH} · 원인 미확인`, { className: 'lv-note' }));
  }
  const openSettings = () => openDrawer('설정 · 이 브라우저에 저장', settingsInto);

  // 화면 사이 이동: 실연결 화면은 ?live=v2 유지. System(디자인 체계) 등 나머지 시안 화면은 막고 이유를 보여 준다.
  function guardLinks() {
    for (const a of $$('a[href]')) {
      const page = a.getAttribute('href').split(/[?#]/)[0];
      if (LIVE_PAGES.includes(page)) { const u = new URL(a.getAttribute('href'), location.href); u.searchParams.set('live', 'v2'); a.href = page + u.search + u.hash; continue; }   // ?tmpl= 같은 화면 사이 값은 유지
      if (!page.endsWith('.dc.html')) continue;            // start.html·사진 원본 등은 그대로
      const t = `${page.replace('.dc.html', '')} — 디자인 체계(시안) 화면이라 실연결 없음`;
      a.removeAttribute('href'); a.setAttribute('role', 'button'); a.tabIndex = 0; a.title = t; a.classList.add('lv-why'); a.setAttribute('aria-disabled', 'true');
      const go = (e) => { e.preventDefault(); toast(t); };
      a.addEventListener('click', go); a.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') go(e); });
    }
  }
  // 조종 중 다른 화면으로 가면 서버가 조종권 해제 + STOP 잠금(화면 떠남) → 먼저 묻는다
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a || role !== 'control' || a.target || a.hasAttribute('download')) return;
    const u = new URL(a.href, location.href);
    if (u.origin !== location.origin || !u.pathname.endsWith('.html') || (u.pathname === location.pathname && u.search === location.search)) return;
    dropAll();
    if (!confirm('조종 중입니다. 다른 화면으로 가면 조종권이 반납되고 STOP 이 잠깁니다. 이동할까요?')) e.preventDefault();
  }, true);

  // ---- 공통 표시값 ----
  function view() {
    const linkAge = lastMsg ? (performance.now() - lastMsg) / 1000 : null;
    const linkOk = linkAge != null && linkAge < 1;
    const fresh = linkOk && st && st.sim && st.state_age != null && st.state_age <= 1;
    const s = fresh ? st.sim : null;
    const camOk = linkOk && st && st.cam_age != null && st.cam_age < 2;
    const fl = (v) => (v === true ? 'true' : v === false ? 'false' : '미확인');
    return {
      linkOk, s,
      linkTxt: !linkOk ? (linkAge == null ? '연결 중' : `끊김 ${linkAge.toFixed(0)} s`) : st.sim_block ? st.sim_block : '정상',
      camOk, camTxt: camOk ? `${(camFrames.length / 2).toFixed(0)} fps · ${st.cam_age.toFixed(1)} s` : (s && s.camera === 'off') ? '꺼짐(시뮬)' : '미연결',
      src: s ? (SRC[s.source] || s.source || '출처 미확인') : '—',
      roleTxt: role === 'control' ? '조종권 · 이 기기' : role === 'view_other' ? `다른 기기가 조종 중${st && st.holder ? ` · ${st.holder}` : ''}` : '보기 전용',
      latch: !!(linkOk && st.latch),
      flags: `online_ready=${fl(s && s.online_ready)} · safe_fallback_verified=${fl(s && s.safe_fallback_verified)}`,
      body: !s ? '몸 상태 미연결' : s.fallen === true ? '넘어짐' : s.fallen == null ? '넘어짐 미확인'
        : s.body_still === true ? '몸 정지' : `실측 ${ok(s.vx) && ok(s.vy) ? Math.hypot(s.vx, s.vy).toFixed(2) + ' m/s' : '속도 미확인'}`,
      // 서버가 지금 보내는 명령(누가 조종하든 같은 값). 링크가 끊기면 모름.
      sent: linkOk ? `앞 ${sgn(st.applied[0])} m/s · 회전 ${sgn(st.applied[2])} rad/s` : '미확인',
    };
  }
  // 움직일 수 없는 이유(없으면 ''). 누름 버튼·막대가 같은 말을 한다.
  function blocked() {
    const v = view();
    if (!v.linkOk) return `링크 ${v.linkTxt} — 명령 0`;
    if (st.sim_block) return `${st.sim_block} — 명령 0`;
    if (role === 'view_other') return '다른 기기가 조종 중 — 보기 전용';
    if (role !== 'control') return '먼저 «조종권 받기»';
    if (st.reset_pending) return '시뮬 리셋 처리 중';
    if (st.resume_pending) return 'STOP 해제 확인 대기';
    if (v.latch) return 'STOP 잠금 중 — «STOP 해제» 먼저';
    return '';
  }
  // 시뮬 시작(30분): 사용자가 누를 때만. 서버가 RL 래퍼를 한 번 부른다(쿨다운·중복 거부·자동 연장 없음). 새 시뮬은 STOP 상태로 시작.
  // RL session_status.sh 원값: 실행/켜지는 중/꺼짐 + 남은 시간. 안전 준비 판정 아님
  const sessTxt = () => { const x = st && st.sim_start && st.sim_start.session; if (!x) return '';
    const left = x.remaining_s == null ? '' : ` · 남은 ${Math.max(0, Math.round(x.remaining_s / 60))}분${x.ends_at ? `(종료 ${String(x.ends_at).slice(11, 16)})` : ''}`;
    return ({ running: '실행 중', starting: '켜지는 중', idle: '꺼짐' }[x.result] || x.result) + left; };
  const simOff = () => !!(st && ['시뮬 상태 미수신', '시뮬 상태 끊김'].includes(st.sim_block));
  async function startSim() {
    const ss = st && st.sim_start;
    if (!ss || !ss.ok) return toast(`시뮬 시작 안 됨 · ${(ss && ss.why) || '서버 응답 없음'}`);
    if (!confirm('Gazebo 시뮬을 30분 동안 시작할까요?\n· RL 쪽 기동 횟수를 1회 씁니다\n· STOP 상태로 시작합니다(«STOP 해제» 뒤 조종)\n· 30분 뒤 자동 종료, 연장 없음')) return;
    const r = await ask('sim_start'); toast(r.text); note('조작', `시뮬 시작 요청 · ${r.text}`);
  }
  // 서버의 화면 판이 이 탭을 연 뒤 바뀌었으면(새 판 반영) 알림 — 옛 탭으로 계속 쓰는 실수 방지
  const newVer = () => !!(st && firstVer && st.ver && st.ver !== firstVer);
  function reloadNow() { if (role === 'control') return toast('조종 중에는 새로고침하지 않습니다 — 조종권 반납 뒤'); location.reload(); }
  function stopNow() { dropAll(); send({ op: 'stop' }); note('조작', 'STOP'); }
  function resumeNow() { dropAll(); send({ op: 'resume' }); note('조작', 'STOP 해제 요청'); }
  function resetNow() { dropAll(); send({ op: 'reset' }); note('조작', '시뮬 리셋 요청'); }
  function takeCtl() { dropAll(); send({ op: 'take' }); note('조작', '조종권 받기'); }
  function giveCtl() { dropAll(); send({ op: 'release' }); note('조작', '조종권 반납'); }
  function stopBtn(b) { b.addEventListener('pointerdown', stopNow); b.addEventListener('keydown', (e) => { if (e.key === 'Enter') stopNow(); }); }
  // 글자 입력 중(입력칸·여러 줄·고르기·편집 가능 영역·한글 조합 중)인 키는 조종·STOP 단축키로 쓰지 않는다. STOP 버튼은 언제나 동작.
  const typing = (e) => { const t = e.target; return !!(e.isComposing || e.keyCode === 229 || (t && t.nodeType === 1 && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))); };
  document.addEventListener('focusin', (e) => { if (typing(e)) dropAll(); });   // 입력칸으로 들어가면 누르고 있던 조종부터 폐기
  let keysWired = false;
  function wireStop() {   // 화면의 STOP 버튼 전부(다시 그린 뒤 새 버튼 포함) + Space 단축키(한 번만)
    for (const x of $$('button[aria-label="비상 정지"]')) if (!x.dataset.lvStop) { x.dataset.lvStop = '1'; stopBtn(x); }
    if (keysWired) return; keysWired = true;
    addEventListener('keydown', (e) => {
      if (typing(e)) return;
      if (e.code === 'Space') { e.preventDefault(); stopNow(); }
      else if (e.key === 'Escape') { if (big) bigClose(); else closeDrawer(); }
    });
  }
  // 누르는 동안만 보내는 버튼(PC). 막대와 같은 규칙: 곳마다 포인터 하나, 둘 넘거나 취소·포착 잃음 → 모두 폐기.
  function holdBtn(label, p, title) {
    const b = el('button', label, { className: 'btn', title }); b.dataset.liveHold = JSON.stringify(p); b.dataset.base = title;
    b.addEventListener('contextmenu', (e) => e.preventDefault());
    b.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (zones.has(b) || zones.size >= 2) { dropAll(); return; }
      const no = blocked(); if (no) { toast(no); return; }
      zones.set(b, { pid: e.pointerId, p: { fx: 0, fy: 0, fw: 0, ...p } }); b.setPointerCapture(e.pointerId); b.classList.add('lv-on'); merge();
      note('조종', `${label} 누름`);
    });
    b.addEventListener('pointerup', (e) => { const z = zones.get(b); if (z && z.pid === e.pointerId) { zones.delete(b); b.classList.remove('lv-on'); merge(); } });
    const bad = (e) => { const z = zones.get(b); if (z && z.pid === e.pointerId) dropAll(); };
    b.addEventListener('pointercancel', bad); b.addEventListener('lostpointercapture', bad);
    return b;
  }
  function pad() {
    const r = el('div', null, { className: 'lv-pad' }); r.setAttribute('role', 'group'); r.setAttribute('aria-label', '누르는 동안 이동');
    r.append(holdBtn('◀ 왼쪽 아크', { fx: 1, fw: 1 }, '누르는 동안 앞 0.6 m/s + 왼쪽 회전 0.5 rad/s'),
      holdBtn('▲ 앞 0.6', { fx: 1 }, '누르는 동안 앞 0.6 m/s · 떼면 0'),
      holdBtn('오른쪽 아크 ▶', { fx: 1, fw: -1 }, '누르는 동안 앞 0.6 m/s + 오른쪽 회전 0.5 rad/s'));
    const n = el('button', '후진·제자리 회전 ⓘ', { className: 'btn' }); why(n, NOMOVE); r.append(n);
    return r;
  }
  function camInto(fakeSvg) {
    fakeSvg.style.visibility = 'hidden';
    const img = document.createElement('img'); img.dataset.liveCam = '1'; img.alt = 'Gazebo 렌더 카메라';
    img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover';
    const msg = document.createElement('div'); msg.dataset.liveCamMsg = '1';
    msg.style.cssText = 'position:absolute;inset:0;display:grid;place-items:center;color:#9AA7B2;font-size:14px;pointer-events:none';
    fakeSvg.after(img, msg);
  }
  function paintCam(v) {
    for (const img of $$('img[data-live-cam]')) img.style.visibility = v.camOk ? 'visible' : 'hidden';
    for (const m of $$('[data-live-cam-msg]')) m.textContent = v.camOk ? '' : `카메라 ${v.camTxt}`;
  }

  // ---- 휴대폰 가로 조종 MDrive ----
  function setupDrive() {
    camInto($('svg[aria-label^="전방 카메라 영상 자리"]'));
    const mini = $('a[aria-label="큰 지도 열기"]'); mini.querySelector('svg').style.visibility = 'hidden';
    mapView(mini, { small: true, name: 'drive' });          // 작은 지도: 로봇 중심(지도가 움직임), 누르면 큰 지도(MMap)
    const mm = document.createElement('div');
    mm.style.cssText = 'position:absolute;left:0;right:0;bottom:0;padding:2px 6px;font-size:10px;line-height:1.4;color:#E6EBEF;background:rgba(14,19,23,.78);pointer-events:none';
    mini.append(mm);
    const huds = $$('.hud'); const row = huds[0].parentElement;
    const add = () => { const h = document.createElement('span'); h.className = 'hud'; row.append(h); return h; };
    huds.push(add(), add());
    const banner = byText('div', '▲ 앞 장애물');
    Object.assign(banner.style, { height: 'auto', minHeight: '30px', flexWrap: 'wrap', justifyContent: 'center', maxWidth: '420px', padding: '4px 12px' });
    const radios = $$('[role="radiogroup"][aria-label="속도"] button');      // 시험한 속도는 0.6(보통)뿐
    const sty = radios.map((b) => b.getAttribute('style'));
    radios[0].setAttribute('style', sty[1]); radios[1].setAttribute('style', sty[0]);
    radios[0].setAttribute('aria-checked', 'false'); radios[1].setAttribute('aria-checked', 'true');
    why(radios[0], '저속 미검증 — 시험한 속도는 0.6 m/s 뿐'); radios[1].title = '앞 0.6 m/s (시험한 값)';
    why(byText('button.pill', '자세'), `자세 — ${WHY['후진·제자리 회전·옆걸음·저속·자세']}`);
    const back = byText('a.pill', '임무로 돌아가기'); back.textContent = '현황'; back.setAttribute('href', 'MHome.dc.html');
    const bar = back.parentElement;
    const give = el('button', '조종권 반납', { className: 'pill' }); give.onclick = giveCtl; bar.append(give);
    // 전체화면·안내는 STOP 아래 작은 버튼(아래 줄은 막대 사이라 자리가 없음)
    const side = el('div'); side.style.cssText = 'position:absolute;right:44px;top:86px;display:flex;gap:8px;z-index:3';
    const sq = (txt, label, fn) => { const b = el('button', txt, { className: 'pill', title: label, onclick: fn }); b.setAttribute('aria-label', label); b.style.cssText = 'width:44px;padding:0;justify-content:center;font-size:18px'; return b; };
    const fs = sq('⛶', '전체화면', fsToggle), rec = sq('ⓘ', '안내·설정', openSettings), cam = sq('📷', '사진 찍기', takePhoto);   // 사진은 서버 저장(PC 와 공유)
    side.append(fs, cam, rec); $('button[aria-label="비상 정지"]').after(side);
    for (const g of $$('.glass[role="group"]')) {
      stick(g);
      const lab = g.nextElementSibling, k = g.getAttribute('aria-label');
      if (lab && !k.startsWith('회전')) { lab.textContent += ' · 뒤✕'; lab.title = '뒤로 당기면 후진 미검증이라 서버가 0으로 막음(이유 표시)'; }
    }
    fitPhone();
    wireStop();
    return { huds, banner, mm, give, fs, take: bigBtn('조종권 받기', takeCtl), resume: bigBtn('STOP 해제', resumeNow), reset: bigBtn('시뮬 리셋', resetNow),
      start: bigBtn('시뮬 시작(30분)', startSim), reload: bigBtn('새로고침', reloadNow) };
  }
  // 휴대폰 가로 화면 맞춤: 시안(844×390)의 배치를 그대로 두고 지금 화면(안전 영역 안)에 맞춘다.
  // 높이가 390 보다 낮으면(주소창 있는 가로 등) 비율 그대로 줄이고, 넓으면 가로로 늘린다. 확대(핀치)는 막지 않는다.
  function fitPhone() {
    const root = $('div[style*="width:844px"]'); if (!root) return;
    const probe = el('div'); probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
    const tip = el('div', '가로로 돌려 쓰세요 · 세로에서는 작게 보입니다'); tip.setAttribute('role', 'note');
    tip.style.cssText = 'position:fixed;left:50%;bottom:8px;transform:translateX(-50%);z-index:60;padding:6px 12px;border-radius:8px;background:rgba(26,18,6,.92);color:#FFB547;font:600 13px/1.4 system-ui,sans-serif;pointer-events:none';
    document.body.append(probe, tip); document.body.style.background = '#05080A';
    const fit = () => {
      const cs = getComputedStyle(probe), px = (k) => parseFloat(cs[k]) || 0;
      const l = px('paddingLeft'), t = px('paddingTop'), W = innerWidth - l - px('paddingRight'), H = innerHeight - t - px('paddingBottom');
      const k = Math.min(1, H / 390, W / 700);
      Object.assign(root.style, { position: 'fixed', left: `${l}px`, top: `${t}px`, width: `${W / k}px`, height: `${H / k}px`, transform: k < 1 ? `scale(${k})` : '', transformOrigin: '0 0' });
      root.dataset.liveFit = `${Math.round(W)}x${Math.round(H)}@${k.toFixed(2)}`;   // 시험·확인용
      tip.style.display = innerHeight > innerWidth ? 'block' : 'none';
    };
    addEventListener('resize', fit); if (window.visualViewport) visualViewport.addEventListener('resize', fit); fit();
    // 첫 배치 때는 844 px 원본이 넘쳐 브라우저가 화면 폭을 넓게 잡는다(세로에서 844 로 잼). 고정 배치 뒤 다음 프레임에 다시 잰다
    requestAnimationFrame(() => requestAnimationFrame(fit));
  }
  async function fsToggle() {   // 화면 전체(STOP·막대 포함)를 전체화면으로. 기능을 확인해 되는 방법을 쓰고, 안 되면 대안을 알린다.
    dropAll();
    const de = document.documentElement, req = de.requestFullscreen || de.webkitRequestFullscreen;
    try {
      if (document.fullscreenElement || document.webkitFullscreenElement) await (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      else if (req && (document.fullscreenEnabled || document.webkitFullscreenEnabled)) {
        await req.call(de);
        try { await screen.orientation.lock('landscape'); } catch (_) { /* 방향 고정 미지원: 그대로 */ }
      } else if (STANDALONE) toast('이미 홈 화면 웹 앱(주소창 없음)으로 열려 있습니다');
      else toast('이 브라우저는 화면 전체화면을 지원하지 않습니다 · ⓘ → «설치·접속 안내»에서 홈 화면에 추가하면 주소창 없이 열립니다');
    } catch (e) { toast(`전체화면이 막힘(${e.message || e}) · 홈 화면에 추가하면 주소창 없이 열립니다`); }
  }
  function stick(g) {
    const kind = g.getAttribute('aria-label'), knob = g.querySelector(':scope > span'); knobs.push(knob);
    const axes = kind.startsWith('이동') ? ['fx', 'fy'] : kind.startsWith('앞뒤') ? ['fx', null] : [null, 'fw'];
    g.style.touchAction = 'none';
    const upd = (e) => {
      const r = g.getBoundingClientRect(), R = Math.min(r.width, r.height) / 2 - 8;
      let dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
      if (!axes[0]) dy = 0;
      if (axes[0] && !axes[1]) dx = 0;
      const L = Math.hypot(dx, dy), k = L > R ? R / L : 1; dx *= k; dy *= k;
      knob.style.transform = `translate(${dx}px,${dy}px)`;
      const p = { fx: 0, fy: 0, fw: 0 };
      if (axes[0]) p.fx = -dy / R;
      if (axes[1] === 'fy') p.fy = -dx / R;
      if (axes[1] === 'fw') p.fw = -dx / R;
      zones.get(g).p = p; merge();
    };
    g.addEventListener('pointerdown', (e) => {
      if (zones.has(g) || zones.size >= 2) { dropAll(); return; }   // 같은 막대 두 번째 손가락·세 번째 손가락 → 0, 모두 폐기
      if (role !== 'control') { if (role === 'view') takeCtl(); else toast(blocked()); return; }   // 첫 누름은 조종권만 — 손 떼고 다시 눌러야 움직임
      zones.set(g, { pid: e.pointerId, p: { fx: 0, fy: 0, fw: 0 } }); g.setPointerCapture(e.pointerId); upd(e);
    });
    g.addEventListener('pointermove', (e) => { const z = zones.get(g); if (z && z.pid === e.pointerId) upd(e); });
    g.addEventListener('pointerup', (e) => {                          // 정상 손 뗌: 이 막대만 0
      const z = zones.get(g); if (z && z.pid === e.pointerId) { zones.delete(g); knob.style.transform = ''; merge(); }
    });
    const bad = (e) => { const z = zones.get(g); if (z && z.pid === e.pointerId) dropAll(); };   // 취소·포착 잃음 → 모두 폐기
    g.addEventListener('pointercancel', bad); g.addEventListener('lostpointercapture', bad);
  }
  function bigBtn(t, fn) {
    const x = document.createElement('button'); x.textContent = t;
    x.style.cssText = 'height:44px;min-width:88px;padding:0 14px;border:0;border-radius:22px;background:#1A1206;color:#FFB547;font-size:13px;font-weight:700';
    x.addEventListener('click', fn); return x;
  }
  function paintDrive(D) {
    const v = view(), s = v.s, [mode, link, cam, bat, trial, body] = D.huds;
    mode.lastChild.textContent = role === 'control' ? '직접 조종 · 시뮬 시험' : v.roleTxt;
    const dot = (h, good) => { h.firstElementChild.style.color = good ? '#5AA9FF' : '#FFB547'; };
    link.childNodes[1].textContent = '링크 '; link.lastChild.textContent = v.linkTxt; dot(link, v.linkOk && !st.sim_block);
    cam.lastChild.textContent = v.camTxt; dot(cam, v.camOk);
    bat.lastChild.textContent = '배터리 미연결'; bat.lastChild.classList.remove('mono'); dot(bat, false);
    trial.textContent = TRIAL; trial.title = `${v.flags}\n${RELURCH}`;   // 원문 플래그는 길어서 상세(툴팁)로
    body.textContent = s ? `${v.body} · 기울기 ${num(s.tilt_deg, 0, '°')}` : v.body;
    D.mm.textContent = s ? `GT x ${sgn(s.x, 1)} y ${sgn(s.y, 1)} · ${deg(s.yaw)}` : TRAIL.last ? 'GT 위치 오래됨' : 'GT 위치 없음';
    // 가운데 알림: 끊김·STOP·리셋·넘어짐·미검증 입력 — 없으면 숨김
    const msgs = [];
    if (newVer()) msgs.push(`새 화면 판(${st.ver})이 반영됨 · 이 화면은 ${firstVer} — 조종 없을 때 새로고침`);
    if (!v.linkOk) msgs.push(`링크 ${v.linkTxt} · 명령 0`);
    else {
      if (st.sim_block) msgs.push(`${st.sim_block} · 명령 0`);
      if (st.reset_pending) msgs.push('시뮬 리셋 처리 중 · STOP 유지');
      else if (st.resume_pending) msgs.push('STOP 해제 확인 대기 · 명령 0');
      else if (v.latch) msgs.push(`STOP 요청 · 명령 0 잠금 · ${v.body} · ${RELURCH}`);
      if (s && s.fallen === true) msgs.push('넘어짐 · 시뮬 리셋 필요');
      if (st.reason && !v.latch && !st.sim_block && st.reason !== '조종권 없음') msgs.push(st.reason);
      if (role !== 'control') msgs.push(role === 'view_other' ? '다른 기기가 조종 중 · 보기 전용' : '«조종권 받기»(또는 막대 한 번) 뒤 STOP 해제 → 다시 누르면 움직임');
    }
    paintCam(v);
    const b = D.banner; b.textContent = '';
    b.style.display = msgs.length ? 'flex' : 'none';
    b.append(msgs.join(' · '));
    if (newVer()) b.append(D.reload);
    if (v.linkOk && simOff() && st.sim_start) { b.append(D.start); D.start.title = st.sim_start.why || '30분 시뮬 시작(STOP 상태로)'; D.start.style.opacity = st.sim_start.ok ? '' : '.55'; }
    if (v.linkOk && role === 'view' && !st.sim_block) b.append(D.take);
    const can = v.linkOk && role === 'control' && !st.reset_pending && !st.resume_pending;
    if (can && v.latch) b.append(D.resume);
    if (can && (v.latch || (s && s.fallen === true))) b.append(D.reset);
    D.give.style.display = role === 'control' ? '' : 'none';
    D.fs.setAttribute('aria-label', document.fullscreenElement ? '전체화면 닫기' : '전체화면'); D.fs.title = D.fs.getAttribute('aria-label');
  }

  // ---- PC 관제 Main ----
  function setupMain() {
    applyTheme();
    const H = $('header');
    const lines = $$(':scope > div', H).find((d) => d.children.length === 2 && [...d.children].every((c) => c.tagName === 'SPAN'));
    const [siteLine, stepTitle] = lines.children;
    const modeEl = $(':scope > span', H);
    const opRole = byText('span', '조종권 · 이 기기', H);
    const map = $('section[aria-label="지도와 임무 단계"]');
    const mapSvg = $(':scope > div > svg', map);
    mapSvg.style.visibility = 'hidden';                     // 시안 그림 자리(크기)만 쓰고 그 위에 공용 지도를 그린다
    const V = mapView(mapSvg.parentElement, { name: 'main' });
    const mapTitle = byText('span', 'B1 · 저장 지도', map);
    // 지도 버튼: 로봇 중심/전체·확대·축소·경로·구역은 공용 지도에 연결, 나머지 레이어는 이유 안내
    const [fol, zin, zout] = $$('button.ibtn', map);
    const layers = $$('button.layer', map), trailBtn = layers[0];
    for (const n of $$('button.layer .mono', map)) n.textContent = '—';   // 시안 예시 개수(발견물 2) → 미연결
    let zoneBtn = null;
    for (const b of layers.slice(1)) {
      const name = b.firstChild.textContent.trim();
      b.setAttribute('aria-pressed', 'false');
      if (name === '금지 구역') { zoneBtn = b; b.title = '구역 표시 켜기/끄기(표시만 · 주행 제한 미연결)'; continue; }
      why(b, `${name} — ${name === '3D 점군' ? WHY['뎁스 영상·3D 점군'] : name === '발견물' ? WHY['AI 탐지·발견물 판독'] : WHY['가스·측정값·통신 품질']}`);
    }
    trailBtn.title = 'Gazebo GT 지나온 길 보이기/숨기기';
    fol.title = '로봇 중심(지도가 따라 움직임) ↔ 전체 보기'; zin.title = '확대'; zout.title = '축소';
    const legend = byText('div', '지나온 경로', map); if (legend) legend.style.visibility = 'hidden';
    const stepHead = byText('span', '경과', map); const stepList = $('.step', map)?.parentElement;
    const stepP = stepList ? lift($$('.step', stepList)) : null;   // 원본 «임무 단계» 칸 = 수동 진행 지점 목록(본 하나 떠 두고 실데이터로 채움)
    // 상태 상세(서버 원값)는 임무 단계 칸 아래 접힘으로
    const det = el('details'); det.style.cssText = 'padding:4px 2px;font-size:13px';
    const sum = el('summary', '상태 상세 · 서버 원값 펼치기'); sum.style.cssText = 'cursor:pointer;min-height:32px;color:var(--accent)';
    const dl = el('dl'); dl.style.cssText = 'display:grid;grid-template-columns:auto 1fr;gap:2px 14px;margin:8px 0 0';
    det.append(sum, dl);
    if (stepList) stepList.after(det);
    const vsec = $('section[aria-label="영상과 측정"]');
    const vsvg = $('svg', vsec), box = vsvg.parentElement; box.style.position = 'relative'; camInto(vsvg);
    const vlabel = byText('span', '전방 RGB', vsec); const rec = byText('div', '기록 중', vsec); if (rec) rec.style.visibility = 'hidden';
    const front = byText('button', '전방', vsec); front.setAttribute('aria-pressed', 'true'); front.title = '전방 카메라(Gazebo 렌더) — 유일한 영상';
    front.addEventListener('click', () => toast('전방 카메라(Gazebo 렌더, 실카메라 아님)가 유일한 영상입니다'));
    why(byText('button', '뎁스', vsec), `뎁스 — ${WHY['뎁스 영상·3D 점군']}`);
    const shot = byText('button', '사진 찍기', vsec); shot.title = '지금 영상 프레임을 사진으로(촬영 시각·GT 위치 기록)'; shot.addEventListener('click', takePhoto);
    const bigB = $('button[aria-label="영상 크게 보기"]', vsec); bigB.title = '영상 크게 보기(STOP·조작 포함) · Esc 로 닫기';
    bigB.addEventListener('click', () => (big ? bigClose() : bigOpen()));
    // 확대 중에도 STOP·상태·조작이 보이도록 영상 상자 안에 둔다(전체화면은 이 상자에 건다)
    const bar0 = el('div', null, { className: 'lv-bigbar' }); bar0.dataset.liveBigbar = '1';
    const bStop = el('button', 'STOP', { className: 'btn lv-stop' }); bStop.setAttribute('aria-label', '비상 정지(확대 화면)'); stopBtn(bStop);
    const bRes = el('button', 'STOP 해제', { className: 'btn' }); bRes.onclick = resumeNow;
    const bSt = el('span'); const bClose = el('button', '닫기 (Esc)', { className: 'btn' }); bClose.onclick = bigClose;
    bar0.append(bStop, bRes, pad(), bSt, bClose); box.append(bar0);
    const bar = byText('button.btn', '일시정지', vsec).parentElement, [b1, b2, b3] = $$('button.btn', bar);
    const motion = $(':scope > span', bar);
    // 원본 «이 지점에서 할 일» 칸 = 지금 지점의 수동 기록(방문·사진·운영자 판단·끝내기). AI 탐지·가스 칸은 기본 양식 화면에 없음(미연결)
    const askH = byText('span', '이 지점에서 할 일', vsec), ask = askH && askH.parentElement.parentElement;
    const [askHead, askGrid, askTiles, askLbl] = kids(ask), g0 = kids(askGrid);
    const A = ask && { ask, title: askHead.children[0], sub: askHead.children[1], grid: askGrid, tiles: askTiles, lbl: askLbl,
      done: g0[0].cloneNode(true), wait: g0[6].cloneNode(true), txt: g0[1].cloneNode(true), time: g0[2].cloneNode(true), tile: lift(kids(askTiles)), acts: el('div'), key: '' };
    if (A) { A.acts.style.cssText = 'display:flex;flex-direction:column;gap:6px'; askLbl.after(A.acts); }
    const evBox = byText('span', '사건 기록', vsec).parentElement.parentElement;
    b1.lastChild.textContent = 'STOP 해제'; b1.addEventListener('click', resumeNow);
    b2.addEventListener('click', () => (role === 'control' ? giveCtl() : takeCtl()));
    b3.lastChild.textContent = '시뮬 리셋'; b3.addEventListener('click', resetNow);
    const drive = pad(); bar.after(drive);
    const ex = el('div', null, { className: 'lv-row' }); ex.dataset.liveExtra = '1';
    const bStart = el('button', '시뮬 시작(30분)', { className: 'btn', onclick: startSim }), bReload = el('button', '새로고침(새 판)', { className: 'btn', onclick: reloadNow });
    const exTxt = el('span'); exTxt.style.cssText = 'font-size:12px;color:var(--muted,#9AA7B3)'; ex.append(bStart, bReload, exTxt); drive.after(ex);
    const K = { ArrowUp: ['fx', 1], ArrowDown: ['fx', -1], ArrowLeft: ['fw', 1], ArrowRight: ['fw', -1] };
    addEventListener('keydown', (e) => {
      const k = K[e.key]; if (!k || drawer || typing(e)) return; e.preventDefault();
      if (e.repeat || role !== 'control') return;          // 키보드 조종은 «조종권 받기» 뒤 새로 누른 키만
      keys.set(e.key, { fx: 0, fy: 0, fw: 0, [k[0]]: k[1] }); merge();
    });
    addEventListener('keyup', (e) => { if (keys.delete(e.key)) merge(); });
    wireStop();
    const runA = el('a', '', { href: 'PcPlan.dc.html?live=v2' }); runA.style.cssText = 'color:var(--accent);font-size:13px;padding:4px 2px';
    det.before(runA);
    const M = { siteLine, stepTitle, modeEl, opRole, V, mapTitle, stepHead, stepList, stepP, A, runA, vlabel, b1, b2, b3, motion, evBox, det, dl, box, bRes, bSt, drive, ex, bStart, bReload, exTxt, chips: $$('.chip', H) };
    const pressed = () => { trailBtn.setAttribute('aria-pressed', String(V.showTrail)); if (zoneBtn) zoneBtn.setAttribute('aria-pressed', String(V.showZones)); };
    V.btn.robot = fol;                                      // 눌림 표시 = 로봇 중심일 때(지도가 그릴 때 맞춤)
    fol.addEventListener('click', () => V.setMode(V.mode === 'robot' ? 'all' : 'robot'));
    zin.addEventListener('click', () => V.zoomBy(1.5));
    zout.addEventListener('click', () => V.zoomBy(1 / 1.5));
    trailBtn.addEventListener('click', () => { V.showTrail = !V.showTrail; pressed(); V.draw(); });
    if (zoneBtn) zoneBtn.addEventListener('click', () => { V.showZones = !V.showZones; pressed(); V.draw(); });
    pressed();
    return M;
  }
  let big = null;   // null | 'fs'(브라우저 전체화면) | 'page'(화면 안 확대)
  async function bigOpen() {
    dropAll(); big = 'page'; M.box.classList.add('lv-big'); $('[data-live-bigbar]').style.display = 'flex';
    try {
      if (!M.box.requestFullscreen) throw new Error('지원 안 함');
      await M.box.requestFullscreen(); big = 'fs'; M.box.classList.remove('lv-big');
    } catch (e) { toast(`브라우저 전체화면이 막혀 화면 안에서 크게 봅니다(${e.message || e}) · Esc 로 닫기`); }
    note('화면', '영상 크게 보기'); paint();
  }
  function bigClose() {
    if (!big) return;
    dropAll(); const was = big; big = null;
    M.box.classList.remove('lv-big'); $('[data-live-bigbar]').style.display = 'none';
    if (was === 'fs' && document.fullscreenElement) document.exitFullscreen().catch(() => {});
    paint();
  }
  function chip(c, k, v, good) {
    c.className = 'chip ' + (good ? 'ok' : 'warn');
    c.querySelector('.mk').textContent = good ? '●' : '▲'; c.children[1].textContent = k; c.children[2].textContent = v;
  }
  function paintMain(M) {
    const v = view(), s = v.s;
    M.siteLine.textContent = `${TRIAL} · 판 ${firstVer || '—'}`;
    const showStart = v.linkOk && simOff() && !!st.sim_start;
    M.bStart.style.display = showStart ? '' : 'none'; if (showStart) { M.bStart.title = st.sim_start.why || '30분 시뮬 시작(STOP 상태로)'; M.bStart.style.opacity = st.sim_start.ok ? '' : '.55'; }
    M.bReload.style.display = newVer() ? '' : 'none';
    M.exTxt.textContent = [showStart ? `시뮬 꺼짐${st.sim_start.why ? ` · ${st.sim_start.why}` : ''}` : (sessTxt() ? `시뮬 세션 ${sessTxt()}` : ''), newVer() ? `새 화면 판 ${st.ver} 반영됨(이 화면 ${firstVer})` : ''].filter(Boolean).join(' · ');
    M.ex.style.display = showStart || newVer() || sessTxt() ? '' : 'none';
    const run = activeRun(), vis = run ? run.doc.wps.filter((w) => w.st === '방문').length : 0;
    M.stepTitle.textContent = run ? `수동 임무 «${run.doc.name}» · 방문 ${vis}/${run.doc.wps.length}` : '직접 조종 · 진행 중 수동 임무 없음'; M.stepTitle.title = v.flags;   // 원문 플래그는 툴팁으로
    M.V.wps = run ? run.doc.wps : null;
    M.runA.textContent = run ? `계획 보기 · «${run.doc.name}»(임무 계획)` : '임무 계획 열기 — 계획을 고르고 «수동 진행 시작»';
    M.runA.href = run && run.doc.mission ? `PcPlan.dc.html?live=v2&mission=${encodeURIComponent(run.doc.mission)}` : 'PcPlan.dc.html?live=v2';
    paintRun(M, run);
    M.modeEl.textContent = !v.linkOk ? '링크 끊김' : st.reset_pending ? '리셋 중' : st.resume_pending ? 'STOP 해제 대기' : v.latch ? 'STOP 요청' : role === 'control' ? '직접 조종' : '보기 전용';
    if (M.opRole) M.opRole.textContent = v.roleTxt;
    chip(M.chips[0], '링크', v.linkTxt, v.linkOk && !st.sim_block);
    chip(M.chips[1], '위치', s ? (s.source === 'gz_gt' ? 'Gazebo GT' : v.src) : '미연결', !!s);
    chip(M.chips[2], '영상', v.camTxt, v.camOk);
    chip(M.chips[3], '배터리', '미연결', false);
    M.mapTitle.textContent = s ? `지도·SLAM 아님 · 선은 ${v.src} 위치 · x ${sgn(s.x)} y ${sgn(s.y)} m` : '지도·SLAM 아님 · 위치 미연결';
    if (M.stepHead) { const R = run && run.doc, ci = R ? curWp(R) : -1, d = ci >= 0 ? robotDist(R.wps[ci].x, R.wps[ci].y) : null;
      M.stepHead.textContent = R ? `경과 ${durTxt(R.started)} · 방문 ${vis}/${R.wps.length} · ${ci < 0 ? '모든 지점 기록됨' : `다음 지점 직선 ${d == null ? '미확인' : `${d.toFixed(1)} m`}`} · 자동 이동 미연결` : '진행 중 수동 임무 없음'; }
    M.vlabel.textContent = v.camOk ? `Gazebo 렌더 카메라(실카메라 아님) · ${v.camTxt}` : `카메라 ${v.camTxt}`;
    paintCam(v);
    const ctl = v.linkOk && role === 'control', busy = v.linkOk && (st.reset_pending || st.resume_pending);
    setDis(M.b1, !(ctl && v.latch && !busy)); setDis(M.bRes, !(ctl && v.latch && !busy));
    M.b2.lastChild.textContent = role === 'control' ? '조종권 반납' : '조종권 받기';
    setDis(M.b2, !v.linkOk || role === 'view_other', role === 'view_other' ? '다른 기기가 조종 중' : '');
    setDis(M.b3, !(ctl && !busy));
    const no = blocked();   // 누름 버튼은 누르면 이유가 보이도록 막지 않고 흐리게만
    for (const b of $$('[data-live-hold]')) { b.style.opacity = no ? '.5' : ''; b.title = no || b.dataset.base; }
    // 보낸 명령(서버 출력, 누구에게나 같은 값)과 시뮬 실측을 따로 적는다
    M.motion.textContent = `보낸 명령 ${v.sent} · 시뮬 ${v.body}` + (s ? ` · 기울기 ${num(s.tilt_deg, 0, '°')}` : '')
      + (v.linkOk && st.reason && st.reason !== '조종권 없음' ? ` · ${st.reason}` : '') + (no ? ` · 이동하려면: ${no}` : ' · 버튼을 누르는 동안 이동(↑·←/→ 키도)')
      + ` · 주의: ${RELURCH}`;
    M.bSt.textContent = `${M.modeEl.textContent} · ${v.roleTxt} · 보낸 명령 ${v.sent} · ${v.body}`;
    for (const e of $$('.ev', M.evBox)) e.remove();
    for (const e of (st ? st.events : []).slice(0, 5)) {
      const r = document.createElement('div'); r.className = 'ev';
      r.innerHTML = '<span class="mono"></span><span class="em"></span><span></span>';
      r.children[0].textContent = e.t; r.children[1].className = 'em ' + e.st; r.children[1].textContent = { ok: '●', warn: '▲', bad: '■' }[e.st] || '·';
      r.children[2].textContent = e.text; M.evBox.append(r);
    }
    if (M.det.open) rowsInto(M.dl);
  }

  // 관제: 원본 «임무 단계»·«이 지점에서 할 일» 칸에 수동 진행 기록(운영자가 눌러 기록 · 로봇 자동 완료 아님)
  function paintRun(M, run) {
    const R = run && run.doc, ci = R ? curWp(R) : -1, w = ci >= 0 ? R.wps[ci] : null, A = M.A;
    const k = `${DOCS.rev}|${run && run.rev}|${MEDIA.ok}`; if (A && A.key === k) return; if (A) A.key = k;
    if (M.stepList && M.stepP) M.stepList.replaceChildren(...(R ? R.wps.map((x, i) => {
      const s = M.stepP.cloneNode(true), [top, sub] = kids(s), [sn, tt] = kids(top);
      s.className = `step ${x.st === '방문' ? 'done' : x.st === '미방문' ? 'hold' : i === ci ? 'now' : ''}`.trim();
      sn.textContent = i + 1; tt.textContent = x.name || `지점 ${i + 1}`;
      sub.textContent = x.st === '방문' ? `방문 ${fmtT(x.at).slice(6)} · 사진 ${x.photos.length}${x.chk ? ` · ${x.chk}` : ''}` : x.st === '미방문' ? `미방문 · ${x.why}` : i === ci ? `기록 차례${x.photos.length ? ` · 사진 ${x.photos.length}` : ''}${x.chk ? ` · ${x.chk}` : ''} · 직접 조종` : '대기';
      return s;
    }) : [el('span', '진행 중 수동 임무 없음 — 위 링크의 임무 계획에서 계획을 고르고 «수동 진행 시작»', { style: 'font-size:12px;color:var(--muted)' })]));
    if (!A) return;
    T(A.sub, !R ? '진행 중 임무 없음' : w ? `${wpName(w, ci)} · 모듈 ${w.mods.length}개 · 운영자 기록` : '모든 지점 기록됨');
    const line = (done, t, at) => { const a = (done ? A.done : A.wait).cloneNode(true), b = A.txt.cloneNode(true), c = A.time.cloneNode(true); b.textContent = t; c.textContent = at ? fmtT(at).slice(6) : ''; return [a, b, c]; };
    A.grid.replaceChildren(...(w ? [line(w.st !== '대기', '방문 기록 · 운영자 «방문 확인»(자동 도착 판정 미연결)', w.at), ...w.mods.map((ty) => line(modDone(w, ty), modTxt(w, ty)))].flat()
      : line(false, R ? '대기 지점 없음 — 아래에서 임무를 끝내세요' : '수동 진행을 시작하면 지금 지점에서 할 일이 여기에 나옵니다')));
    const ph = R ? R.wps.flatMap((x, i) => x.photos.map((u) => [u, i])).slice(-3) : [];
    show(A.tiles, ph.length > 0);
    A.tiles.replaceChildren(...ph.map(([u, i]) => { const t = A.tile.cloneNode(true); t.style.overflow = 'hidden'; t.title = `WP${i + 1} 사진`;
      const a = el('a', null, { href: `PcReview.dc.html?live=v2&url=${encodeURIComponent(u)}` }); a.append(el('img', null, { src: u, alt: `WP${i + 1} 사진`, loading: 'lazy', style: 'width:100%;height:100%;object-fit:cover;display:block' })); t.append(a); return t; }));
    T(A.lbl, ph.length ? `이 임무의 사진 · ${[...new Set(ph.map(([, i]) => `WP${i + 1}`))].join(' · ')}` : R ? '이 임무에 붙인 사진 없음 — «📷 사진»으로 지금 지점에 붙입니다' : '');
    A.acts.replaceChildren(...(R ? [...(w ? [wpActs(run.id, ci, w)] : []), endRow(run.id)] : []));
  }

  // ---- 로그인(보호 관문) — 시안 로그인 화면에 실제 로그인을 붙인다. 예시 계정·비밀번호는 지운다 ----
  function setupLogin() {
    const f = $('form'), isPhone = PAGE === 'MLogin.dc.html';
    const id = $(isPhone ? '#mid' : '#id'), pw = $(isPhone ? '#mpw' : '#pw'), dv = $('#dv');
    id.value = ''; pw.value = ''; if (dv) { dv.value = ''; dv.placeholder = '예: 관제 노트북 · 기록에 남음'; }
    const srv = byText('span', '현장 서버', f);
    if (srv) {
      srv.textContent = `v2 시뮬 관문 · ${location.host}`;
      const sub = srv.nextElementSibling; if (sub) sub.textContent = GATED ? '이 PC 의 자체 인증서 · 경고가 뜨면 «설치·접속 안내»' : '보호 주소(https)가 아님 — 로그인 안 됨';
    }
    why(byText('a', '바꾸기', f), '연결할 서버는 이 주소 하나입니다');
    const keep = f.querySelector('input[type=checkbox]');
    if (keep) { keep.disabled = true; keep.parentElement.title = '로그인은 12시간 유지(관문을 다시 켜면 다시 로그인)'; keep.parentElement.lastChild.textContent = '로그인 12시간 유지 · 관문 재시작 시 다시 로그인'; }
    const btn = byText('a', '로그인', f), view = byText('a', '보기 전용', f);
    why(view, '보기 전용 계정은 없습니다 — 로그인 뒤 조종권을 받지 않으면 보기 전용(STOP 은 누구나)');
    const msg = el('div'); msg.setAttribute('role', 'alert'); msg.style.cssText = 'min-height:20px;font-size:13px;color:#FF5A4F';
    btn.before(msg);
    const guide = el('a', '설치·접속 안내(QR·인증서·홈 화면 추가)', { href: 'start.html' }); guide.style.cssText = 'font-size:13px;color:var(--accent);text-align:center;padding:10px 0';
    f.append(guide);
    const nx = Q.get('next') || '', next = /^\/[\w.-]+\.html(\?[^#]*)?$/.test(nx) ? nx : (isPhone ? '/MDrive.dc.html?live=v2' : '/Main.dc.html?live=v2');
    let busy = false;
    const go = async (e) => {
      e.preventDefault(); if (busy) return;
      if (!GATED) { msg.textContent = '보호 주소(https://…:8453)에서만 로그인할 수 있습니다'; return; }
      if (!id.value.trim() || !pw.value) { msg.textContent = '계정과 비밀번호를 넣으세요'; return; }
      busy = true; btn.style.opacity = '.6'; msg.textContent = '확인 중…';
      try {
        const r = await fetch('api/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user: id.value.trim(), pw: pw.value, device: dv ? dv.value : (isPhone ? '휴대폰' : '') }) });
        const d = await r.json().catch(() => ({}));
        if (r.ok && d.ok) { msg.style.color = '#5AA9FF'; msg.textContent = '로그인됨 — 여는 중'; location.assign(next); return; }
        msg.textContent = d.error || `로그인 실패(HTTP ${r.status})`;
      } catch (err) { msg.textContent = `서버에 닿지 않음 · ${err.message || err}`; }
      busy = false; btn.style.opacity = '';
    };
    btn.removeAttribute('href'); btn.setAttribute('role', 'button'); btn.tabIndex = 0; btn.style.cursor = 'pointer';
    btn.addEventListener('click', go); f.addEventListener('submit', go);
    btn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') go(e); });
  }

  // ==== 공용 문서(서버 저장 — 구역·임무·수동 임무 진행·사진 분류). 로그인만 필요, 로봇 조종권과 무관 ====
  const DOCS = { list: [], rev: null, err: '', busy: false, t: -1e9 };
  async function loadDocs() {
    if (DOCS.busy) return; DOCS.busy = true; DOCS.t = performance.now();
    try {
      const r = await fetch('api/docs', { cache: 'no-store', credentials: 'same-origin' }), d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      DOCS.list = d.docs; DOCS.rev = d.rev; DOCS.err = d.broken || '';
    } catch (e) { DOCS.err = `문서 읽기 실패 · ${e.message || e}`; }
    DOCS.busy = false; paint();
  }
  const docsOf = (k) => DOCS.list.filter((d) => d.kind === k).sort((a, b) => (a.at < b.at ? 1 : -1));
  const docById = (id) => DOCS.list.find((d) => d.id === id);
  async function saveDoc(m) {   // → {ok:true,id,rev} | {ok:false, code, error, cur}
    try {
      const r = await fetch('api/docs', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(m) });
      const d = await r.json().catch(() => ({}));
      loadDocs();
      return r.ok ? { ok: true, ...d } : { ok: false, code: r.status, error: d.error || `HTTP ${r.status}`, cur: d.cur };
    } catch (e) { return { ok: false, code: 0, error: `서버에 닿지 않음 · ${e.message || e}` }; }
  }
  // 편집기 공통: 초안(d)·기준 판(rev). 400·409·404·저장 실패 어느 경우에도 초안은 지우지 않는다
  function editor(kind, rebuild) {
    const E = { kind, id: null, rev: null, d: null, dirty: false, busy: false, gen: 0, msg: el('div') };   // gen: 다른 문서를 열 때마다 +1(옛 응답이 새 편집기를 덮지 않게)
    const say = (t, bad) => E.msg.replaceChildren(el('p', t, { className: 'lv-note', style: bad ? 'color:var(--bad)' : '' }));
    E.load = (doc, init) => { E.gen++; E.id = doc ? doc.id : null; E.rev = doc ? doc.rev : null; E.d = structuredClone(doc ? doc.doc : init); E.dirty = false; E.msg.replaceChildren(); };
    E.save = async (rev = E.rev) => {
      if (E.busy) return null; E.busy = true; say('저장 중…');
      const sent = JSON.stringify(E.d), gen = E.gen;      // 보낸 판 그대로 묶어 둔다 — 저장 중 입력은 E.d 에만 쌓임
      const r = await saveDoc({ op: 'put', kind, id: E.id, rev, doc: JSON.parse(sent) }); E.busy = false;
      if (gen !== E.gen) { toast(r.ok ? `앞 문서 저장됨 · 판 ${r.rev}` : `앞 문서 저장 안 됨 · ${r.error}`); return { ...r, ok: false, other: true }; }   // 그 사이 다른 문서를 열었음 — 지금 편집기는 그대로, 호출자가 «성공»으로 정리하지 않게 ok:false
      if (r.ok) {
        E.id = r.id; E.rev = r.rev; E.dirty = JSON.stringify(E.d) !== sent;   // 실제로 저장된 판과 같을 때만 깨끗함
        say(E.dirty ? `판 ${r.rev} 저장됨 · 저장 중에 고친 내용은 아직 저장 안 됨` : `저장됨 · 판 ${r.rev} · 모든 기기 공유`); rebuild(); return r;
      }
      if (r.code === 409 && r.cur) {
        const b = el('div', null, { className: 'lv-warnbox' }); b.setAttribute('role', 'alert');
        b.append(el('span', `다른 기기가 먼저 고침 · ${r.cur.by} · ${fmtT(r.cur.at)} (판 ${r.cur.rev}). 내 초안은 화면에 그대로 있습니다.`),
          row(btn('최신 판 불러오기(내 초안 버림)', () => { E.load(r.cur); rebuild(); }), btn('내 초안을 최신 판 위에 저장', () => { E.id = r.cur.id; E.save(r.cur.rev); }, 'pri')));
        E.msg.replaceChildren(b);
      } else if (r.code === 404) {
        const b = el('div', null, { className: 'lv-warnbox' }); b.setAttribute('role', 'alert');
        b.append(el('span', '다른 기기가 이 문서를 지웠습니다. 내 초안은 화면에 그대로 있습니다.'), row(btn('새 문서로 저장', () => { E.id = null; E.rev = null; E.save(); }, 'pri')));
        E.msg.replaceChildren(b);
      } else say(`저장 안 됨 · ${r.error} — 초안은 화면에 그대로`, true);
      return r;
    };
    E.del = async () => {
      if (!E.id || !confirm('지울까요? 모든 기기에서 사라집니다.')) return null;
      const r = await saveDoc({ op: 'del', id: E.id, rev: E.rev });
      if (!r.ok) say(r.code === 409 ? '다른 기기가 먼저 고침 — 최신 판을 확인한 뒤 다시 지우세요' : `지우지 못함 · ${r.error}`, true);
      return r;
    };
    E.stale = () => { const c = !E.busy && E.id && DOCS.rev != null ? docById(E.id) : null; return c && c.rev > E.rev ? c : null; };   // 더 새 판만(방금 저장해 서버 목록이 아직 옛 판일 때 되돌리지 않음)
    return E;
  }

  // ==== 공용 지도: 시뮬 바닥 도면(±10 m, 1 m 격자) + 구역 + 경유점 + 지나온 길 + 로봇. 기본 북쪽 위·로봇 중심(지도가 움직임) ====
  const FLOOR = 10;                                   // online-20261012/gz/world_live.sdf: 평평한 바닥, 격자 선 −10~10 m
  const TRAIL = { pts: [], ep: null, last: null };    // last = 마지막으로 받은 GT(오래되면 흐리게 «오래됨»)
  const MAPS = [];
  const MODE_KO = { robot: '로봇 중심', all: '전체 보기', free: '손으로 옮김(◎ 로 복귀)' };
  const r2 = (v) => Math.round(v * 100) / 100;
  function track() {
    if (!st) return;
    if (st.episode !== TRAIL.ep) { TRAIL.pts = []; TRAIL.ep = st.episode; }   // 새 에피소드면 지나온 길을 새로
    const s = view().s;
    if (!s || !ok(s.x) || !ok(s.y)) return;
    TRAIL.last = { x: s.x, y: s.y, yaw: s.yaw, fallen: s.fallen, t: performance.now() };
    const p = TRAIL.pts[TRAIL.pts.length - 1];
    if (!p || Math.hypot(p[0] - s.x, p[1] - s.y) > 0.02) TRAIL.pts.push([s.x, s.y]);
    if (TRAIL.pts.length > 2000) TRAIL.pts.shift();
  }
  const pip = (x, y, pts) => { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const [xi, yi] = pts[i], [xj, yj] = pts[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
  const zonesAt = (x, y) => docsOf('zone').filter((z) => pip(x, y, z.doc.pts));
  const zoneTxt = (x, y) => { const z = zonesAt(x, y); return z.length ? z.map((d) => `${d.doc.type} «${d.doc.name}»`).join(', ') + ' 안(표시만)' : '구역 밖'; };
  const areaOf = (p) => Math.abs(p.reduce((a, q, i) => { const n = p[(i + 1) % p.length]; return a + q[0] * n[1] - n[0] * q[1]; }, 0)) / 2;
  const fresh = () => !!(view().s && TRAIL.last);
  const robotDist = (x, y) => (fresh() ? Math.hypot(TRAIL.last.x - x, TRAIL.last.y - y) : null);
  function mapView(box, o = {}) {
    const cv = el('canvas'); cv.dataset.liveMap = o.name || '1';
    cv.style.cssText = `position:absolute;inset:0;width:100%;height:100%;touch-action:none;${o.small ? 'pointer-events:none' : 'cursor:crosshair'}`;
    if (getComputedStyle(box).position === 'static') box.style.position = 'relative';
    box.prepend(cv);                                   // 위에 얹는 버튼·안내가 캔버스 위로 오게 맨 앞
    for (const c of box.children) if (c !== cv && getComputedStyle(c).position === 'static') c.style.position = 'relative';   // 위치 없는 원본 도구줄(레이어·확대)은 absolute 캔버스 아래로 깔리므로 relative 로 올린다
    let mode = o.mode || store.get('fh.live.mapmode', 'robot'); if (mode !== 'all') mode = 'robot';
    const V = { cv, small: !!o.small, mode, zoom: 1, c: [0, 0], kBase: 20, kFree: 20, k: 20, showTrail: true, showZones: true,
      wps: null, draft: null, sel: null, hiZone: null, hiWp: null, onTap: o.onTap, btn: {} };
    V.setMode = (m) => { V.mode = m; V.zoom = 1; V.draw(); };
    V.zoomBy = (f) => { V.zoom = Math.min(8, Math.max(0.25, V.zoom * f)); V.draw(); };
    let drag = null;
    cv.addEventListener('pointerdown', (e) => { if (e.button) return; drag = { id: e.pointerId, x: e.clientX, y: e.clientY, c: V.c.slice(), moved: false }; cv.setPointerCapture(e.pointerId); });
    cv.addEventListener('pointermove', (e) => {
      if (!drag || drag.id !== e.pointerId) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 6) return;
      if (!drag.moved) { drag.moved = true; if (V.mode !== 'free') { V.kFree = V.kBase; V.mode = 'free'; } }   // 손으로 끌면 따라가기 해제
      V.c = [drag.c[0] - dx / V.k, drag.c[1] + dy / V.k]; V.draw();
    });
    cv.addEventListener('pointerup', (e) => {
      if (!drag || drag.id !== e.pointerId) return; const d = drag; drag = null;
      if (!d.moved && V.onTap) { const r = cv.getBoundingClientRect(); V.onTap(...V.toWorld(e.clientX - r.left, e.clientY - r.top)); paint(); }
    });
    cv.addEventListener('pointercancel', () => { drag = null; });
    if (!o.small) cv.addEventListener('wheel', (e) => { e.preventDefault(); V.zoomBy(e.deltaY < 0 ? 1.25 : 0.8); }, { passive: false });
    V.draw = () => {
      const W = box.clientWidth, H = box.clientHeight; if (!W || !H) return;
      const dpr = window.devicePixelRatio || 1;
      if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
      const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const cs = getComputedStyle(cv), col = (n, d) => cs.getPropertyValue(n).trim() || d;
      const C = { map: col('--map', '#0E1317'), bg: col('--bg', '#05080A'), line: col('--line2', '#34424D'), mut: col('--muted', '#9AA7B3'), acc: col('--accent', '#38C6D9'),
        bad: col('--bad', '#FF5A52'), warn: col('--warn', '#FFB547'), ok: col('--ok', '#5AA9FF'), text: col('--text', '#E6EBEF') };
      const r = V.noRobot ? null : TRAIL.last, fr = fresh(), pts = V.showTrail ? TRAIL.pts : [], wps = V.wps || [];   // 보고서: 지금 로봇·지금 길은 안 그림(과거 기록 범위를 바꾸지 않게)
      let cx, cy, kBase;
      if (V.mode === 'robot' && r) { cx = r.x; cy = r.y; kBase = Math.min(W, H) / (V.small ? 6 : 10); }
      else if (V.mode === 'free') { [cx, cy] = V.c; kBase = V.kFree; }
      else {   // 전체 보기(또는 위치가 아직 없을 때): 바닥 + 지나온 길 + 로봇 + 경유점이 다 들어오게
        const xs = [-FLOOR, FLOOR, ...pts.map((p) => p[0]), ...wps.map((w) => w.x)], ys = [-FLOOR, FLOOR, ...pts.map((p) => p[1]), ...wps.map((w) => w.y)];
        if (r) { xs.push(r.x); ys.push(r.y); }
        const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
        cx = (x0 + x1) / 2; cy = (y0 + y1) / 2; kBase = Math.min(W / (x1 - x0 + 2), H / (y1 - y0 + 2));
      }
      const k = kBase * V.zoom; V.kBase = kBase; V.k = k; V.c = [cx, cy];
      const X = (x) => W / 2 + (x - cx) * k, Y = (y) => H / 2 - (y - cy) * k;
      V.toWorld = (px, py) => [cx + (px - W / 2) / k, cy - (py - H / 2) / k];
      g.fillStyle = C.bg; g.fillRect(0, 0, W, H);
      g.fillStyle = C.map; g.fillRect(X(-FLOOR), Y(FLOOR), 2 * FLOOR * k, 2 * FLOOR * k);
      if (k >= 4) {
        g.strokeStyle = 'rgba(128,140,150,.22)'; g.lineWidth = 1; g.beginPath();
        for (let i = Math.max(-FLOOR, Math.ceil(cx - W / 2 / k)); i <= Math.min(FLOOR, cx + W / 2 / k); i++) { g.moveTo(X(i), Y(FLOOR)); g.lineTo(X(i), Y(-FLOOR)); }
        for (let j = Math.max(-FLOOR, Math.ceil(cy - H / 2 / k)); j <= Math.min(FLOOR, cy + H / 2 / k); j++) { g.moveTo(X(-FLOOR), Y(j)); g.lineTo(X(FLOOR), Y(j)); }
        g.stroke();
      }
      g.strokeStyle = C.line; g.lineWidth = 2; g.strokeRect(X(-FLOOR), Y(FLOOR), 2 * FLOOR * k, 2 * FLOOR * k);
      const poly = (p) => { g.beginPath(); p.forEach((q, i) => (i ? g.lineTo(X(q[0]), Y(q[1])) : g.moveTo(X(q[0]), Y(q[1])))); };
      g.font = '600 12px sans-serif';
      if (V.showZones) for (const z of docsOf('zone')) {
        const c = z.doc.type === '금지' ? C.bad : C.warn; poly(z.doc.pts); g.closePath();
        g.globalAlpha = 0.18; g.fillStyle = c; g.fill(); g.globalAlpha = 1; g.strokeStyle = c; g.lineWidth = z.id === V.hiZone ? 3.5 : 1.5; g.stroke();
        if (!V.small) { const m = z.doc.pts.reduce((a, q) => [a[0] + q[0] / z.doc.pts.length, a[1] + q[1] / z.doc.pts.length], [0, 0]); g.fillStyle = c; g.fillText(`${z.doc.type} · ${z.doc.name}`, X(m[0]) - 20, Y(m[1])); }
      }
      if (V.draft && V.draft.pts.length) {
        const c = V.draft.type === '금지' ? C.bad : C.warn; poly(V.draft.pts); if (V.draft.pts.length > 2) g.closePath();
        g.setLineDash([6, 4]); g.strokeStyle = c; g.lineWidth = 2; g.stroke(); g.setLineDash([]);
        for (const q of V.draft.pts) { g.beginPath(); g.arc(X(q[0]), Y(q[1]), 4, 0, 7); g.fillStyle = c; g.fill(); }
      }
      if (wps.length) {
        g.setLineDash([6, 5]); g.strokeStyle = C.acc; g.lineWidth = 2; poly(wps.map((w) => [w.x, w.y])); g.stroke(); g.setLineDash([]);
        g.textAlign = 'center'; g.textBaseline = 'middle';
        wps.forEach((w, i) => {
          const c = w.st === '방문' ? C.ok : w.st === '미방문' ? C.mut : C.acc;
          g.beginPath(); g.arc(X(w.x), Y(w.y), V.small ? 4 : i === V.hiWp ? 13 : 10, 0, 7); g.fillStyle = w.st === '방문' ? c : C.map; g.fill(); g.strokeStyle = c; g.lineWidth = 2; g.stroke();
          if (!V.small) { g.fillStyle = w.st === '방문' ? C.bg : c; g.fillText(w.st === '미방문' ? '×' : String(i + 1), X(w.x), Y(w.y) + 0.5); }
        });
        g.textAlign = 'left'; g.textBaseline = 'alphabetic';
      }
      if (V.showTrail && pts.length > 1) { g.strokeStyle = C.acc; g.globalAlpha = 0.8; g.lineWidth = V.small ? 2 : 3; poly(pts); g.stroke(); g.globalAlpha = 1; }
      g.strokeStyle = C.mut; g.lineWidth = 1; g.beginPath(); g.moveTo(X(0) - 6, Y(0)); g.lineTo(X(0) + 6, Y(0)); g.moveTo(X(0), Y(0) - 6); g.lineTo(X(0), Y(0) + 6); g.stroke();
      if (V.sel) {
        const [sx, sy] = [X(V.sel[0]), Y(V.sel[1])]; g.fillStyle = C.acc;
        g.beginPath(); g.moveTo(sx, sy); g.arc(sx, sy - 16, 8, Math.PI * 0.8, Math.PI * 2.2); g.closePath(); g.fill(); g.beginPath(); g.arc(sx, sy - 16, 3, 0, 7); g.fillStyle = C.map; g.fill();
      }
      if (r) {
        g.save(); g.translate(X(r.x), Y(r.y)); if (ok(r.yaw)) g.rotate(-r.yaw);
        g.globalAlpha = fr ? 1 : 0.45; g.fillStyle = !fr ? C.mut : r.fallen === true ? C.bad : C.acc;
        const q = V.small ? 0.75 : 1; g.beginPath(); g.moveTo(14 * q, 0); g.lineTo(-10 * q, 9 * q); g.lineTo(-5 * q, 0); g.lineTo(-10 * q, -9 * q); g.closePath(); g.fill(); g.restore();
        const tags = [];
        if (!fr) tags.push(`위치 오래됨 ${((performance.now() - r.t) / 1000).toFixed(0)} s`);
        if (Math.abs(r.x) > FLOOR || Math.abs(r.y) > FLOOR) tags.push('도면 밖');   // 가두지 않고 그대로 그린다
        if (tags.length) { g.font = `600 ${V.small ? 10 : 12}px sans-serif`; g.fillStyle = C.warn; g.fillText(tags.join(' · '), X(r.x) + 12, Y(r.y) - 12); }
      } else if (!V.noRobot) { g.font = '600 13px sans-serif'; g.fillStyle = C.warn; g.textAlign = 'center'; g.fillText('위치 없음 · GT 미수신', W / 2, H / 2); g.textAlign = 'left'; }
      g.font = '600 11px sans-serif'; g.fillStyle = C.mut; g.textAlign = 'right'; g.fillText('N ↑', W - 8, H - 9); g.textAlign = 'left';   // 왼쪽 위는 원본 안내 말풍선 자리
      if (!V.small) {
        const t = `격자 1 m · ${W < 520 ? '' : '바닥 ±10 m · '}${W < 520 ? 'GT 위치(SLAM 아님)' : 'Gazebo GT 위치(지도·SLAM 아님)'} · ${MODE_KO[V.mode]} ×${+V.zoom.toFixed(2)}${V.showTrail ? '' : ' · 길 숨김'}`;
        g.font = '12px sans-serif'; const w = g.measureText(t).width; g.globalAlpha = 0.75; g.fillStyle = C.bg; g.fillRect(4, H - 24, w + 10, 20); g.globalAlpha = 1; g.fillStyle = C.mut; g.fillText(t, 9, H - 9);
      }
      cv.dataset.view = `${V.mode}|${+V.zoom.toFixed(2)}|${V.showTrail ? 'trail' : 'notrail'}|${r ? (fr ? 'fresh' : 'stale') : 'none'}`;   // 시험·상태 확인용
      if (V.btn.robot) V.btn.robot.setAttribute('aria-pressed', String(V.mode === 'robot'));
      if (V.btn.all) V.btn.all.setAttribute('aria-pressed', String(V.mode === 'all'));
    };
    MAPS.push(V); return V;
  }
  function mapBtns(V, cls, icons) {   // 로봇 중심 · 전체 보기 · 확대 · 축소
    const w = el('div', null, { className: cls || 'lv-row' });
    const b = (t, label, fn) => { const x = btn(t, fn); x.setAttribute('aria-label', label); x.title = label; return x; };
    V.btn.robot = b(icons ? '◎' : '로봇 중심', '로봇 중심(지도가 따라 움직임)', () => V.setMode('robot'));
    V.btn.all = b(icons ? '⤢' : '전체 보기', '전체 보기', () => V.setMode('all'));
    w.append(V.btn.robot, V.btn.all, b('+', '확대', () => V.zoomBy(1.5)), b('−', '축소', () => V.zoomBy(1 / 1.5)));
    return w;
  }

  // ==== 서버 보관 사진·사건(모든 기기 공통) ====
  const MEDIA = { photos: [], events: [], err: '', ok: false, busy: false, t: -1e9, key: null };
  async function loadMedia() {
    if (MEDIA.busy) return; MEDIA.busy = true; MEDIA.t = performance.now();
    try {
      const r = await fetch('api/media', { cache: 'no-store', credentials: 'same-origin' }); if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json(); MEDIA.photos = d.photos; MEDIA.events = d.events; MEDIA.err = ''; MEDIA.ok = true;
    } catch (e) { MEDIA.err = `서버 기록 읽기 실패 · ${e.message || e}`; }
    MEDIA.busy = false; paint();
  }
  function refreshShared() {   // 상태 메시지마다: 문서 판·최신 사건이 바뀌면 다시 읽기(실패 뒤엔 3 s 쉬고)
    const now = performance.now();
    if (st.docs_rev != null && st.docs_rev !== DOCS.rev && now - DOCS.t > (DOCS.err ? 3000 : 300)) loadDocs();
    if (P) {
      const e = (st.events || [])[0], k = e ? `${e.t}|${e.text}` : '';
      if (k !== MEDIA.key && now - MEDIA.t > (MEDIA.err ? 3000 : 1500)) { MEDIA.key = k; loadMedia(); }
    }
  }
  const tms = (at) => Date.parse(String(at || '').replace(/([+-]\d\d)(\d\d)$/, '$1:$2')) || 0;
  const fmtT = (at) => (at ? String(at).slice(5, 19).replace('T', ' ') : '—');
  const posTxt = (x, y) => (ok(x) && ok(y) ? `x ${sgn(x)} · y ${sgn(y)} m` : '위치 미확인');
  const noteOf = (url) => docsOf('note').find((n) => n.doc.photo === url);
  const activeRun = () => docsOf('run').find((d) => d.doc.status === '진행');
  const alertsOf = () => MEDIA.events.filter((e) => e.st === 'warn' || e.st === 'bad');

  // ==== 그 밖의 화면: 원본 시안 DOM(머리줄·목록·입력칸·카드·지도 자리·하단 패널)은 그대로 두고, 그 자리에 실데이터·빈 상태·버튼 연결만 붙인다 ====
  // 시안 예시값은 실제 값으로 바꾼다. 현재 v2 연결에 없는 기능(가스·AI·자동 규칙·자동 이동)은 원본 자리에 «미연결·미제공 + 이유»로 남긴다(지우지 않음).
  const PCP = PAGE.startsWith('Pc');
  const btn = (t, fn, cls = '') => el('button', t, { className: `lv-btn ${cls}`.trim(), type: 'button', onclick: fn });
  const tag = (t, cls = '') => el('span', t, { className: `lv-tag ${cls}`.trim() });
  const row = (...k) => { const r = el('div', null, { className: 'lv-row' }); r.append(...k); return r; };
  const note2 = (t) => el('p', t, { className: 'lv-note' });
  const T = (e, t) => { if (e && e.textContent !== String(t)) e.textContent = String(t); };   // 바뀔 때만 글 바꾸기
  const ROOT = () => $('#dc-root > div');
  const kids = (e) => (e ? [...e.children] : []);
  const lift = (els) => { const p = els[0] ? els[0].cloneNode(true) : null; for (const e of els) e.remove(); return p; };   // 원본 목록 항목을 본으로 떠 두고 자리는 비운다
  const dotc = (e, lv) => { if (e) e.style.color = `var(--${lv === 'bad' ? 'bad' : lv === 'warn' ? 'warn' : lv === 'off' ? 'muted' : 'ok'})`; };
  const svgSwap = (svg, css) => { const d = el('div'); d.style.cssText = `position:relative;${css}`; svg.replaceWith(d); return d; };   // 시안 그림 자리 → 실제 지도·사진 자리
  const ZONE_NOTE = '구역은 그리기·저장·공유·표시 기능입니다. 로봇의 실제 주행 제한(피하기·감속)은 미연결 — 충돌·감속을 보장하지 않습니다.';
  const OBS_NOTE = 'AI 탐지 미연결 — 운영자가 찍어 등록한 관찰입니다. 분류(확인·보류·제외)와 메모는 모든 기기에 공유됩니다.';
  const GOTO_WHY = `이 지점으로 이동 — ${WHY['자동 목적지 이동·자동 복귀']} · 직접 조종하세요`;
  const RULE_WHY = '경보 규칙 자동 실행 미연결 — 측정값·AI 탐지가 현재 v2 연결에 없어 규칙을 저장·실행하지 않습니다';
  const STOP_FACT = ['조종 입력 0.3 s 끊김', '명령 0 요청(몸 정지는 별도 — 관측: STOP 뒤 약 3.6 s 동안 0.32 m 더 움직임, 원인 미확인) · 자동 후퇴 미연결', '화면 숨김·로그아웃·화면 신호 1 s 끊김', '조종권 해제 + STOP 잠금(명령 0 유지) · 사람이 «STOP 해제»'];
  const LATCH_TXT = (v) => (!v.linkOk ? '잠금 상태 미확인(서버 연결 끊김)' : v.latch ? 'STOP 잠금 켜짐(명령 0 유지)' : 'STOP 잠금 꺼짐');   // 링크가 끊기면 «꺼짐»이 아니라 미확인

  let P = null;   // 지금 화면 {paint}
  const S = { el: null, alerts: null, reload: btn('새로고침(새 판)', reloadNow) };
  function mountStatus() {   // 상태 줄(링크·STOP 잠금·조종권·공유 문서 오류): PC 는 머리줄 STOP 앞, 휴대폰은 제목 아래
    const root = ROOT(), H = $('header', root);
    const s = el('span', null, { className: 'lv-status' }); s.dataset.liveStatus = '1';
    const stop = H && $('button[aria-label="비상 정지"]', H), tdiv = H && $(':scope > div', H);
    if (stop) stop.before(s); else if (tdiv) { tdiv.append(s); } else if (H) { H.after(s); s.style.padding = '4px 14px'; } else { root.prepend(s); s.style.padding = '6px 14px'; }
    S.el = s; S.alerts = $('a[href^="MAlerts"]', root);
  }
  function paintStatus() {
    if (!S.el) return;
    const v = view(), s = el('span');
    const dot = (good, t) => { const x = el('span'); x.append(el('span', good ? '●' : '▲', { style: `color:var(${good ? '--ok' : '--warn'})` }), ` ${t}`); return x; };
    const parts = [dot(v.linkOk && !(st && st.sim_block), `링크 ${v.linkTxt}`), dot(v.linkOk && !v.latch, !v.linkOk ? '잠금 상태 미확인(서버 연결 끊김)' : v.latch ? 'STOP 잠금' : 'STOP 해제됨'), el('span', v.roleTxt)];
    if (sessTxt()) parts.push(el('span', `시뮬 ${sessTxt()}`));
    if (DOCS.err) parts.push(el('span', `공유 문서: ${DOCS.err}`, { style: 'color:var(--bad)' }));
    if (newVer()) parts.push(el('span', `새 화면 판 ${st.ver} 반영됨(이 화면 ${firstVer})`, { style: 'color:var(--warn)' }), S.reload);
    s.append(...parts);
    const key = s.textContent; if (S.el.dataset.k !== key) { S.el.dataset.k = key; S.el.replaceChildren(...s.childNodes); }
    if (S.alerts) { const n = unreadAlerts(); const c = $('.mono', S.alerts); if (c) T(c, n); S.alerts.setAttribute('aria-label', `알림 ${n}건(읽지 않음)`); }
  }
  const unreadAlerts = () => { const rd = store.get('fh.live.alerts.read', ''); return alertsOf().filter((e) => !rd || tms(e.at) > tms(rd)).length; };
  function hdr(a, b) {   // PC 머리줄 두 줄(위 작은 줄 · 아래 제목)
    const H = $('header', ROOT()); if (!H) return;
    const lines = $$(':scope > div', H).find((d) => d.children.length === 2 && [...d.children].every((c) => c.tagName === 'SPAN'));
    if (lines) { T(lines.children[0], a); if (b != null) T(lines.children[1], b); }
  }
  const busyInput = () => { const a = document.activeElement; return !!(a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && ROOT().contains(a)); };

  // ---- 임무 양식(서버 문서 kind 'tmpl') ----
  // 지금 앱으로 실제 할 수 있는 모듈만 저장·진행: 사진·운영자 확인·대기. 가스·AI·음성은 원본 자리에 «미연결»로 둔다.
  const LIVE_MODS = ['사진', '운영자 확인', '대기'];
  const MOD_DEF = { '사진': '전방 1장', '운영자 확인': '현장 확인 뒤 확인·보류·제외 기록', '대기': '30초 멈춤(운영자가 지킴 · 자동 타이머 아님)' };
  const MOD_OFF = { 'AI 탐지': `AI 탐지 — ${WHY['AI 탐지·발견물 판독']}`, '가스 측정': `가스 측정 — ${WHY['가스·측정값·통신 품질']}`, '음성 방송': '음성 방송 — 미연결: 현재 v2 연결에 스피커 출력 없음' };
  const BASE_T = { id: 'base', kind: '기본', locked: true, name: '지점 확인 다녀오기', desc: '지점에 가서 직접 조종·영상으로 확인하고 기록합니다',
    mods: [{ type: '사진', detail: MOD_DEF['사진'] }, { type: '운영자 확인', detail: MOD_DEF['운영자 확인'] }] };
  const tmpls = () => [BASE_T, ...docsOf('tmpl').map((d) => ({ id: d.id, kind: '팀', locked: false, by: d.by, at: d.at, rev: d.rev, ...d.doc }))];
  const tmplOf = (id) => tmpls().find((t) => t.id === id) || BASE_T;
  const defMods = (tid) => [...new Set(tmplOf(tid).mods.map((m) => m.type))].filter((t) => LIVE_MODS.includes(t)).slice(0, 3);
  const modDetail = (tid, ty) => (tmplOf(tid).mods.find((m) => m.type === ty) || { detail: MOD_DEF[ty] }).detail;

  // ---- 수동 임무 진행(공용 동작) — 자동 이동·자동 완료 없음, 운영자가 눌러 기록 ----
  const isoNow = () => {   // 이 기기 시각 + 시간대(서버 기록과 같은 꼴 2026-10-13T12:46:00+0900)
    const d = new Date(), o = -d.getTimezoneOffset(), p = (x) => String(Math.abs(x)).padStart(2, '0');
    return `${new Date(d.getTime() + o * 6e4).toISOString().slice(0, 19)}${o < 0 ? '-' : '+'}${p(Math.trunc(o / 60))}${p(o % 60)}`;
  };
  const newRun = (mid, m) => ({ mode: '수동', mission: mid, tmpl: tmplOf(m.tmpl).name.slice(0, 60), name: m.name, status: '진행', started: isoNow(), ended: '', memo: '',
    wps: m.wps.map((w) => ({ x: w.x, y: w.y, name: w.name, mods: w.mods.slice(), st: '대기', at: '', why: '', chk: '', photos: [] })) });   // 계획 스냅샷: 나중에 계획을 고쳐도 이 기록은 그대로
  async function startRun(mid) {
    const m = docById(mid); if (!m) { toast('계획을 고르세요'); return null; }
    if (!m.doc.wps.length) { toast('지점이 없는 계획입니다 — 먼저 지점을 추가'); return null; }
    if (activeRun()) { toast('진행 중인 수동 임무가 있습니다 — 먼저 끝내세요'); return null; }
    if (!confirm(`«${m.doc.name}» 수동 진행을 시작할까요?\n· 로봇은 자동으로 움직이지 않습니다(직접 조종)\n· 방문·미방문·판단은 운영자가 눌러 기록`)) return null;
    const r = await saveDoc({ op: 'put', kind: 'run', id: null, doc: newRun(mid, m.doc) });
    toast(r.ok ? '수동 진행 시작 · 모든 기기 공유' : `시작 안 됨 · ${r.error}`); return r.ok ? r : null;
  }
  async function runEdit(id, fn, what) {   // 최신 판 위에 한 가지 수정. 충돌이면 다시 누르게(수정 내용이 작아서)
    const d = docById(id); if (!d) return toast('진행 기록을 찾지 못함 — 새로 읽는 중');
    if (d.doc.status !== '진행') return toast(`이미 «${d.doc.status}»로 끝난 기록입니다`);
    const doc = structuredClone(d.doc); if (fn(doc) === false) return;
    const r = await saveDoc({ op: 'put', id, rev: d.rev, doc });
    toast(r.ok ? `${what} · 기록됨(운영자 기록 · 모든 기기 공유)` : r.code === 409 ? '다른 기기가 먼저 고침 — 최신 값으로 다시 눌러 주세요' : `기록 안 됨 · ${r.error}`);
  }
  async function attachPhoto(id, i) {
    const p = await shoot(); if (!p) return;
    runEdit(id, (d) => { if (d.wps[i].photos.length >= 10) { toast('지점마다 사진 10장까지 — 사진은 서버 기록에 남음'); return false; } d.wps[i].photos.push(p.url); }, `WP${i + 1} 사진`);
  }
  function wpActs(id, i, w) {   // 지점 기록 버튼: 방문 확인(시각 기록)·미방문 사유·운영자 판단·사진
    const r = el('div', null, { className: 'lv-row' }), n = `WP${i + 1}`;
    if (w.st === '대기') {
      r.append(btn('방문 확인', () => runEdit(id, (d) => { Object.assign(d.wps[i], { st: '방문', at: isoNow(), why: '' }); }, `${n} 방문 확인`), 'pri'),
        btn('미방문…', () => { const y = prompt(`${n} 미방문 사유(예: 길 막힘·위험·시간 부족)`); if (!y || !y.trim()) return; runEdit(id, (d) => { Object.assign(d.wps[i], { st: '미방문', at: '', why: y.trim().slice(0, 120) }); }, `${n} 미방문`); }));
    } else r.append(btn('대기로 되돌리기', () => runEdit(id, (d) => { Object.assign(d.wps[i], { st: '대기', at: '', why: '' }); }, `${n} 되돌림`)));
    if (w.mods.includes('운영자 확인')) for (const c of ['확인', '보류', '제외']) {
      const b = btn(c, () => runEdit(id, (d) => { d.wps[i].chk = d.wps[i].chk === c ? '' : c; }, `${n} 운영자 판단 ${c}`)); b.setAttribute('aria-pressed', String(w.chk === c)); b.title = '운영자 판단(로봇 자동 판정 아님)'; r.append(b);
    }
    r.append(btn('📷 사진', () => attachPhoto(id, i)));
    return r;
  }
  function runEnd(id, status) {
    const d = docById(id); if (!d) return;
    const left = d.doc.wps.filter((w) => w.st === '대기').length;
    if (status === '완료' && left) return toast(`대기 지점 ${left}개 — 방문 확인하거나 미방문 사유를 적은 뒤 완료`);
    const memo = status === '완료' ? null : prompt(`${status} 사유(기록에 남음)`, d.doc.memo); if (status !== '완료' && (memo == null || !memo.trim())) return;
    if (!confirm(`수동 임무를 «${status}»로 끝낼까요? (운영자 기록 · 로봇 동작과 무관)`)) return;
    runEdit(id, (x) => { x.status = status; x.ended = isoNow(); if (memo != null) x.memo = memo.trim().slice(0, 400); }, `임무 ${status}`);
  }
  const endRow = (id) => row(...['완료', '실패', '중단'].map((s) => btn(`임무 ${s}`, () => runEnd(id, s), s === '완료' ? 'pri' : '')));
  const curWp = (R) => R.wps.findIndex((w) => w.st === '대기');
  const legLen = (wps) => wps.reduce((a, w, i) => a + (i ? Math.hypot(w.x - wps[i - 1].x, w.y - wps[i - 1].y) : 0), 0);
  const durTxt = (a, b) => { const s = (tms(b) || Date.now()) - tms(a); return tms(a) ? `${Math.max(0, Math.round(s / 60000))}분` : '—'; };
  const wpName = (w, i) => `WP${i + 1}${w.name ? ` ${w.name}` : ''}`;
  const modDone = (w, ty) => (ty === '사진' ? w.photos.length > 0 : ty === '운영자 확인' ? !!w.chk : w.st === '방문');
  const modTxt = (w, ty) => (ty === '사진' ? `사진 · ${w.photos.length}장 붙임` : ty === '운영자 확인' ? `운영자 확인 · ${w.chk || '아직 판단 없음'}` : '대기 · 운영자가 지킴(자동 타이머 아님)');

  // ---- PC 임무 양식: 원본 Component 틀에 서버 문서를 끼운다(목록·입력칸·모듈 카드·규칙 자리 그대로) ----
  function pagePcMissions() {
    let sel = Q.get('tmpl') || 'base', gone = null, me = null, key = '', made = null;   // made: 방금 만든 양식 id(목록이 아직 안 읽혔어도 기본으로 되돌리지 않음)
    const E = editor('tmpl', () => me && me.setState({}));
    const plain = (t) => ({ name: t.name, desc: t.desc || '', mods: t.mods.map((m) => ({ type: m.type, detail: m.detail })) });
    function sync() {   // 고른 양식을 편집기에 — 고치는 중(dirty)이면 그대로
      if (sel !== 'base' && DOCS.rev != null && !docById(sel) && sel !== made && !E.busy && !E.dirty) sel = 'base';
      if (docById(sel)) made = null;
      if (Q.get('tmpl') !== sel) { Q.set('tmpl', sel); history.replaceState(null, '', `?${Q}`); }
      if (sel === 'base') { if (E.id || E.d) E.load(null); return; }
      const d = docById(sel); if (d && (E.id !== sel || (!E.dirty && !E.busy && d.rev > E.rev))) E.load(d);
    }
    const pick = (id) => { if (E.busy) return toast('저장 중 — 잠시 뒤 다시 고르세요'); if (E.dirty && !confirm('저장 안 한 수정이 있습니다. 버릴까요?')) return; E.dirty = false; gone = null; sel = id; me.setState({}); };
    const create = async (doc, what) => { const r = await saveDoc({ op: 'put', kind: 'tmpl', id: null, doc }); if (!r.ok) return toast(`${what} 안 됨 · ${r.error}`); E.dirty = false; sel = made = r.id; gone = null; toast(`${what} · 모든 기기 공유`); me.setState({}); };
    const commit = (k, v) => {   // 입력 칸을 벗어날 때 저장
      if (sel === 'base' || !E.d || !E.dirty) return;
      E.d[k] = v;
      if (!E.d.name.trim()) { E.msg.replaceChildren(note2('이름을 넣어야 저장됩니다 — 초안은 화면에 그대로')); return; }
      E.save();
    };
    window.dcUse((Comp) => {
      me = new (class extends Comp {
        constructor(p) { super(p); this.live = true; }
        upd(fn) {   // 원본의 모듈 더하기·빼기 → 서버 저장(새 모듈 내용은 이 앱 기본값)
          if (sel === 'base' || !E.d) return toast('기본 양식은 고칠 수 없습니다 · 복제해서 고치세요');
          if (E.busy) return toast('저장 중 — 잠시 뒤');
          const t = fn({ ...E.d, mods: E.d.mods.map((m, i) => ({ ...m, id: `lv${i}` })) });
          E.d = plain({ ...E.d, ...t, mods: t.mods.map((m) => ({ type: m.type, detail: /^lv\d+$/.test(m.id) ? m.detail : MOD_DEF[m.type] || m.detail })) });
          E.dirty = true; E.save();
        }
        renderVals() {
          sync();
          const list = tmpls().map((t) => {
            const x = t.id === sel && E.id === sel && E.d ? { ...t, ...E.d } : t;
            return { ...x, used: docsOf('run').filter((r) => r.doc.tmpl === x.name).length, edited: x.locked ? '기본 제공' : `${x.by} · ${fmtT(x.at)}`, rules: [], mods: x.mods.map((m, i) => ({ ...m, id: `lv${i}` })) };
          });
          this.state = { n: 1, sel, list, toast: null };
          const v = super.renderVals(), cur = list.find((t) => t.id === sel) || list[0];
          v.items = v.items.map((it, i) => ({ ...it, pick: () => pick(list[i].id) }));
          v.cur.saved = cur.locked ? '기본 제공 · 모든 기기 공통 · 고칠 수 없음' : E.busy ? '저장 중…' : E.dirty ? '저장 안 됨 — 입력 칸을 벗어나면 저장' : `자동 저장 · ${cur.by} · ${fmtT(cur.at)} · 판 ${E.rev}`;
          const full = cur.mods.length >= 6;
          v.palette = v.palette.map((p) => (MOD_OFF[p.type] ? { ...p, off: true, why: MOD_OFF[p.type] } : !p.off && full ? { ...p, off: true, why: '모듈은 6개까지' } : p));
          v.add = () => create({ name: `새 임무 양식 ${hms(new Date()).slice(0, 5)}`, desc: '', mods: [{ type: '사진', detail: MOD_DEF['사진'] }] }, '새 양식 만듦');
          v.dup = () => create({ ...plain(cur), name: `${cur.name} 복사본`.slice(0, 60) }, '복제됨');
          v.remove = async () => {
            if (cur.locked || !E.id || E.busy) return;
            const r = await saveDoc({ op: 'del', id: E.id, rev: E.rev });
            if (!r.ok) return toast(r.code === 409 ? '다른 기기가 먼저 고침 — 최신 판을 확인한 뒤 다시 지우세요' : `지우지 못함 · ${r.error}`);
            gone = plain(E.d); E.load(null); sel = 'base'; this.setState({});
          };
          v.undo = () => gone && create(gone, '되돌림(새 양식으로 다시 저장)');
          v.hasToast = !!gone; v.toastName = gone ? gone.name : '';
          v.rename = (e) => { if (E.d) { E.d.name = e.target.value; E.dirty = true; } };
          v.redesc = (e) => { if (E.d) { E.d.desc = e.target.value; E.dirty = true; } };
          v.addRule = () => toast(RULE_WHY);
          return v;
        }
        afterRender(root) {
          mountStatus(); wireStop(); guardLinks();
          const nm = $('#nm', root), ds = $('#ds', root);
          for (const [inp, k, n] of [[nm, 'name', 60], [ds, 'desc', 120]]) { inp.maxLength = n; inp.addEventListener('change', () => commit(k, inp.value)); }
          ds.after(E.msg);
          const planA = $('a[href^="PcPlan"]', root); if (planA) planA.href = `PcPlan.dc.html?live=v2&tmpl=${encodeURIComponent(sel)}`;
          const offL = byText('span.lbl', '열화상', root); if (offL) offL.textContent = `${Object.keys(MOD_OFF).join(' · ')} — 현재 v2 연결에 미연결(저장·실행 안 함) · 열화상 — 장비 미등록`;
          const addR = byText('button', '+ 규칙 추가', root); if (addR) why(addR, RULE_WHY);
          const fixed = $$('.rule', root).find((r) => !r.querySelector('button'));
          if (fixed) {   // 고정 규칙 자리: 지금 v2 서버가 실제로 하는 정지만(자동 후퇴 미연결)
            const put = (r, c, a) => { const [x, , y] = r.children; x.firstChild.textContent = '현재 v2 서버 · 항상 적용(끌 수 없음)'; x.lastChild.textContent = c; y.lastChild.textContent = a; };
            const f2 = fixed.cloneNode(true); put(fixed, STOP_FACT[0], STOP_FACT[1]); put(f2, STOP_FACT[2], STOP_FACT[3]); fixed.after(f2);
            fixed.before(el('div', RULE_WHY, { className: 'lbl' }));
          }
          if (sel !== 'base') $$('.mod', root).forEach((m, i) => {   // 모듈 내용(몇 장·어떻게 확인) 고치기
            const d = $('span > .lbl', m); if (!d) return;
            d.style.cursor = 'pointer'; d.title = '눌러서 내용 고치기'; d.tabIndex = 0; d.setAttribute('role', 'button');
            const go = () => { const y = prompt(`${E.d.mods[i].type} — 내용`, E.d.mods[i].detail); if (y == null || !y.trim()) return; this.upd((t) => ({ ...t, mods: t.mods.map((x, j) => (j === i ? { ...x, detail: y.trim().slice(0, 80) } : x)) })); };
            d.onclick = go; d.onkeydown = (e) => { if (e.key === 'Enter') go(); };
          });
          paintStatus();
        }
      })(PcMissionsProps());
      return me;
    });
    function PcMissionsProps() { return {}; }
    return { paint() {
      paintStatus();
      const k = `${DOCS.rev}|${sel}`;
      if (k !== key && !busyInput()) { key = k; me.setState({}); }
    } };
  }

  // ---- PC 임무 계획: 양식 고르기 + 지도에 경유점(원본 도구줄·지도·경로 목록·점검·하단 그대로) ----
  function pagePcPlan() {
    const root = ROOT(), H = $('header', root);
    let tool = 'add', wsel = null, meas = [], listKey = '', want = Q.get('mission') || '';
    const blank = () => ({ name: '', tmpl: Q.get('tmpl') || 'base', memo: '', wps: [] });   // 문서 읽기 전이라 id 그대로(목록이 오면 고르기에 반영)
    const E = editor('mission', () => { if (E.id) { want = E.id; history.replaceState(null, '', `?live=v2&mission=${E.id}`); } listKey = ''; });
    E.load(null, blank());
    addEventListener('beforeunload', (e) => { if (E.dirty) e.preventDefault(); });
    const pill = $(':scope > span', H), chips = $$('.chip', H);
    const mapSec = $('section[aria-label="경로 지도"]', root), tools = $$('button.tool', mapSec), [tSel, tAdd, tNo, tSlow, tMeas] = tools;
    const prevB = $('button.btn.sm', mapSec); prevB.lastChild.textContent = '지난 수동 진행 경로 불러오기';
    const svg = $('svg[role="img"]', mapSec), mbox = svg.parentElement; svg.style.visibility = 'hidden';
    const [ov1, ov2] = kids($$(':scope > div', mbox).pop());
    const V = mapView(mbox, { name: 'plan', onTap: (x, y) => {
      if (tool === 'add') { if (E.d.wps.length >= 30) return toast('지점은 30개까지'); E.d.wps.push({ x: r2(x), y: r2(y), name: '', mods: defMods(E.d.tmpl) }); wsel = E.d.wps.length - 1; E.dirty = true; }
      else if (tool === 'measure') meas = meas.length >= 2 ? [[r2(x), r2(y)]] : [...meas, [r2(x), r2(y)]];
      else { const i = E.d.wps.findIndex((w) => Math.hypot(w.x - x, w.y - y) * V.k < 16); wsel = i < 0 ? null : i; }
    } });
    mbox.append(mapBtns(V, 'lv-mapbtns', true));
    const setTool = (t) => { tool = t; meas = []; for (const [b, k] of [[tSel, 'sel'], [tAdd, 'add'], [tMeas, 'measure']]) b.setAttribute('aria-pressed', String(k === t)); for (const b of [tNo, tSlow]) b.setAttribute('aria-pressed', 'false'); };
    tSel.onclick = () => setTool('sel'); tAdd.onclick = () => setTool('add'); tMeas.onclick = () => setTool('measure'); setTool('add');
    for (const [b, ty] of [[tNo, '금지'], [tSlow, '감속']]) {
      b.title = `${ty} 구역은 지도 화면에서 그립니다(표시·공유만 · ${WHY['구역 주행 제한(피하기·감속)']})`;
      b.onclick = () => { if (role === 'control') return toast('조종 중입니다 — 조종권 반납 뒤 지도 화면으로'); if (E.dirty && !confirm('저장 안 한 계획 수정이 있습니다. 지도 화면으로 갈까요?')) return; E.dirty = false; location.href = `PcMap.dc.html?live=v2&draw=${encodeURIComponent(ty)}`; };
    }
    prevB.onclick = () => {
      const r = docsOf('run')[0]; if (!r) return toast('지난 수동 진행 기록이 없습니다');
      if (E.d.wps.length && !confirm(`지금 지점 ${E.d.wps.length}개를 «${r.doc.name}» 기록의 지점 ${r.doc.wps.length}개로 바꿀까요?`)) return;
      E.d.wps = r.doc.wps.slice(0, 30).map((w) => ({ x: w.x, y: w.y, name: w.name, mods: w.mods.slice() })); wsel = null; E.dirty = true;
    };
    // 계획 고르기·이름: 원본 «임무 양식» 칸을 복제해 바로 위에 둔다(같은 모양)
    const aside = $('aside', root), tplSel = $('#tpl', aside), tplBox = tplSel.parentElement, tplA = $('a[href^="PcMissions"]', tplBox);
    const pBox = tplBox.cloneNode(true); tplBox.before(pBox);
    const [pHead, pSel, pLbl] = kids(pBox), [pLab, pNew] = kids(pHead);
    pLab.textContent = '임무 계획'; pLab.htmlFor = 'plan'; pSel.id = 'plan'; pSel.removeAttribute('value');
    pNew.textContent = '+ 새 계획'; pNew.href = '#'; pNew.onclick = (e) => { e.preventDefault(); openPlan(''); };
    const pName = el('input', null, { className: 'inp', id: 'pname', maxLength: 60, placeholder: '계획 이름(예: B1 순찰 경로)' }); pName.setAttribute('aria-label', '계획 이름'); pLbl.replaceWith(pName);
    pName.oninput = () => { E.d.name = pName.value; E.dirty = true; };
    tplSel.removeAttribute('value');
    function openPlan(id) {
      if (E.dirty && !confirm('저장 안 한 수정이 있습니다. 버릴까요?')) { pSel.value = E.id || ''; return; }
      const d = docById(id); E.load(d || null, blank()); want = d ? d.id : ''; wsel = null; listKey = '';
      history.replaceState(null, '', `?live=v2${want ? `&mission=${want}` : ''}`);
    }
    pSel.onchange = () => openPlan(pSel.value);
    tplSel.onchange = () => { E.d.tmpl = tplSel.value; E.dirty = true; if (E.d.wps.length && confirm('지점마다 할 일을 이 양식 기본값으로 바꿀까요?')) for (const w of E.d.wps) w.mods = defMods(E.d.tmpl); };
    const [secR, secL, secA, secC] = $$('.sec', aside);
    const rH = $('h3 .mono', secR), rList = $('h3', secR).nextElementSibling;
    const pN = $('.wp:not(.sel)', rList).cloneNode(true), pS = $('.wp.sel', rList).cloneNode(true), pRet = $$('.wp', rList).pop().cloneNode(true);
    const actP = $('.act', pN).cloneNode(true), ckP = $('label', pS).cloneNode(true); rList.replaceChildren();
    // 통신이 끊기면: 지금 v2 서버가 실제로 하는 것만(선택 아님)
    const [o1, o2] = $$('label.opt', secL);
    for (const o of [o1, o2]) { const r = $('input', o); r.disabled = true; }
    T($('b', o1), '명령 0 요청 · 잠금'); $('input', o1).checked = true; o1.classList.add('on'); o2.classList.remove('on'); $('input', o2).checked = false;
    $('.lbl', o1).textContent = `현재 v2 서버: ${STOP_FACT[0]} → ${STOP_FACT[1]}. ${STOP_FACT[2]} → ${STOP_FACT[3]}. 선택이 아니라 서버 고정 동작입니다.`;
    const b2 = $('b', o2); for (let n = b2.nextSibling; n && n.nodeName !== 'BR'; n = n.nextSibling) if (n.nodeType === 3) n.textContent = ' · 미연결';
    $('.lbl', o2).textContent = `${WHY['자동 목적지 이동·자동 복귀']} — 자동 후퇴는 실행하지 않습니다.`;
    // 경보 규칙: 미연결 이유를 원본 자리에
    T($('h3 .lbl', secA), '미연결');
    const aOpts = $$('.opt', secA); aOpts.slice(1).forEach((o) => o.remove()); aOpts[0].replaceChildren(el('span', RULE_WHY, { className: 'lbl' }));
    const ruleA = $('a', secA);
    const cH = $('h3 .mono', secC), cList = $('h3', secC).nextElementSibling, ckRow = $('.ck', cList).cloneNode(true); cList.replaceChildren();
    const foot = aside.lastElementChild, [fStats, fBtns, whyS] = kids(foot), [bSave, bStart] = kids(fBtns), fB = $$('b', fStats);
    T(bSave, '계획 저장'); fBtns.after(E.msg);
    bSave.onclick = async () => {
      if (!E.d.name.trim()) { pName.focus(); return toast('계획 이름을 넣으세요'); }
      if (!E.d.wps.length) return toast('지도에서 지점을 1개 이상 찍으세요');
      E.d.wps.forEach((w, i) => { if (!w.name.trim()) w.name = `지점 ${i + 1}`; });
      await E.save();
    };
    bStart.onclick = async () => { const run = activeRun(); if (run) { location.href = 'Main.dc.html?live=v2'; return; } if (await startRun(E.id)) location.href = 'Main.dc.html?live=v2'; };
    const mv = (i, k) => { const w = E.d.wps, j = i + k; if (j < 0 || j >= w.length) return; [w[i], w[j]] = [w[j], w[i]]; wsel = j; E.dirty = true; };
    function wpRow(w, i, cum) {
      const isSel = i === wsel, r = (isSel ? pS : pN).cloneNode(true);
      T($('.num', r), i + 1); T($(':scope > .mono.lbl', r), `${cum.toFixed(1)} m`);
      const nd = $(':scope > div', r);
      if (!isSel) {
        T(nd.children[0], w.name || `지점 ${i + 1}`);
        nd.children[1].replaceChildren(...(w.mods.length ? w.mods : ['이동만']).map((m) => { const a = actP.cloneNode(true); a.textContent = m; return a; }));
        if (zonesAt(w.x, w.y).length) nd.children[1].append(Object.assign(actP.cloneNode(true), { textContent: `▲ ${zoneTxt(w.x, w.y)}` }));
        r.style.cursor = 'pointer'; r.tabIndex = 0; r.onclick = () => { wsel = i; }; r.onkeydown = (e) => { if (e.key === 'Enter') wsel = i; };
        return r;
      }
      const nm = el('input', null, { className: 'inp', value: w.name, maxLength: 40, placeholder: `지점 ${i + 1} 이름` }); nm.setAttribute('aria-label', `지점 ${i + 1} 이름`);
      nm.oninput = () => { w.name = nm.value; E.dirty = true; }; nd.children[0].replaceWith(nm);
      const box = $(':scope > div:last-child', r), rad = box.lastElementChild;
      for (const l of $$(':scope > label', box)) l.remove();
      for (const ty of LIVE_MODS) {
        const l = ckP.cloneNode(true), c = $('input', l); c.checked = w.mods.includes(ty);
        c.onchange = () => { w.mods = LIVE_MODS.filter((t) => (t === ty ? c.checked : w.mods.includes(t))); E.dirty = true; };
        l.replaceChildren(c, ` ${ty} · ${modDetail(E.d.tmpl, ty)}`); rad.before(l);
      }
      for (const [inp, t] of $$('input', rad).map((x, k) => [x, k ? '도착 방향' : '도착 판정 반경'])) { inp.value = '미연결'; inp.readOnly = true; inp.title = `${t} — ${WHY['자동 목적지 이동·자동 복귀']} · 도착은 운영자가 «방문 확인»으로 기록`; }
      const acts = el('div'); acts.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;grid-column:1/-1';
      const sb = (t, fn, lab) => { const b = el('button', t, { className: 'btn sm', type: 'button', onclick: fn }); if (lab) b.setAttribute('aria-label', lab); return b; };
      acts.append(sb('↑', () => mv(i, -1), '위로'), sb('↓', () => mv(i, 1), '아래로'), sb('삭제', () => { E.d.wps.splice(i, 1); wsel = null; E.dirty = true; }), sb('선택 해제', () => { wsel = null; }));
      box.after(acts);
      return r;
    }
    function drawList() {
      const k = JSON.stringify([E.d.wps, E.d.tmpl, wsel, DOCS.rev]);
      if (k === listKey || rList.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return; listKey = k;
      const ws = E.d.wps; let cum = 0;
      rList.replaceChildren(...ws.map((w, i) => { if (i) cum += Math.hypot(w.x - ws[i - 1].x, w.y - ws[i - 1].y); return wpRow(w, i, cum); }));
      if (!ws.length) rList.append(el('span', '«측정 지점 추가» 도구로 지도를 누르면 지점이 생깁니다(30개까지). 끌면 지도 이동.', { className: 'lbl' }));
      else { const r = pRet.cloneNode(true); T(r.children[2], `출발점 복귀 — ${WHY['자동 목적지 이동·자동 복귀'].split(' — ')[0]} · 직접 조종`); T(r.children[3], '—'); rList.append(r); }
    }
    function opts(sel, key, list, val) { if (sel.dataset.k !== key) { sel.dataset.k = key; sel.replaceChildren(...list.map(([v, t]) => el('option', t, { value: v }))); } if (document.activeElement !== sel) sel.value = val; }
    return { paint() {
      paintStatus();
      if (want && E.id !== want && !E.dirty) { const d = docById(want); if (d) { E.load(d); listKey = ''; } }
      const sc = E.stale(); if (sc && !E.dirty) { E.load(sc); listKey = ''; }
      const v = view(), run = activeRun(), ws = E.d.wps, len = legLen(ws);
      hdr(`임무 계획 · ${!E.id ? '새 계획 · 저장 안 됨' : E.dirty ? '저장 안 한 수정 있음' : `저장됨 · 판 ${E.rev}`}`, E.d.name || '새 임무 계획');
      T(pill, run ? `수동 진행 중 · ${run.doc.name}` : '진행 중 임무 없음');
      chip(chips[0], '링크', v.linkTxt, v.linkOk && !st.sim_block);
      chip(chips[1], '위치', fresh() ? 'Gazebo GT(SLAM 아님)' : TRAIL.last ? 'GT 오래됨' : 'GT 미수신', fresh());
      chip(chips[2], '배터리', '미제공', false);
      opts(pSel, `${DOCS.rev}`, [['', '+ 새 계획'], ...docsOf('mission').map((m) => [m.id, `${m.doc.name} · 지점 ${m.doc.wps.length}`])], E.id || '');
      if (document.activeElement !== pName) pName.value = E.d.name;
      opts(tplSel, `${DOCS.rev}`, tmpls().map((t) => [t.id, t.locked ? `${t.name} (기본)` : t.name]), tmplOf(E.d.tmpl).id);
      tplA.href = `PcMissions.dc.html?live=v2&tmpl=${encodeURIComponent(tmplOf(E.d.tmpl).id)}`; ruleA.href = tplA.href;
      T(rH, `${ws.length}개 지점 · ${len.toFixed(1)} m 직선`);
      drawList();
      V.wps = ws; V.hiWp = wsel; V.draft = tool === 'measure' && meas.length ? { type: '측정', pts: meas } : null;
      const inZ = ws.map((w, i) => (zonesAt(w.x, w.y).length ? `WP${i + 1} ${zoneTxt(w.x, w.y)}` : null)).filter(Boolean);
      ov1.lastChild.textContent = '경로 검사 미연결(Nav2) · 거리는 직선'; ov1.firstChild.textContent = '▲'; dotc(ov1.firstChild, 'warn');
      ov2.lastChild.textContent = tool === 'measure' ? (meas.length === 2 ? `거리 재기: 직선 ${Math.hypot(meas[1][0] - meas[0][0], meas[1][1] - meas[0][1]).toFixed(2)} m` : '거리 재기: 지도에서 두 점을 누르세요')
        : inZ.length ? `${inZ.join(' · ')}(구역은 표시만)` : '구역 안 지점 없음';
      ov2.firstChild.textContent = inZ.length && tool !== 'measure' ? '▲' : '●'; dotc(ov2.firstChild, inZ.length && tool !== 'measure' ? 'warn' : 'ok');
      // 출발 전 점검(원본 칸): 막는 것은 «진행 중 임무 없음»·«계획 저장됨»뿐 — 기록을 시작할 뿐 로봇을 움직이지 않음
      const cks = [[v.linkOk && !st.sim_block, `로봇 링크 · ${v.linkTxt}`], [fresh(), `위치 · ${fresh() ? 'Gazebo GT 수신(SLAM 아님)' : TRAIL.last ? 'GT 오래됨' : 'GT 미수신'}`],
        [v.camOk, `영상 · ${v.camTxt}`], [false, '배터리 · 미제공(v2 시뮬 상태에 값 없음)'],
        [!run, run ? `진행 중 수동 임무 «${run.doc.name}» — 먼저 끝내기` : '진행 중 수동 임무 없음', 1],
        [!!(E.id && !E.dirty && ws.length), !E.id ? '계획 저장 · 아직 저장 안 됨' : E.dirty ? '계획 저장 · 저장 안 한 수정 있음' : `계획 저장됨 · 지점 ${ws.length}개`, 1]];
      const ck = JSON.stringify(cks);
      if (cList.dataset.k !== ck) {
        cList.dataset.k = ck;
        cList.replaceChildren(...cks.map(([good, t]) => { const r = ckRow.cloneNode(true), [m, tx, last] = kids(r); m.className = `m ${good ? 'ok' : 'warn'}`; m.textContent = good ? '●' : '▲'; tx.textContent = t; last.replaceWith(el('span')); return r; }));
      }
      T(cH, `${cks.filter((c) => c[0]).length} / ${cks.length}`);
      T(fB[0], '미연결'); fB[0].title = '자동 이동이 없어 시간 예측 미연결'; T(fB[1], `${len.toFixed(1)} m 직선`); T(fB[2], '미제공');
      const block = cks.filter((c) => c[2] && !c[0]).map((c) => c[1]);
      T(bStart, run ? '진행 기록 화면(관제)' : '수동 진행 시작'); bStart.disabled = !run && block.length > 0;
      T(whyS, run ? `▲ 수동 진행 중 — 관제 화면 «임무 단계»·휴대폰 «현황»에서 지점마다 기록` : block.length ? `▲ ${block.join(' · ')}` : '● 로봇은 자동으로 움직이지 않습니다 · 직접 조종하며 지점마다 기록');
    } };
  }

  // ---- 휴대폰 현황: 진행 중 수동 임무 요약·다음 할 일·사진(원본 카드 그대로) ----
  function pageMHome() {
    const root = ROOT(), H = $('header', root), [nameS, linkS] = kids($(':scope > div', H));
    T(nameS, 'Go2 시뮬 · v2');
    const mc = $('section[aria-label="진행 중 임무"]', root), [top, msvg] = kids(mc), [lineD, big, segs, rest] = kids(top), [mline, mtag] = kids(lineD);
    const segP = lift(kids(segs));
    const mm = el('a', null, { href: 'MMap.dc.html?live=v2' }); mm.setAttribute('aria-label', '지도 크게 보기'); mm.style.cssText = 'display:block;position:relative;width:100%;height:132px;border-top:1px solid var(--line)';
    msvg.replaceWith(mm); const V = mapView(mm, { name: 'mhome', small: true });
    const pick = el('select', null, { className: 'lv-inp' }); pick.setAttribute('aria-label', '시작할 계획'); rest.after(pick);
    const tc = $('section[aria-label="다음 지점에서 할 일"]', root), [th, grid, tiles] = kids(tc), [tTitle, tSub] = kids(th);
    const dotP = grid.children[0].cloneNode(true), txtP = grid.children[1].cloneNode(true); grid.replaceChildren();
    const tileP = tiles.children[0].cloneNode(true), camT = tiles.children[2]; camT.setAttribute('role', 'button'); camT.tabIndex = 0; camT.style.cursor = 'pointer';
    const acts = el('div'); tc.append(acts);
    const bar = byText('button', '일시정지', root).parentElement, [pb] = kids(bar), ends = el('div'); bar.after(ends); ends.style.cssText = 'padding:0 14px';
    let endOpen = false, key = '';
    pb.onclick = async () => { const run = activeRun(); if (run) { endOpen = !endOpen; key = ''; return; } await startRun(pick.value); };
    camT.onclick = () => { const run = activeRun(), i = run ? curWp(run.doc) : -1; if (i < 0) return toast('기록 중인 지점이 없습니다'); attachPhoto(run.id, i); };
    return { paint() {
      paintStatus();
      const v = view(), run = activeRun(), R = run && run.doc, ci = R ? curWp(R) : -1, w = ci >= 0 ? R.wps[ci] : null;
      linkS.replaceChildren(el('span', v.linkOk ? '●' : '▲'), ` 링크 ${v.linkTxt} · 배터리 미제공`); dotc(linkS.firstChild, v.linkOk ? 'ok' : 'warn');
      V.wps = R ? R.wps : null;
      const d = w && robotDist(w.x, w.y);
      T(rest, !R ? '계획을 고르고 «수동 진행 시작» — 로봇은 자동으로 움직이지 않습니다' : w ? `다음 지점까지 ${d == null ? '거리 미확인' : `${d.toFixed(1)} m 직선`} · 자동 이동 미연결 · 직접 조종` : '모든 지점 기록됨 · «임무 끝내기»로 완료');
      const k = `${DOCS.rev}|${run && run.rev}|${endOpen}|${MEDIA.ok}`; if (k === key) return; key = k;
      const vis = R ? R.wps.filter((x) => x.st !== '대기').length : 0;
      T(mline, R ? `수동 진행 · ${R.tmpl || '양식 없음'} · ${durTxt(R.started)}` : '진행 중 수동 임무 없음');
      show(mtag, !!R); T(mtag, '수동 진행');
      T(big, R ? `${vis}/${R.wps.length} · ${w ? `${wpName(w, ci)} 기록 차례` : '모든 지점 기록됨'}` : '시작할 계획을 고르세요');
      segs.style.gridTemplateColumns = `repeat(${Math.max(1, R ? R.wps.length : 1)},minmax(0,1fr))`;
      segs.replaceChildren(...(R ? R.wps : []).map((x, i) => { const s = segP.cloneNode(true); s.style.background = `var(--${x.st === '방문' ? 'ok' : x.st === '미방문' ? 'warn' : i === ci ? 'accent' : 'line'})`; return s; }));
      segs.setAttribute('aria-label', R ? `${R.wps.length}지점 중 ${vis}지점 기록` : '진행 중 임무 없음');
      show(pick, !R); const ms = docsOf('mission');
      pick.replaceChildren(...(ms.length ? ms.map((m) => el('option', `${m.doc.name} · 지점 ${m.doc.wps.length}`, { value: m.id })) : [el('option', '저장된 계획 없음 — PC «임무 계획»에서 만들기', { value: '' })]));
      pb.lastChild.textContent = R ? (endOpen ? '임무 끝내기 닫기' : '임무 끝내기…') : '수동 진행 시작'; pb.disabled = !R && !ms.length;
      ends.replaceChildren(...(R && endOpen ? [endRow(run.id)] : []));
      T(tTitle, w ? `${wpName(w, ci)}에서 할 일` : '지점에서 할 일'); T(tSub, R ? `${R.tmpl || '양식'} 모듈 · 운영자 기록` : '진행 중 임무 없음');
      const rowsG = w ? [[w.st !== '대기', '방문 기록 · 운영자가 «방문 확인»(자동 도착 판정 미연결)'], ...w.mods.map((ty) => [modDone(w, ty), modTxt(w, ty)])] : [[false, R ? '대기 지점 없음' : '계획을 고르고 «수동 진행 시작»을 누르면 지점마다 할 일이 여기에 나옵니다']];
      grid.replaceChildren(...rowsG.flatMap(([done, t]) => { const a = dotP.cloneNode(true), b = txtP.cloneNode(true); a.style.borderColor = `var(--${done ? 'ok' : 'line2'})`; a.style.background = done ? 'var(--ok)' : ''; b.textContent = t; return [a, b]; }));
      show(tiles, !!w);
      tiles.replaceChildren(...(w ? w.photos.slice(-2) : []).map((u) => { const t = tileP.cloneNode(true); t.style.overflow = 'hidden'; const a = el('a', null, { href: `MFinding.dc.html?live=v2&url=${encodeURIComponent(u)}` }); a.append(el('img', null, { src: u, alt: '붙인 사진', loading: 'lazy', style: 'width:100%;height:100%;object-fit:cover;display:block' })); t.append(a); return t; }), camT);
      T(camT, w ? `📷 ${wpName(w, ci).split(' ')[0]} 사진` : '');
      acts.replaceChildren(...(w ? [wpActs(run.id, ci, w)] : []));
    } };
  }

  // ---- 휴대폰 지도: 지점 고르기 → 계획에 지점 추가(이동은 미연결) ----
  function pageMMap() {
    const root = ROOT(), H = $('header', root), [tt, tl] = kids($(':scope > div', H)), layer = $('button[aria-label="지도 레이어"]', H);
    T(tt, '지도');
    const svg = $(':scope > div > svg', root), box = svg.parentElement; svg.style.visibility = 'hidden';
    let sel = null;
    const V = mapView(box, { name: 'mmap', onTap: (x, y) => { sel = [r2(x), r2(y)]; V.sel = sel; } });
    const [fRobot, fIn, fOut] = $$('button.fab', box);
    V.btn.robot = fRobot; fRobot.onclick = () => V.setMode('robot'); fIn.onclick = () => V.zoomBy(1.5); fOut.onclick = () => V.zoomBy(1 / 1.5);
    layer.setAttribute('aria-label', '지도 보기·레이어');
    layer.onclick = () => openDrawer('지도 보기', (b) => {
      const B = (t, fn) => el('button', t, { className: 'lv-btn', type: 'button', onclick: () => { fn(); b.replaceChildren(); drawer.paint(); } });
      if (b.firstChild) return;
      b.append(B(`보기: ${MODE_KO[V.mode]} → ${V.mode === 'all' ? '로봇 중심' : '전체 보기'}`, () => V.setMode(V.mode === 'all' ? 'robot' : 'all')),
        B(`지나온 길 ${V.showTrail ? '숨기기' : '보이기'}`, () => { V.showTrail = !V.showTrail; V.draw(); }),
        B(`구역 ${V.showZones ? '숨기기' : '보이기'}`, () => { V.showZones = !V.showZones; V.draw(); }),
        el('p', `시뮬 바닥 도면 ±10 m · Gazebo GT 위치(SLAM 지도 아님). ${ZONE_NOTE}`, { className: 'lv-note' }));
    });
    const hint = $(':scope > span', box);
    const sec = $('section[aria-label="고른 목표"]', root), [d1, d2, d3, lbl] = kids(sec), [nb, xy] = kids(d1), [s1, s2, s3] = kids(d2), [cancel, go] = kids(d3);
    T($('b', s2), '미연결'); s2.title = '자동 이동이 없어 시간 예측 미연결';
    s3.replaceChildren(el('span', '▲'), ' 경로 검사 미연결 · 직선 거리'); dotc(s3.firstChild, 'warn');
    cancel.onclick = () => { sel = null; V.sel = null; paint(); }; why(go, GOTO_WHY);
    const ms = el('select', null, { className: 'lv-inp' }); ms.setAttribute('aria-label', '지점을 넣을 계획');
    const addRow = el('div', null, { className: 'lv-row' }); addRow.append(ms, btn('계획에 지점 추가', async () => {
      if (!sel) return;
      const d = docById(ms.value), w = { x: sel[0], y: sel[1], name: '', mods: defMods(d ? d.doc.tmpl : 'base') };
      if (d && d.doc.wps.length >= 30) return toast('지점은 30개까지');
      const doc = d ? structuredClone(d.doc) : { name: `휴대폰 계획 ${hms(new Date()).slice(0, 5)}`, tmpl: 'base', memo: '', wps: [] };
      w.name = `지점 ${doc.wps.length + 1}`; doc.wps.push(w);
      const r = await saveDoc(d ? { op: 'put', id: d.id, rev: d.rev, doc } : { op: 'put', kind: 'mission', id: null, doc });
      toast(r.ok ? `«${doc.name}»에 ${w.name} 추가 · 모든 기기 공유` : r.code === 409 ? '다른 기기가 먼저 고침 — 다시 눌러 주세요' : `저장 안 됨 · ${r.error}`);
    }, 'pri')); lbl.before(addRow);
    return { paint() {
      paintStatus();
      const s = view().s;
      T(tl, `시뮬 바닥 ±10 m · ${fresh() ? 'GT 위치 수신' : TRAIL.last ? 'GT 오래됨' : 'GT 미수신'}(SLAM 아님)`);
      T(hint, sel ? `고른 지점 · ${zoneTxt(sel[0], sel[1])}` : '지도를 눌러 지점을 고르세요');
      T(nb, sel ? '고른 지점' : '고른 지점 없음');
      T(xy, sel ? `x ${sgn(sel[0])} · y ${sgn(sel[1])} m` : s ? `로봇 GT ${posTxt(s.x, s.y)}` : '로봇 위치 없음(GT 미수신)');
      const d = sel && robotDist(sel[0], sel[1]); T($('b', s1), sel ? (d == null ? '미확인' : `${d.toFixed(1)} m`) : '—');
      cancel.disabled = !sel; show(addRow, !!sel);
      const k = `${DOCS.rev}`; if (ms.dataset.k !== k) { ms.dataset.k = k; ms.replaceChildren(el('option', '+ 새 계획으로', { value: '' }), ...docsOf('mission').map((m) => el('option', `${m.doc.name} · 지점 ${m.doc.wps.length}`, { value: m.id }))); }
    } };
  }

  // ---- 사진 분류(관찰) 공용: 확인·보류·제외 + 메모 ----
  const clsLv = (n) => (!n ? 'acc' : n.doc.cls === '확인' ? 'ok' : n.doc.cls === '제외' ? 'off' : 'warn');
  const runsOf = (url) => docsOf('run').flatMap((r) => r.doc.wps.map((w, i) => (w.photos.includes(url) ? `«${r.doc.name}» ${wpName(w, i)}` : null)).filter(Boolean));
  const nearOf = (p) => (p.x == null ? [] : MEDIA.photos.filter((q) => q !== p && q.x != null && Math.hypot(q.x - p.x, q.y - p.y) < 1));
  function noteEd(p, rebuild) { const E = editor('note', rebuild); E.load(noteOf(p.url) || null, { photo: p.url, cls: '보류', memo: '' }); return E; }
  const tagMemo = (memo, t) => { const a = memo.split(' · ').filter(Boolean); return (a.includes(t) ? a.filter((x) => x !== t) : [...a, t]).join(' · ').slice(0, 400); };
  function photoImg(svg, css) { const im = el('img', null, { alt: '' }); im.style.cssText = `display:block;width:100%;object-fit:contain;background:#05080A;${css}`; svg.replaceWith(im); return im; }

  // ---- 휴대폰 관찰 사진(원본 «발견물 확인» 틀) ----
  function pageMFinding() {
    const root = ROOT(), H = $('header', root), [, ttl, cnt] = kids(H);
    T(ttl, '관찰 사진');
    let url = Q.get('url'), E = null, key = '';
    const go = (k) => { const ps = MEDIA.photos; if (!ps.length) return; if (E && E.dirty && !confirm('저장 안 한 메모가 있습니다. 버릴까요?')) return; const i = Math.max(0, ps.findIndex((p) => p.url === url)); url = ps[(i + k + ps.length) % ps.length].url; E = null; };
    const prev = btn('‹', () => go(1)), next = btn('›', () => go(-1)); prev.setAttribute('aria-label', '이전(더 오래된) 사진'); next.setAttribute('aria-label', '다음(더 최근) 사진'); cnt.before(prev); cnt.after(next);
    const body = H.nextElementSibling, [fig, head, dl, memoBox, judge] = kids(body);
    const img = photoImg($('svg', fig), 'aspect-ratio:16/9;border-radius:inherit'), cap = $(':scope > span', fig);
    const [hd, hlbl] = kids(head), [hdot, hname, hconf] = kids(hd); hconf.style.display = 'none'; T(hlbl, OBS_NOTE);
    const dts = $$('dt', dl), dds = $$('dd', dl); T(dts[0], '임무 지점'); T(dts[1], 'GT 위치'); T(dts[2], '같은 위치');
    const tags = $$('button.tag', memoBox), memoT = el('span', null, { className: 'lbl' }); memoBox.append(memoT, (E && E.msg) || el('span'));
    const [okB, r2b] = kids(judge), [noB, laterB] = kids(r2b); T(okB, '확인 · 기록에 남김'); T(noB, '제외'); T(laterB, '보류');
    const setCls = (c) => { if (!E) return; E.d.cls = c; E.dirty = true; E.save(); };
    okB.onclick = () => setCls('확인'); noB.onclick = () => setCls('제외'); laterB.onclick = () => setCls('보류');
    tags.forEach((t, i) => { t.onclick = () => { if (!E) return; if (i === tags.length - 1) { const y = prompt('메모(무엇을 봤는지·조치)', E.d.memo); if (y == null) return; E.d.memo = y.trim().slice(0, 400); } else E.d.memo = tagMemo(E.d.memo, t.textContent.trim()); E.dirty = true; E.save(); }; });
    return { paint() {
      paintStatus();
      const ps = MEDIA.photos, i = Math.max(0, ps.findIndex((p) => p.url === url)), p = ps[i], n = p && noteOf(p.url);
      const k = `${MEDIA.ok}|${p && p.url}|${n && n.rev}|${ps.length}|${DOCS.rev}`; if (k === key || (E && E.dirty)) return; key = k;
      for (const b of [prev, next, okB, noB, laterB, ...tags]) b.disabled = !p;
      T(cnt, p ? `${i + 1} / ${ps.length}` : '0 / 0');
      if (!p) { show(img, false); T(cap, MEDIA.ok ? '사진 없음 — 조종 화면·현황의 📷 로 찍은 사진이 여기 쌓입니다(서버 저장 · 모든 기기 공통)' : MEDIA.err || '서버 기록 읽는 중…'); T(hname, '—'); for (const d of dds) T(d, '—'); T(memoT, ''); return; }
      url = p.url; E = noteEd(p, () => { key = ''; }); memoT.replaceChildren(el('span', `메모: ${E.d.memo || '없음'}${n ? ` · ${n.by} · ${fmtT(n.at)}` : ''}`), E.msg);
      show(img, true); img.src = p.url; img.alt = `관찰 사진 ${fmtT(p.frame_at)}`;
      T(cap, `Gazebo 렌더(실카메라 아님) · 프레임 수신 ${fmtT(p.frame_at)} · episode ${p.episode}`);
      T(hname, n ? `분류: ${n.doc.cls}` : '미분류 관찰'); dotc(hdot, clsLv(n)); hdot.style.background = `var(--${clsLv(n) === 'acc' ? 'accent' : clsLv(n) === 'off' ? 'muted' : clsLv(n)})`;
      const rs = runsOf(p.url); T(dds[0], rs.length ? rs.join(', ') : '임무 지점에 붙지 않음');
      T(dds[1], p.x == null ? '위치 미확인' : `${posTxt(p.x, p.y)} · ${deg(p.yaw)} (저장 요청 때 최신 GT · 프레임 동기 아님)`);
      const nr = nearOf(p); T(dds[2], p.x == null ? '비교 불가(위치 없음)' : `반경 1 m 안 다른 사진 ${nr.length}장`);
      for (const t of tags.slice(0, -1)) t.setAttribute('aria-pressed', String(E.d.memo.split(' · ').includes(t.textContent.trim())));
      for (const [b, c] of [[okB, '확인'], [noB, '제외'], [laterB, '보류']]) b.setAttribute('aria-pressed', String(!!n && n.doc.cls === c));
    } };
  }

  // ---- 기록 공용 행: 수동 임무·관찰 사진·서버 사건 ----
  function histRows() {
    const rows = [];
    for (const e of MEDIA.events) if (e.st !== 'ok') rows.push({ at: e.at, kind: '사건', lvl: e.st, title: e.text, res: { bad: '위험', warn: '경고', ok: '정보' }[e.st] || e.st, sub: '서버 사건 원문', by: '서버', href: `MAlert.dc.html?live=v2&at=${encodeURIComponent(e.at)}&t=${encodeURIComponent(e.text)}` });
    for (const p of MEDIA.photos) { const n = noteOf(p.url); rows.push({ at: p.saved_at, kind: '사진', lvl: n ? (n.doc.cls === '확인' ? 'ok' : 'warn') : 'warn', title: '관찰 사진', res: n ? n.doc.cls : '미분류', wait: !n, sub: posTxt(p.x, p.y), by: p.by, extra: n && n.doc.memo, url: p.url, href: `${PCP ? 'PcReview' : 'MFinding'}.dc.html?live=v2&url=${encodeURIComponent(p.url)}` }); }
    for (const d of docsOf('run')) {
      const r = d.doc, v = r.wps.filter((w) => w.st === '방문').length, ph = r.wps.reduce((a, w) => a + w.photos.length, 0);
      rows.push({ at: r.started || d.at, kind: '임무', lvl: r.status === '완료' ? 'ok' : r.status === '진행' ? 'warn' : 'bad', title: r.name, res: r.status === '진행' ? '진행(수동)' : r.status, st: r.status, tmpl: r.tmpl, wait: r.status === '진행',
        sub: `${r.tmpl || '양식 없음'} · 방문 ${v}/${r.wps.length} · ${durTxt(r.started, r.ended)}`, by: d.by, dur: durTxt(r.started, r.ended), pts: `${v}/${r.wps.length}`, photos: ph, extra: r.memo, run: d.id, href: `Report.dc.html?live=v2&run=${d.id}` });
    }
    return rows.sort((a, b) => tms(b.at) - tms(a.at));
  }
  const csvOf = (head, rows) => [head.join(','), ...rows.map((r) => r.map((v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))).join(','))].join('\n');
  const histCSV = (rs = histRows()) => csvOf(['at', 'kind', 'level', 'title', 'result', 'detail', 'by', 'photo'], rs.map((r) => [r.at, r.kind, r.lvl, r.title, r.res, r.sub, r.by, r.url]));
  const LV = { ok: '●', warn: '▲', bad: '■' };
  const dayTxt = (at) => { const d = new Date(tms(at)), t = new Date(); const s = `${d.getMonth() + 1}월 ${d.getDate()}일`; return d.toDateString() === t.toDateString() ? `오늘 · ${s}` : s; };

  // ---- 휴대폰 기록(원본 거르기 칩·날짜 묶음·항목) ----
  function pageMHistory() {
    const root = ROOT(), H = $('header', root), [hd, chipsG] = kids(H), cntL = hd.children[1];
    const FL = ['전체', '수동 임무', '경보 · 중단', '확인 대기'], FN = [() => true, (r) => r.kind === '임무', (r) => (r.kind === '사건' && r.lvl !== 'ok') || (r.kind === '임무' && /실패|중단/.test(r.st)), (r) => r.wait];
    let filt = 0, key = '';
    const chips = $$('button.chip', chipsG); chips.forEach((c, i) => { T(c, FL[i]); c.onclick = () => { filt = i; }; });
    const list = H.nextElementSibling, dayP = lift($$('.day', list)), itP = lift($$('a.it', list));
    return { paint() {
      paintStatus();
      chips.forEach((c, i) => c.setAttribute('aria-pressed', String(i === filt)));
      const k = `${MEDIA.ok}|${filt}|${MEDIA.events.length}|${MEDIA.photos.length}|${DOCS.rev}|${(MEDIA.events[0] || {}).at}`; if (k === key) return; key = k;
      if (!MEDIA.ok) { list.replaceChildren(el('span', MEDIA.err || '서버 기록 읽는 중…', { className: 'day' })); return; }
      const rs = histRows().filter(FN[filt]);
      T(cntL, `서버 보관 · ${rs.length}건`);
      let day = null; const out = [];
      for (const r of rs.slice(0, 200)) {
        const dt = dayTxt(r.at); if (dt !== day) { day = dt; const d = dayP.cloneNode(true); d.textContent = dt; out.push(d); }
        const a = itP.cloneNode(true), [b, res, sub, , ex] = kids(a); a.href = r.href;
        b.textContent = r.title; res.className = `res ${r.lvl}`; res.textContent = `${LV[r.lvl] || '·'} ${r.res}`;
        sub.textContent = `${r.kind} · ${r.sub} · ${r.by || ''} · ${fmtT(r.at)}`;
        if (r.extra) { ex.textContent = r.extra; ex.className = 'lbl'; } else { a.lastElementChild.remove(); ex.remove(); }
        out.push(a);
      }
      if (!rs.length) out.push(el('span', '해당 기록 없음', { className: 'day' }));
      list.replaceChildren(...out);
    } };
  }

  // ---- 휴대폰 알림(원본 묶음·항목 틀): 지금 할 일 + 서버 경보 사건 ----
  function pageMAlerts() {
    const root = ROOT(), H = $('header', root), readB = $('button', H);
    const list = H.nextElementSibling, grpP = lift($$('.grp', list)), nP = lift($$('a.n', list));
    const [fl] = kids(list.nextElementSibling); T(fl, '읽음 표시는 이 기기에만 저장 · 잠금 화면·푸시 알림 미연결(화면이 켜져 있어야 함)');
    let key = '';
    readB.onclick = () => { const a = alertsOf()[0]; store.set('fh.live.alerts.read', a ? a.at : ''); key = ''; };
    const item = (ic, lv, title, sub, time, href, unread) => {
      const a = nP.cloneNode(true), [i, mid, rt] = kids(a); a.href = href; a.classList.toggle('unread', !!unread);
      i.className = `ic ${lv}`; i.textContent = ic; mid.children[0].textContent = title; mid.children[1].textContent = sub;
      rt.children[0].textContent = time; if (rt.children[1]) rt.children[1].style.visibility = unread ? '' : 'hidden'; return a;
    };
    const ago = (at) => { const m = Math.round((Date.now() - tms(at)) / 60000); return m < 1 ? '방금' : m < 60 ? `${m}분 전` : fmtT(at).slice(0, 11); };
    return { paint() {
      paintStatus();
      const rd = store.get('fh.live.alerts.read', ''), al = alertsOf(), run = activeRun(), wait = MEDIA.photos.filter((p) => !noteOf(p.url)).length;
      const k = `${MEDIA.ok}|${al.length}|${(al[0] || {}).at}|${rd}|${DOCS.rev}|${wait}`; if (k === key) return; key = k;
      const out = [], g = (t) => { const x = grpP.cloneNode(true); x.textContent = t; out.push(x); };
      if (run || wait) {
        g('지금 할 일');
        if (wait) out.push(item('✓', 'acc', `관찰 사진 분류 대기 ${wait}장`, '확인·보류·제외 + 메모(운영자)', '', 'MFinding.dc.html?live=v2', true));
        if (run) { const v = run.doc.wps.filter((w) => w.st !== '대기').length; out.push(item('●', 'acc', `수동 임무 진행 중 · «${run.doc.name}»`, `지점 기록 ${v}/${run.doc.wps.length} · 직접 조종`, ago(run.doc.started), 'MHome.dc.html?live=v2', false)); }
      }
      if (!MEDIA.ok) { g(MEDIA.err || '서버 기록 읽는 중…'); }
      else if (!al.length) g('경보 사건 없음(서버 최근 300건 중)');
      else {
        const now = Date.now(); let grp = null;
        for (const e of al.slice(0, 150)) {
          const gn = now - tms(e.at) < 3600e3 ? '경보 · 최근 1시간' : '경보 · 이전'; if (gn !== grp) { grp = gn; g(gn); }
          out.push(item(LV[e.st], e.st, e.text, '서버 사건 원문 · 원인 판단 없음', ago(e.at), `MAlert.dc.html?live=v2&at=${encodeURIComponent(e.at)}&t=${encodeURIComponent(e.text)}`, !rd || tms(e.at) > tms(rd)));
        }
      }
      list.replaceChildren(...out);
    } };
  }

  // ---- 휴대폰 알림 상세(원본 경보 틀): 서버 사건 원문 + 지금 할 수 있는 조치 ----
  function pageMAlert() {
    const root = ROOT(), al = $('section[role="alert"]', root), [aTop, aTitle, aVal, aSub] = kids(al), [aLv, aTime] = kids(aTop);
    const did = $('section[aria-label="로봇이 한 일"]', root), rowP = lift($$('.row', did)), dLbl = $(':scope > span.lbl', did);
    const trend = $('section[aria-label="H2S 추이"]', root), [trH] = kids(trend), tsvg = $('svg', trend);
    const near = el('div'); near.style.cssText = 'display:flex;flex-direction:column;gap:4px'; tsvg.replaceWith(near);
    const btns = trend.nextElementSibling, [bOk, mid, bShare] = kids(btns), [bStop] = kids(mid);
    T(bOk, '확인(읽음 표시)'); T(bStop, 'STOP(명령 0 요청·잠금)'); T(bShare, '현장 책임자에게 경보 공유');
    bOk.onclick = () => { const e = find(); if (e && tms(e.at) > tms(store.get('fh.live.alerts.read', ''))) store.set('fh.live.alerts.read', e.at); location.href = 'MAlerts.dc.html?live=v2'; };
    stopBtn(bStop); why(bShare, '경보 공유 미연결 — 외부 알림·메시지 발송 없음');
    aVal.style.display = 'none'; T(trH.children[0], '앞뒤 2분 서버 사건'); T(trH.children[1], '같은 시각 근처 원문');
    const find = () => MEDIA.events.find((x) => x.at === Q.get('at') && x.text === Q.get('t'));
    let key = '';
    return { paint() {
      paintStatus();
      const v = view(), e = find(), k = `${MEDIA.ok}|${MEDIA.events.length}|${v.latch}|${role}`; if (k === key) return; key = k;
      if (!e) { const none = !Q.get('at'); T(aLv, !MEDIA.ok ? '읽는 중…' : none ? '고른 경보 없음' : '사건을 찾지 못함'); T(aTime, ''); T(aTitle, !MEDIA.ok ? MEDIA.err || '' : none ? '알림 목록에서 경보를 고르세요' : '서버 최근 300건 밖이거나 주소가 틀렸습니다'); T(aSub, ''); }
      else {
        T(aLv, `${LV[e.st] || '·'} ${{ bad: '위험', warn: '경고' }[e.st] || e.st}`); T(aTime, fmtT(e.at)); T(aTitle, e.text); T(aSub, '서버 사건 원문 · Go2 시뮬(foothold-v2) · 원인 판단은 포함하지 않음');
        const nr = MEDIA.events.filter((x) => x !== e && Math.abs(tms(x.at) - tms(e.at)) < 120e3).slice(0, 20);
        near.replaceChildren(...(nr.length ? nr.map((x) => el('span', `${fmtT(x.at)} ${LV[x.st] || '·'} ${x.text}`, { className: 'lbl' })) : [el('span', '앞뒤 2분 안 다른 사건 없음', { className: 'lbl' })]));
      }
      const rows = [[v.latch ? '✓' : '·', LATCH_TXT(v), v.linkOk ? '지금' : '링크 끊김'], ['·', `서버 정지: ${STOP_FACT[0]} → 명령 0`, '항상'], ['·', `자동 후퇴·자동 조치 — ${WHY['자동 목적지 이동·자동 복귀'].split(' — ')[0]}`, '실행 안 함']];
      did.querySelectorAll('.row').forEach((r) => r.remove());
      dLbl.before(...rows.map(([a, b, c]) => { const r = rowP.cloneNode(true), [x, y, z] = kids(r); x.textContent = a; y.textContent = b; z.textContent = c; return r; }));
      T(did.firstElementChild, '지금 서버·로봇 상태');
      T(dLbl, '이 앱에서 지금 할 수 있는 조치: STOP · 직접 조종. 자동 규칙에 따른 조치는 미연결입니다.');
    } };
  }

  // ---- PC 기록(원본 요약 카드·검색줄·표·쪽 넘김) ----
  function pagePcHistory() {
    const root = ROOT();
    hdr('기록', '임무 기록 · 관찰 사진 · 서버 사건');
    const stats = $$('section[aria-label="요약"] > .card', root);
    const lsec = $('section[aria-label="기록 목록"]', root), q = $('input', lsec), [sPer, sTpl, sRes, sBy] = $$('select', lsec), exB = $('button.btn', lsec);
    q.placeholder = '임무 이름 · 내용 · 메모'; q.setAttribute('aria-label', '기록 검색');
    sPer.replaceChildren(...['최근 30일', '오늘', '최근 7일', '전체'].map((t) => el('option', t)));
    sRes.replaceChildren(...['모든 결과', '완료', '진행', '실패 · 중단', '경고 · 위험 사건', '관찰 사진'].map((t) => el('option', t)));
    T(exB, '보이는 기록 내보내기 (CSV)');
    const tb = $('tbody', lsec), trP = lift($$('tr', tb)), [pgL, pgBox] = kids(lsec.lastElementChild), pgP = lift($$('button', pgBox));
    T($$('thead th', lsec).pop(), '보고서');
    let page = 0, key = '', rows = [];
    for (const x of [q, sPer, sTpl, sRes, sBy]) x.addEventListener(x === q ? 'input' : 'change', () => { page = 0; key = ''; });
    exB.onclick = () => save(`foothold-v2-history-${Date.now()}.csv`, new Blob([histCSV(rows)], { type: 'text/csv' }));
    const RF = { '완료': (r) => r.st === '완료', '진행': (r) => r.st === '진행', '실패 · 중단': (r) => /실패|중단/.test(r.st || ''), '경고 · 위험 사건': (r) => r.kind === '사건' && r.lvl !== 'ok', '관찰 사진': (r) => r.kind === '사진' };
    const PER = { '오늘': 1, '최근 7일': 7, '최근 30일': 30 };
    const sopt = (s, first, vals) => { const k = vals.join('|'); if (s.dataset.k === k) return; s.dataset.k = k; const v = s.value; s.replaceChildren(el('option', first, { value: '' }), ...vals.map((x) => el('option', x, { value: x }))); s.value = vals.includes(v) ? v : ''; };
    const stat = (c, lab, big, sub) => { const [a, b, x] = kids(c); T(a, lab); T(b, big); if (x.tagName === 'A') { x.textContent = sub; x.href = 'PcReview.dc.html?live=v2'; } else T(x, sub); };
    return { paint() {
      paintStatus();
      const all = histRows(), runs = all.filter((r) => r.kind === '임무'), ph = all.filter((r) => r.kind === '사진'), al = alertsOf();
      sopt(sTpl, '모든 양식', [...new Set(runs.map((r) => r.tmpl).filter(Boolean))]); sopt(sBy, '모든 운영자', [...new Set(all.map((r) => r.by).filter(Boolean))]);
      const k = `${MEDIA.ok}|${DOCS.rev}|${all.length}|${(all[0] || {}).at}|${q.value}|${sPer.value}|${sTpl.value}|${sRes.value}|${sBy.value}|${page}`; if (k === key) return; key = k;
      const cnt = (f) => runs.filter(f).length;
      stat(stats[0], '수동 임무 진행', String(runs.length), `완료 ${cnt((r) => r.st === '완료')} · 실패·중단 ${cnt((r) => /실패|중단/.test(r.st))} · 진행 ${cnt((r) => r.st === '진행')}`);
      stat(stats[1], '경보 사건(서버 최근 300)', String(al.length), '자동 경보 규칙 미연결 · 사건 원문');
      stat(stats[2], '관찰 사진 분류 대기', String(ph.filter((r) => r.wait).length), '지금 분류 →');
      stat(stats[3], '관찰 사진', String(ph.length), ['확인', '보류', '제외'].map((c) => `${c} ${ph.filter((r) => r.res === c).length}`).join(' · '));
      const days = PER[sPer.value], qq = q.value.trim();
      rows = all.filter((r) => (!days || Date.now() - tms(r.at) < days * 864e5) && (!sTpl.value || r.tmpl === sTpl.value) && (!sBy.value || r.by === sBy.value)
        && (!RF[sRes.value] || RF[sRes.value](r)) && (!qq || `${r.title} ${r.sub} ${r.extra || ''}`.includes(qq)));
      const N = 20, pages = Math.max(1, Math.ceil(rows.length / N)); page = Math.min(page, pages - 1);
      if (!MEDIA.ok) tb.replaceChildren(el('tr', null));
      tb.replaceChildren(...rows.slice(page * N, page * N + N).map((r) => {
        const tr = trP.cloneNode(true), td = kids(tr);
        const vals = [fmtT(r.at).slice(0, 11), null, r.kind === '임무' ? (r.tmpl || '—') : r.kind === '사진' ? '관찰 사진' : '서버 사건', r.kind === '사진' ? r.sub : '시뮬 바닥(±10 m)', r.by || '—', r.dur || '—', r.pts || '—', null, r.kind === '임무' ? String(r.photos) : r.kind === '사진' ? '1' : '—', null];
        vals.forEach((x, i) => { if (x != null) td[i].textContent = x; });
        const a = $('a', td[1]); a.textContent = r.title; a.href = r.href;
        const res = $('.res', td[7]); res.className = `res ${r.lvl}`; res.textContent = `${LV[r.lvl] || '·'} ${r.res}`;
        const ra = $('a', td[9]); if (r.run) { ra.href = r.href; ra.textContent = '보고서'; } else ra.replaceWith('—');
        return tr;
      }));
      if (!rows.length) { const tr = el('tr'), td = el('td', MEDIA.ok ? '해당 기록 없음' : MEDIA.err || '서버 기록 읽는 중…'); td.colSpan = 10; tr.append(td); tb.append(tr); }
      T(pgL, `${rows.length}건 중 ${rows.length ? page * N + 1 : 0}–${Math.min(rows.length, page * N + N)} · 서버 보관: 사건 최근 300 · 사진 최근 200 · 임무 진행 전부`);
      const b = (t, p, lab, cur) => { const x = pgP.cloneNode(true); x.textContent = t; x.disabled = p < 0 || p >= pages; x.removeAttribute('aria-current'); if (cur) x.setAttribute('aria-current', 'page'); if (lab) x.setAttribute('aria-label', lab); else x.removeAttribute('aria-label'); x.onclick = () => { page = p; }; return x; };
      const s0 = Math.max(0, Math.min(page - 2, pages - 5));
      pgBox.replaceChildren(b('‹', page - 1, '이전 쪽'), ...Array.from({ length: Math.min(5, pages) }, (_, i) => b(String(s0 + i + 1), s0 + i, null, s0 + i === page)), b('›', page + 1, '다음 쪽'));
    } };
  }

  // ---- PC 사진 검토(원본 판정 요약·목록·선택 카드·측정 기록 자리) ----
  function pagePcReview() {
    const root = ROOT();
    let url = Q.get('url'), filt = '전체', E = null, key = '';
    const runId = Q.get('run');
    const sum = $('section[aria-label="판정 요약"]', root), [sHead, sStats, , sBtns] = kids(sum), [sL, sBig, sDesc] = kids(sHead), statC = kids(sStats);
    const [csvB, repA] = kids(sBtns); T(csvB, '사진 정보 내려받기 (CSV)'); T(repA, '수동 임무 보고서');
    csvB.onclick = () => save(`foothold-v2-photos-${Date.now()}.csv`, new Blob([csvOf(['saved_at', 'frame_at', 'episode', 'x', 'y', 'yaw', 'by', 'cls', 'memo', 'url'], MEDIA.photos.map((p) => { const n = noteOf(p.url); return [p.saved_at, p.frame_at, p.episode, p.x, p.y, p.yaw, p.by, n ? n.doc.cls : '미분류', n ? n.doc.memo : '', p.url]; }))], { type: 'text/csv' }));
    const ls = $('section[aria-label="발견물 목록"]', root), [lh, tabsG] = kids(ls), tabs = $$('button.tab', tabsG), fdP = lift($$('button.fd', ls));
    T(lh.children[0], '관찰 사진'); T(lh.children[1], 'AI 탐지 미연결 · 운영자가 찍은 관찰');
    const t5 = tabs[0].cloneNode(true); tabsG.append(t5); const TABS = ['전체', '미분류', '확인', '보류', '제외'], tabEls = [...tabs, t5];
    tabEls.forEach((t, i) => { t.onclick = () => { filt = TABS[i]; key = ''; }; });
    const fbox = el('div'); fbox.style.cssText = 'display:flex;flex-direction:column;gap:inherit;max-height:640px;overflow:auto'; ls.append(fbox);
    const sc = $('section[aria-label="선택한 발견물"]', root), [scH, figs, judge, memoD, rew] = kids(sc), [scT, scB, scL] = kids(scH);
    const [f1, f2] = kids(figs), im1 = photoImg($('svg', f1), 'aspect-ratio:16/9;border-radius:8px'), im2 = photoImg($('svg', f2), 'aspect-ratio:16/9;border-radius:8px'), c1 = $('figcaption', f1), c2 = $('figcaption', f2);
    const [jOk, jNo, jLater] = kids(judge); T(jOk, '확인 · 기록에 남김'); T(jNo, '제외'); T(jLater, '보류 · 다음에 다시 보기');
    const memo = $('#memo', memoD); memo.maxLength = 400; memo.placeholder = '무엇을 봤는지·조치'; T($('label', memoD), '메모 · 보고서에 함께 실립니다(모든 기기 공유)');
    memo.oninput = () => { if (E) { E.d.memo = memo.value; E.dirty = true; } }; memo.onchange = () => { if (E && E.dirty) E.save(); };
    const msgBox = el('div'); memoD.append(msgBox);
    for (const [b, c] of [[jOk, '확인'], [jNo, '제외'], [jLater, '보류']]) b.onclick = () => { if (!E) return; E.d.cls = c; E.d.memo = memo.value; E.dirty = true; E.save(); };
    T(rew.firstElementChild.children[0], '임무 되감기 — 미연결(주행 영상·기록 재생 없음)'); T(rew.firstElementChild.children[1], ''); rew.lastElementChild.style.display = 'none';
    const ms = $('section[aria-label="측정 기록"]', root); T(ms.firstElementChild.children[1], `미제공 — ${WHY['가스·측정값·통신 품질'].split(' — ')[1] || '현재 v2 연결에 측정값 없음'}`);
    const mtb = $('tbody', ms), mtr = el('tr'), mtd = el('td', '측정값 미제공 — 현재 v2 연결에 가스·측정값이 없어 표를 채우지 않습니다', { className: 'lbl' }); mtd.colSpan = 8; mtr.append(mtd); mtb.replaceChildren(mtr);
    const pick = (u) => { if (E && E.dirty && !confirm('저장 안 한 메모가 있습니다. 버릴까요?')) return; url = u; E = null; key = ''; };
    const badge = (b, n) => { b.className = `badge ${!n ? 'b-wait' : n.doc.cls === '확인' ? 'b-ok' : n.doc.cls === '제외' ? 'b-no' : 'b-wait'}`; b.textContent = n ? n.doc.cls : '미분류'; };
    return { paint() {
      paintStatus();
      const run = runId && docById(runId), R = run && run.doc, inRun = R ? new Set(R.wps.flatMap((w) => w.photos)) : null;
      const base = MEDIA.photos.filter((p) => !inRun || inRun.has(p.url)), cnt = (c) => base.filter((p) => { const n = noteOf(p.url); return c === '전체' || (c === '미분류' ? !n : n && n.doc.cls === c); }).length;
      const ps = base.filter((p) => { const n = noteOf(p.url); return filt === '전체' || (filt === '미분류' ? !n : n && n.doc.cls === filt); });
      if (!url && ps[0]) url = ps[0].url;
      const p = MEDIA.photos.find((x) => x.url === url), n = p && noteOf(p.url);
      const k = `${MEDIA.ok}|${filt}|${url}|${DOCS.rev}|${MEDIA.photos.length}`; if (k === key || (E && E.dirty)) return; key = k;
      hdr('사진 검토', R ? `수동 임무 «${R.name}» 관찰 사진` : '관찰 사진 · 운영자 등록');
      T(sL, R ? `수동 임무 · 양식: ${R.tmpl || '—'} · ${R.status}` : '관찰 사진 검토 · 전체');
      T(sBig, `${LV.warn} 분류 대기 ${cnt('미분류')}장`); T(sDesc, OBS_NOTE);
      const sv = [['소요', R ? durTxt(R.started, R.ended) : '—'], ['지점 방문', R ? `${R.wps.filter((w) => w.st === '방문').length} / ${R.wps.length}` : '—'], ['관찰 사진', String(base.length)], ['확인', String(cnt('확인'))], ['경보 사건', String(alertsOf().length)]];
      statC.forEach((c, i) => { T(c.children[0], sv[i][0]); T(c.children[1], sv[i][1]); });
      repA.href = run ? `Report.dc.html?live=v2&run=${run.id}` : 'Report.dc.html?live=v2';
      tabEls.forEach((t, i) => { t.textContent = `${TABS[i]} ${cnt(TABS[i])}`; t.setAttribute('aria-selected', String(TABS[i] === filt)); });
      fbox.replaceChildren(...(MEDIA.ok ? ps.slice(0, 120).map((x) => {
        const it = fdP.cloneNode(true), nn = noteOf(x.url), [svg, inf] = kids(it), [l1, l2, l3] = kids(inf);
        const im = el('img', null, { src: x.url, alt: '', loading: 'lazy' }); im.style.cssText = 'width:88px;height:66px;object-fit:cover;border-radius:6px;background:#05080A'; svg.replaceWith(im);
        T(l1.children[0], nn && nn.doc.memo ? nn.doc.memo.slice(0, 24) : '관찰 사진'); badge(l1.children[1], nn);
        T(l2, `${runsOf(x.url)[0] || '임무 지점 없음'} · ${fmtT(x.frame_at)}`); T(l3, posTxt(x.x, x.y));
        it.classList.toggle('sel', x.url === url); it.onclick = () => pick(x.url); return it;
      }) : [el('span', MEDIA.err || '서버 기록 읽는 중…', { className: 'lbl' })]));
      if (MEDIA.ok && !ps.length) fbox.append(el('span', '해당 사진 없음 — 조종 화면·현황의 📷 로 찍습니다', { className: 'lbl' }));
      sc.style.visibility = p ? '' : 'hidden'; if (!p) return;
      E = noteEd(p, () => { key = ''; }); msgBox.replaceChildren(E.msg);
      T(scT, n ? `분류: ${n.doc.cls}` : '미분류 관찰'); badge(scB, n);
      T(scL, `${runsOf(p.url).join(', ') || '임무 지점 없음'} · ${posTxt(p.x, p.y)} · 방향 ${deg(p.yaw)} · ${fmtT(p.frame_at)}${n ? ` · 분류 ${n.by} ${fmtT(n.at)}` : ''}`);
      im1.src = p.url; im1.alt = `관찰 사진 ${fmtT(p.frame_at)}`; T(c1, `Gazebo 렌더 · 프레임 수신 ${fmtT(p.frame_at)} · GT는 저장 요청 때 최신(프레임 동기 아님)`);
      const old = nearOf(p).find((q) => tms(q.frame_at) < tms(p.frame_at));
      show(im2, !!old); if (old) { im2.src = old.url; im2.alt = `같은 위치 이전 사진 ${fmtT(old.frame_at)}`; }
      T(c2, old ? `같은 위치(1 m 안) 이전 사진 · ${fmtT(old.frame_at)}` : '같은 위치(1 m 안) 이전 사진 없음');
      memo.value = E.d.memo;
      for (const [b, c] of [[jOk, '확인'], [jNo, '제외'], [jLater, '보류']]) b.setAttribute('aria-pressed', String(!!n && n.doc.cls === c));
    } };
  }

  // ---- PC 로봇(원본 카드 6장): 현재 v2 원값 + 미제공·미연결 표시 ----
  function pagePcRobot() {
    const root = ROOT(), H = $('header', root), pill = $(':scope > span:not(.lbl)', H), roleL = $(':scope > span.lbl', H);
    hdr('로봇', 'Go2 시뮬 · foothold-v2 Gazebo(실기 아님)');
    const card = (lab) => $(`section[aria-label="${lab}"]`, root);
    const setRows = (sec, rows) => {   // 원본 .row 를 본으로 실제 값 줄 만들기 [상태, 이름, 값]
      const box = $('.row', sec).parentElement, p = $('.row', sec).cloneNode(true), k = JSON.stringify(rows);
      if (box.dataset.k === k) return; box.dataset.k = k;
      const keep = [...box.children].filter((c) => !c.classList.contains('row'));
      box.replaceChildren(...rows.map(([lv, a, b]) => { const r = p.cloneNode(true), [m, x, y] = kids(r); m.className = `m-${lv}`; m.textContent = lv === 'ok' ? '●' : lv === 'warn' ? '▲' : '○'; x.textContent = a; y.textContent = b; return r; }), ...keep);
    };
    const body = card('몸 상태'); $('svg', body).style.display = 'none'; T($('h2 .lbl', body), 'v2 시뮬 상태 원값 · 모터 온도·보행 모드 미제공');
    T($(':scope > div > div > span.lbl', body), '넘어짐·기울기·속도는 Gazebo 시뮬 원값입니다. 판정 기준을 덧붙이지 않습니다.');
    const bat = card('배터리와 연결'), [, bBig, bBar, bLbl] = kids(bat); T(bBig.children[0], '미제공'); Object.assign(bBig.children[0].style, { fontSize: '28px', whiteSpace: 'nowrap' }); T(bBig.children[1], WHY['배터리']); bBar.style.display = 'none'; T(bLbl, '복귀 기준(배터리)은 값이 없어 쓰지 않습니다');
    const eq = card('장비'), eqs = $$('.eq', eq);
    const eqSet = (e, name, sub, st) => { const [, inf, last] = kids(e); T(inf.children[0], name); T(inf.children[1], sub); const s = el('span', st, { className: 'm-off' }); last.replaceWith(s); };
    eqSet(eqs[0], '가스 검지기', WHY['가스·측정값·통신 품질'], '○ 미연결'); eqSet(eqs[1], '스피커', '음성 방송 — 현재 v2 연결에 스피커 출력 없음', '○ 미연결');
    why($('button', eqs[2]), '장비 등록 미연결 — 현재 v2 연결은 시뮬 영상·상태만');
    T($('h2 .lbl', eq), '등록된 장비 없음 · 지금 앱 모듈은 사진·운영자 확인·대기만');
    const pose = card('자세 명령'); for (const b of $$('button', pose)) why(b, `${b.textContent.trim()} — ${WHY['후진·제자리 회전·옆걸음·저속·자세']}`);
    T($(':scope > span.lbl', pose), `자세 명령은 현재 v2 연결에서 미검증이라 보내지 않습니다. 이동은 관제·조종 화면에서 앞 0.6 m/s · 회전 ±0.5 rad/s 만.`);
    const stp = card('정지 계층'), [tB, logB] = $$('button', stp);
    why(tB, '정지 시험 자동 실행 미연결 — STOP 버튼으로 직접 확인하세요'); T(logB, '상태 원값 내려받기 (JSON)');
    logB.onclick = () => save(`foothold-v2-state-${Date.now()}.json`, new Blob([JSON.stringify(Object.fromEntries(stateRows()), null, 1)], { type: 'application/json' }));
    return { paint() {
      paintStatus();
      const v = view(), s = v.s;
      T(pill, `${v.linkOk ? '●' : '▲'} 링크 ${v.linkTxt}`); dotc(pill, v.linkOk ? 'ok' : 'warn'); if (roleL) T(roleL, `조종권: ${v.roleTxt}`);
      const f = (x) => (s ? x : '미확인');
      setRows(body, [[s ? 'ok' : 'off', '몸', v.body], ['off', '보행 모드', '미제공'], ['off', '다리 모터 온도', '미제공'],
        [!s ? 'off' : s.fallen === true ? 'warn' : 'ok', '넘어짐', f(String(s && s.fallen != null ? s.fallen : '미확인'))], [s ? 'ok' : 'off', '기울기', f(num(s && s.tilt_deg, 1, '°'))],
        [s ? 'ok' : 'off', '속도 vx · vy', f(`${num(s && s.vx)} · ${num(s && s.vy)} m/s`)], [s ? 'ok' : 'off', '위치(GT) · 방향', f(`${posTxt(s && s.x, s && s.y)} · ${deg(s && s.yaw)}`)]]);
      setRows(bat, [['off', '전압 · 사이클', '미제공'], [v.linkOk ? 'ok' : 'warn', '링크 · 상태 나이', `${v.linkTxt} · ${st ? num(st.state_age, 2, ' s') : '미확인'}`],
        ['off', '로봇 PC', '미제공'], [newVer() ? 'warn' : 'ok', '화면 판 · 서버 판', `${firstVer || '미확인'} · ${(st && st.ver) || '미확인'}`]]);
      setRows(card('센서'), [[v.camOk ? 'ok' : 'warn', '전방 카메라(Gazebo 렌더 · 실카메라 아님)', v.camTxt], ['off', 'L1 라이다', '미제공'], ['off', 'IMU', '미제공(기울기는 시뮬 원값)'],
        ['off', '뎁스 카메라 D435i', WHY['뎁스 영상·3D 점군'].split(' — ')[0]], ['off', 'XT-16 라이다', '미연결']]);
      setRows(stp, [[!v.linkOk || v.latch ? 'warn' : 'ok', '앱 STOP → 서버', `${LATCH_TXT(v)} · ${v.sent}`], ['ok', '서버 deadman 0.3 s', '켜짐(서버 설정값 · 현장 정지 시간 보증 아님)'],
        ['ok', '화면 신호 끊김 1.0 s → 정지·잠금', '켜짐(서버)'], ['warn', '로봇 쪽 명령 끊김 감시', '실기 미검증'], ['off', '리모컨 비상 정지', '미연결(시뮬)']]);
    } };
  }

  // ---- PC 설정(원본 절 그대로): 서버 고정값·이 브라우저 설정은 실제로, 나머지는 미연결 ----
  function pagePcSettings() {
    const root = ROOT();
    hdr('설정', '설정');
    const sec = (id) => $(`#${id}`, root);
    const val = (set, t, lv) => { const last = set.lastElementChild; const s = el('span', t, { className: 'mono' }); s.style.color = lv === 'off' ? 'var(--muted)' : ''; last.replaceWith(s); };
    const setsOf = (id) => $$('.set', sec(id));
    T($(':scope > span.lbl', sec('safety')), '현재 v2 서버의 고정값입니다(앱에서 바꾸지 않음). 현장 값은 실기 연결 뒤 정합니다.');
    const sf = setsOf('safety');
    [`${STOP_FACT[0].replace(' 끊김', '')} → 명령 0 · 화면 신호 1 s → STOP 잠금`, STOP_FACT[1], '미연결 — 영상 멎음 자동 잠금 없음(화면에 영상 나이 표시)', '0.3 s (서버 고정)',
      '해당 없음 — 자동 임무 미연결 · 사람이 «STOP 해제»', '앞 0.6 m/s · 회전 ±0.5 rad/s (시뮬에서 시험한 값만)', '미제공 — 배터리 값 없음'].forEach((t, i) => sf[i] && val(sf[i], t, /미연결|미제공|해당 없음/.test(t) ? 'off' : ''));
    const lost = sf.find((x) => x.textContent.includes('통신이 끊기면')); if (lost) T($('.lbl', lost), '직접 조종 중 · 서버 고정 동작(자율 이동 미연결)');
    for (const s of setsOf('alerts')) val(s, '미연결', 'off');
    T($('h2', sec('alerts')), '알림 · 미연결(화면에 경보 사건만 표시)');
    const th = sec('thresholds'); T($(':scope > span.lbl', th), `미제공 — ${WHY['가스·측정값·통신 품질']}. 기준값을 쓰지 않습니다.`);
    const ttb = $('tbody', th), ttr = el('tr'), ttd = el('td', '가스 측정값이 없어 기준표 미사용', { className: 'lbl' }); ttd.colSpan = 4; ttr.append(ttd); ttb.replaceChildren(ttr);
    const ac = sec('accounts'); why(byText('button', '사람 추가', ac), '계정 추가·편집 미연결 — 계정은 서버 관리자가 이 PC 에서 관리');
    const atb = $('tbody', ac), arP = lift($$('tr', atb));
    const recs = setsOf('records');
    ['서버 media 폴더 · 사진 최근 200 · 사건 최근 300 보관', '공유 문서(구역·양식·계획·진행·분류) 전부 · 서버 docs', 'CSV 내보내기(기록·사진 검토) · 보고서는 인쇄', '미제공'].forEach((t, i) => recs[i] && val(recs[i], t, t === '미제공' ? 'off' : ''));
    const dsp = setsOf('display'), [thR, layR, mmR] = dsp;
    const radios = $$('[role=radio]', thR);
    radios.forEach((r) => { r.onclick = () => { const t = r.textContent.trim(); theme = t.startsWith('밝') ? 'light' : t.startsWith('어') ? 'dark' : null; if (theme) { applyTheme(); if (!store.set('fh.live.theme', theme)) toast('테마 저장 실패(브라우저 저장소) — 이번 화면에만 적용'); } else { store.set('fh.live.theme', null); toast('자동: 다음에 열 때 시안 기본(PC 어두운 · 휴대폰 밝은)'); } paint(); }; });
    const lay = $('select', layR); lay.replaceChildren(...LAYOUTS.map((t) => el('option', t, { value: t })));
    try { lay.value = JSON.parse(localStorage.getItem('fh.live.layout')) || LAYOUTS[0]; } catch (_) { lay.value = LAYOUTS[0]; }
    lay.onchange = () => toast(store.set('fh.live.layout', lay.value) ? '휴대폰 조종 막대 배치 저장(이 브라우저)' : '저장 실패(브라우저 저장 막힘)');
    val(mmR, '미연결 — 가로 조종 화면 미니맵 위치 고정', 'off');
    const mapR = layR.cloneNode(true); mmR.after(mapR); T($('b', mapR), '지도 기본 보기'); const ml = $('.lbl', mapR); if (ml) ml.textContent = '로봇 중심 = 지도가 움직임';
    const msel = $('select', mapR); msel.replaceChildren(el('option', '로봇 중심', { value: 'robot' }), el('option', '전체 보기', { value: 'all' })); msel.value = store.get('fh.live.mapmode', 'robot') === 'all' ? 'all' : 'robot';
    msel.onchange = () => { if (!store.set('fh.live.mapmode', msel.value)) toast('저장 실패 — 이번 화면에만'); };
    const net = setsOf('network'), lim = sec('network').cloneNode(true); lim.id = 'limits'; lim.setAttribute('aria-label', '현재 v2 연결의 한계'); sec('network').after(lim);
    T($('h2', lim), '현재 v2 연결에서 안 되는 것(미제공·미연결·미검증)');
    const lp = $('.set', lim).cloneNode(true), lbox = $('.set', lim).parentElement;
    lbox.replaceChildren(...UNSUP.map(([a, b]) => { const r = lp.cloneNode(true); T($('b', r), a); const l = $('.lbl', r); if (l) l.remove(); val(r, b, 'off'); r.lastElementChild.style.whiteSpace = 'normal'; return r; }));
    return { paint() {
      paintStatus();
      const v = view();
      const cur = $('.fh').classList.contains('light') ? '밝' : '어';
      radios.forEach((r) => r.setAttribute('aria-checked', String(theme ? r.textContent.trim().startsWith(cur) : r.textContent.trim().startsWith('자동'))));
      if (net[0]) val(net[0], `${location.host === '127.0.0.1:8790' || location.hostname === 'localhost' ? '이 PC' : '보호 주소(https)'} · ${v.linkOk ? '● 링크 정상' : `▲ 링크 ${v.linkTxt}`}`);
      if (net[1]) val(net[1], GATED ? '보호 관문 인증서 사용 중 · 만료일은 앱에서 확인 안 함' : '해당 없음(이 PC 전용 주소 · TLS 없음)', GATED ? '' : 'off');
      if (net[2]) val(net[2], `화면 ${firstVer || '미확인'} · 서버 ${(st && st.ver) || '미확인'}`);
      const k = `${(st && st.me) || ''}|${(st && st.holder) || ''}`;
      if (atb.dataset.k !== k) {
        atb.dataset.k = k;
        const r = arP.cloneNode(true), td = kids(r); td[0].textContent = (st && st.me) || '미확인'; td[1].textContent = '이 기기'; td[2].textContent = '조종(조종권을 받을 때) · 임무 기록 · 사진 분류';
        td[3].textContent = st && st.holder ? `조종 중 기기: ${st.holder}` : '조종 중인 기기 없음';
        td[4].replaceChildren(GATED ? el('button', '로그아웃', { className: 'btn', type: 'button', onclick: async () => { dropAll(); send({ op: 'hidden' }); try { await fetch('api/logout', { method: 'POST', credentials: 'same-origin' }); } catch (_) { /* 아래로 */ } location.assign(loginURL()); } }) : el('span', '로그인 없음(이 PC 전용)', { className: 'lbl' }));
        const r2x = arP.cloneNode(true), t2 = kids(r2x); t2[0].textContent = '다른 계정'; t2[1].textContent = '—'; t2[2].textContent = '계정 목록 보기 미연결(서버 관리자만)'; t2[3].textContent = '—'; t2[4].replaceChildren();
        atb.replaceChildren(r, r2x);
      }
    } };
  }

  // ---- 보고서(원본 한 쪽 틀): 고른 수동 임무 진행 기록 ----
  function pageReport() {
    const root = ROOT();
    const runs = () => docsOf('run'), pickRun = () => { if (DOCS.err) return null; const q = Q.get('run'), d = q ? docById(q) : runs().find((r) => r.doc.status !== '진행') || runs()[0]; return d && d.kind === 'run' ? d : null; };   // 읽기 실패면 옛 목록(캐시)으로 확정값처럼 채우지 않음 · run 이 아닌 id 는 기록 아님   // 고른 run 이 없으면 다른 run 으로 바꿔 보여 주지 않는다
    const bar = el('div', null, { className: 'lv-row lv-noprint' }); bar.style.cssText = 'max-width:794px;margin:12px auto;padding:0 8px';
    const rs = el('select', null, { className: 'lv-inp' }); rs.setAttribute('aria-label', '보고서로 볼 수동 임무');
    rs.onchange = () => { Q.set('run', rs.value); history.replaceState(null, '', `?${Q}`); key = ''; };
    bar.append(rs, btn('인쇄', () => print(), 'pri'), btn('CSV 내보내기', () => save(`foothold-v2-history-${Date.now()}.csv`, new Blob([histCSV()], { type: 'text/csv' }))), el('a', '기록 화면', { className: 'lv-btn', href: 'PcHistory.dc.html?live=v2' }));
    root.before(bar);
    const stop = el('button', 'STOP', { type: 'button', className: 'lv-noprint lv-fstop' }); stop.setAttribute('aria-label', '비상 정지'); document.body.append(stop); wireStop();
    const H = $('header', root), h1 = $('h1', H), [, recNo] = kids(H.children[1]);
    const ivs = $$('.iv', root), iv = (i) => ivs[i].children[1];
    const resS = ivs[0].closest('section').nextElementSibling, [resA, , resC] = kids(resS), [, rHead, rBody] = kids(resA), todo = resC.children[1];
    const tsec = resS.nextElementSibling, tbl = $('table', tsec), tb = $('tbody', tbl), trP = lift($$('tr', tb)), modL = $(':scope > span.k', tsec);
    const ths = $$('thead th', tbl); T(ths[1], '방문 기록 시각(운영자)'); T(ths[2], '도착 오차'); T(ths[4], '운영자 판단'); T(ths[5], '결과');
    const msec = tsec.nextElementSibling, fig = $('figure', msec), msvg = $('svg', fig), mcap = $('figcaption', fig);
    const mbox = svgSwap(msvg, 'width:100%;aspect-ratio:920/545;border-radius:6px;overflow:hidden;background:var(--map,#0E1317)');
    const V = mapView(mbox, { name: 'report', mode: 'all' }); V.showTrail = false; V.noRobot = true; V.setMode('all');
    const thBox = $('.thumb', msec).parentElement, thP = lift($$('.thumb', thBox));
    const sig = msec.nextElementSibling, [sA, sB] = kids(sig), foot = $('footer', root);
    let key = '';
    return { paint() {
      const k = `${MEDIA.ok}|${DOCS.rev}|${DOCS.err}|${Q.get('run')}`; if (k === key) return; key = k;
      const rl = DOCS.err ? [] : runs(); rs.replaceChildren(...(rl.length ? rl.map((r) => el('option', `${r.doc.name} · ${r.doc.status} · ${fmtT(r.doc.started)}`, { value: r.id })) : [el('option', DOCS.err ? '기록 읽기 실패 · 미확인' : '수동 임무 기록 없음', { value: '' })]));
      const run = pickRun(), R = run && run.doc; rs.value = run ? run.id : '';
      // 먼저 모든 동적 자리를 비운다 — 기록이 없거나·지워졌거나·저장소 오류일 때 시안 예시값(B1·10-12·Go2 EDU 등)이 남지 않게
      T(recNo, '—'); ivs.forEach((_, i) => T(iv(i), '—')); T(rHead, '—'); T(todo, '—'); tb.replaceChildren(); T(modL, ''); thBox.replaceChildren();
      V.wps = null; V.draw(); T(mcap, '기록 없음'); T(sA.children[0], '운영자'); T(sA.children[1].children[0], ''); T(sB.children[1].children[0], '');
      T(foot.children[0], `기록 보관: 서버 공유 문서·사진 · 이 쪽은 ${new Date().toLocaleString('ko-KR')}에 만듦`);
      if (!R) {
        T(h1, DOCS.err ? '기록 읽기 실패 · 미확인' : DOCS.rev == null ? '읽는 중…' : Q.get('run') ? '고른 기록 없음(지워졌거나 수동 임무 기록이 아님)' : '수동 임무 기록 없음');
        T(rBody, DOCS.err ? `${DOCS.err} — 이전에 읽은 내용도 최신인지 미확인이라 비워 둠. 다시 읽히면 채워짐` : '관제·현황에서 «수동 진행 시작» 뒤 기록이 생깁니다.'); return;
      }
      const vis = R.wps.filter((w) => w.st === '방문').length, miss = R.wps.filter((w) => w.st === '미방문');
      T(h1, R.name); T(recNo, run.id);
      T(iv(0), 'Gazebo foothold-v2 시뮬 바닥(±10 m) · 실제 현장 아님'); T(iv(1), `${fmtT(R.started)} – ${R.ended ? fmtT(R.ended) : '진행 중'} · ${durTxt(R.started, R.ended)}`);
      T(iv(2), `마지막 기록 ${run.by}`); T(iv(3), 'Go2 시뮬(Gazebo) · 실기 아님'); T(iv(4), `${R.tmpl || '—'} · 수동 진행(자동 이동·자동 완료 아님)`); T(iv(5), `${R.wps.length}개 · 방문 ${vis} · 미방문 ${miss.length}`);
      T(rHead, `${R.status === '완료' ? LV.ok : R.status === '진행' ? LV.warn : LV.bad} ${R.status === '진행' ? '진행 중(수동)' : R.status}`);
      T(rBody, R.memo || `방문 ${vis}/${R.wps.length} · 판단 확인 ${R.wps.filter((w) => w.chk === '확인').length} · 보류 ${R.wps.filter((w) => w.chk === '보류').length} · 제외 ${R.wps.filter((w) => w.chk === '제외').length}`);
      T(todo, miss.length ? miss.map((w) => `${wpName(w, R.wps.indexOf(w))}: ${w.why}`).join(' · ') : R.wps.some((w) => w.chk === '보류') ? '보류 판단 지점 다시 확인' : '없음');
      tb.replaceChildren(...R.wps.map((w, i) => {
        const tr = trP.cloneNode(true), td = kids(tr);
        [wpName(w, i), w.at ? fmtT(w.at).slice(6) : '—', '미연결', w.photos.length ? `${w.photos.length} · ${w.photos.map((u) => (noteOf(u) || { doc: { cls: '미분류' } }).doc.cls).join('·')}` : '0', w.chk ? `${w.chk} · 운영자` : '—', w.st === '미방문' ? `미방문 · ${w.why}` : w.st === '방문' ? '● 방문' : '대기'].forEach((x, j) => { td[j].textContent = x; });
        return tr;
      }));
      T(modL, `지점마다 할 일: ${[...new Set(R.wps.flatMap((w) => w.mods))].join(' · ') || '이동만'}. 방문 시각은 운영자가 «방문 확인»을 누른 시각입니다(자동 도착 판정·도착 오차 미연결).`);
      V.wps = R.wps; V.draw(); T(mcap, '지점 위치(계획 스냅샷) · Gazebo GT 좌표 · 지나온 길은 저장하지 않음(미기록)');
      const ph = R.wps.flatMap((w, i) => w.photos.map((u) => [u, i]));
      thBox.replaceChildren(...(ph.length ? ph.slice(0, 12).map(([u, i]) => { const t = thP.cloneNode(true), [svg, cp] = kids(t); svg.replaceWith(el('img', null, { src: u, alt: `WP${i + 1} 사진`, style: 'width:100%;aspect-ratio:16/9;object-fit:cover;display:block' })); const f = (MEDIA.photos.find((p) => p.url === u) || {}).frame_at, n = noteOf(u); cp.textContent = `WP${i + 1} · ${f ? fmtT(f).slice(6) : ''} · ${n ? `${n.doc.cls}${n.doc.memo ? ` · ${n.doc.memo}` : ''}` : '미분류'}`; return t; }) : [el('span', '붙인 사진 없음', { className: 'k' })]));
      T(sA.children[0], '운영자'); T(sA.children[1].children[0], ''); T(sB.children[1].children[0], '');
      T(foot.children[0], `기록 보관: 서버 공유 문서·사진 · 이 쪽은 ${new Date().toLocaleString('ko-KR')}에 만듦`);
    } };
  }

  // ---- PC 지도(원본 저장 지도·도구줄·구역 편집 칸): 시뮬 바닥 도면 + 구역 그리기·저장·공유 ----
  function pagePcMap() {
    const root = ROOT(), H = $('header', root), pill = $(':scope > span', H), posC = $$(':scope > div', H).find((d) => d.textContent.includes('위치'));
    hdr('지도', '시뮬 바닥 도면 ±10 m · Gazebo GT 위치(SLAM 지도 아님)'); T(pill, '시뮬 바닥 도면');
    const left = $('section[aria-label="저장된 지도"]', root), mps = $$('.mp', left), lbls = $$(':scope > span.lbl', left);
    why($('button.btn', left), `새 지도 만들기 — ${WHY['SLAM 지도·위치 맞추기']}`);
    T(lbls[0], 'SLAM 지도 만들기·저장은 미연결입니다. 지금 지도는 시뮬 바닥 도면 하나입니다.'); T(lbls[1], 'Gazebo · foothold-v2'); T(lbls[2], '');
    mps.slice(1).forEach((m) => m.remove()); T(mps[0].children[0], '시뮬 바닥 ±10 m'); T(mps[0].children[1], '1 m 격자 · 사용 중 · 구역은 표시·공유만');
    T(lbls[lbls.length - 1], '층·지도 바꾸기 미연결 — 층 사이 이동·위치 맞추기 없음');
    const ed = $('section[aria-label="지도 편집"]', root), [tPos, tNo, tSlow, tName, tErase] = $$('button.tool', ed), view2 = $$('[role=radio]', ed);
    why(tPos, `위치 맞추기 — ${WHY['SLAM 지도·위치 맞추기']}`); why(tErase, '지우개(잡음 정리) — SLAM 지도 미연결'); why(view2[1], `3D 점군 — ${WHY['뎁스 영상·3D 점군']}`);
    const svg = $('svg[role="img"]', ed), mbox = svg.parentElement; svg.style.visibility = 'hidden';
    const guide = $$(':scope > div', mbox).pop(), [gT, gL, gS] = kids(guide);
    const Z = { draw: Q.get('draw') === '금지' || Q.get('draw') === '감속' ? { type: Q.get('draw'), pts: [] } : null };
    const E = editor('zone', () => { key = ''; });
    const V = mapView(mbox, { name: 'pcmap', onTap: (x, y) => {
      if (E.busy) return toast('구역 저장 중 — 끝난 뒤 다시');
      if (Z.draw) { if (Z.draw.pts.length >= 40) return toast('꼭짓점은 40개까지'); Z.draw.pts.push([r2(x), r2(y)]); return; }
      const z = zonesAt(x, y)[0]; pickZone(z ? z.id : null);
    } });
    mbox.append(mapBtns(V, 'lv-mapbtns', true));
    const asideZ = $('aside', root), [zEd, zList, zInfo] = kids(asideZ), [zHead] = kids(zEd), zn = $('#zn', zEd), za = $('#za', zEd), zNote = $(':scope > span.lbl', zEd), [zDel, zSave] = $$('button', zEd);
    const zl = $('label[for="za"]', zEd); if (zl) zl.textContent = '종류';
    za.replaceChildren(el('option', '진입 금지', { value: '금지' }), el('option', '감속', { value: '감속' })); zn.maxLength = 40; zn.placeholder = '구역 이름(예: 계단 앞)';
    T(zNote, ZONE_NOTE); zSave.after(E.msg);
    const zRowBox = zList.children[1], zRowP = lift(kids(zRowBox)), kv = $('.kv', zInfo), [exB, reB] = $$('button', zInfo);
    why(reB, `다시 만들기 — ${WHY['SLAM 지도·위치 맞추기']}`); T(exB, '구역 내보내기 (JSON)');
    exB.onclick = () => save(`foothold-v2-zones-${Date.now()}.json`, new Blob([JSON.stringify(docsOf('zone').map((z) => ({ id: z.id, rev: z.rev, by: z.by, at: z.at, ...z.doc })), null, 1)], { type: 'application/json' }));
    let key = '';
    function pickZone(id) {
      if (E.busy) return toast('구역 저장 중 — 끝난 뒤 다시');
      if (E.dirty && !confirm('저장 안 한 수정이 있습니다. 버릴까요?')) return;
      E.load(id ? docById(id) : null); Z.draw = null; key = '';
    }
    const startDraw = (ty) => { if (E.busy) return toast('구역 저장 중 — 끝난 뒤 다시'); if (E.dirty && !confirm('저장 안 한 수정이 있습니다. 버릴까요?')) return; E.load(null); Z.draw = { type: ty, pts: [] }; zn.value = ''; key = ''; };
    tNo.onclick = () => startDraw('금지'); tSlow.onclick = () => startDraw('감속'); tName.onclick = () => { if (!E.id) return toast('먼저 지도나 목록에서 구역을 고르세요'); zn.focus(); };
    zn.oninput = () => { if (E.d) { E.d.name = zn.value; E.dirty = true; } };
    za.onchange = () => { if (E.busy) { za.value = Z.draw ? Z.draw.type : E.d ? E.d.type : '금지'; return toast('구역 저장 중 — 끝난 뒤 다시'); } if (Z.draw) Z.draw.type = za.value; else if (E.d) { E.d.type = za.value; E.dirty = true; } };
    zSave.onclick = async () => {
      if (E.busy) return toast('구역 저장 중 — 끝난 뒤 다시');   // 두 번째 누름이 E.load 로 gen 을 올려 첫 성공 응답을 버리지 않게
      if (Z.draw) {
        if (Z.draw.pts.length < 3) return toast('꼭짓점을 3개 이상 찍으세요');
        if (!zn.value.trim()) { zn.focus(); return toast('구역 이름을 넣으세요'); }
        const dr = Z.draw, n = dr.pts.length;
        E.load(null, { name: zn.value.trim(), type: dr.type, pts: dr.pts.slice() }); E.dirty = true; const g = E.gen;
        const r = await E.save();
        if (r && r.ok && Z.draw === dr && E.gen === g && dr.pts.length === n) { Z.draw = null; key = ''; toast('구역 저장됨 · 모든 기기 공유'); }   // 저장 누른 그 초안·그 판일 때만 지움
        return;
      }
      if (!E.id) return toast('저장할 구역이 없습니다 — 도구줄에서 구역을 그리세요');
      if (!E.d.name.trim()) return toast('구역 이름을 넣으세요');
      E.save();
    };
    zDel.onclick = async () => {
      if (E.busy) return toast('구역 저장 중 — 끝난 뒤 다시');
      if (Z.draw) { if (Z.draw.pts.length) { Z.draw.pts.pop(); return; } Z.draw = null; key = ''; return; }
      const r = await E.del(); if (r && r.ok) { E.load(null); toast('구역 지움'); key = ''; }
    };
    return { paint() {
      paintStatus();
      const s = view().s;
      if (posC) { const [m, , val] = kids(posC); if (val) T(val, s ? `GT ${posTxt(s.x, s.y)} · ${deg(s.yaw)}` : TRAIL.last ? 'GT 오래됨' : 'GT 미수신'); if (m) { m.textContent = s ? '●' : '▲'; dotc(m, s ? 'ok' : 'warn'); } }
      for (const [b, on] of [[tNo, Z.draw && Z.draw.type === '금지'], [tSlow, Z.draw && Z.draw.type === '감속'], [tName, !!E.id && !Z.draw]]) b.setAttribute('aria-pressed', String(!!on));
      V.draft = Z.draw; V.hiZone = E.id;
      T(gT, Z.draw ? `${Z.draw.type} 구역 그리는 중` : E.id ? '구역 고름' : '구역');
      T(gL, Z.draw ? `지도를 눌러 꼭짓점 추가(3개 이상 · ${Z.draw.pts.length}개) → 오른쪽에서 이름 넣고 저장. «구역 삭제»는 마지막 점 지우기. 끌면 지도 이동.` : '도구줄에서 진입 금지·감속 구역을 고른 뒤 지도를 눌러 그립니다. 지도의 구역을 누르면 고칠 수 있습니다.');
      gS.replaceChildren(el('span', '▲'), ' 구역은 표시·공유만 · 주행 제한 미연결'); dotc(gS.firstChild, 'warn');
      const sc = E.stale(); if (sc && !E.dirty) { E.load(sc); key = ''; }
      const k = `${DOCS.rev}|${E.id}|${E.rev}|${!!Z.draw}|${Z.draw && Z.draw.type}`; if (k === key) return; key = k;
      const editing = Z.draw || E.id;
      zHead.children[1].textContent = Z.draw ? `새 ${Z.draw.type} 구역` : E.id ? `${E.d.type === '금지' ? '진입 금지' : '감속'} 구역 · 판 ${E.rev}` : '구역을 고르세요';
      zHead.children[0].style.background = `var(--${(Z.draw ? Z.draw.type : E.d && E.d.type) === '감속' ? 'warn' : 'bad'})`;
      zn.disabled = za.disabled = !editing; zSave.disabled = zDel.disabled = !editing;
      if (document.activeElement !== zn) zn.value = Z.draw ? zn.value : E.d ? E.d.name : '';
      za.value = Z.draw ? Z.draw.type : E.d ? E.d.type : '금지';
      T(zDel, Z.draw ? '마지막 점 지우기' : '구역 삭제');
      const zs = docsOf('zone');
      T(zList.children[0], `이 도면의 구역 ${zs.length}개`);
      zRowBox.replaceChildren(...(zs.length ? zs.map((z) => {
        const r = zRowP.cloneNode(true), [a, b] = kids(r); a.replaceChildren(el('span', z.doc.type === '금지' ? '■' : '▲'), ` ${z.doc.name} · ${z.doc.type === '금지' ? '진입 금지' : '감속'}`); dotc(a.firstChild, z.doc.type === '금지' ? 'bad' : 'warn');
        b.textContent = `${areaOf(z.doc.pts).toFixed(1)} m² · ${z.by}`; r.style.cursor = 'pointer'; r.tabIndex = 0; r.onclick = () => pickZone(z.id); r.onkeydown = (e) => { if (e.key === 'Enter') pickZone(z.id); };
        if (z.id === E.id) r.style.outline = '1px solid var(--accent)'; return r;
      }) : [el('span', DOCS.rev == null ? '읽는 중…' : '저장된 구역 없음', { className: 'lbl' })]));
      const kvv = [['도면', 'Gazebo 바닥(world_live.sdf)'], ['만든 사람', '시뮬 설정(앱 아님)'], ['크기', '20 × 20 m'], ['격자', '1 m'], ['방법', '시뮬 정답 위치(GT) · SLAM 미연결'], ['위치 추정', 'Gazebo GT(추정 아님)'], ['구역', `${zs.length}개 · 표시·공유만`]];
      kv.replaceChildren(...kvv.flatMap(([a, b]) => [el('span', a, { className: 'lbl' }), el('span', b)]));
    } };
  }

  const PAGES = { 'MHome.dc.html': pageMHome, 'MMap.dc.html': pageMMap, 'MFinding.dc.html': pageMFinding, 'MHistory.dc.html': pageMHistory, 'MAlerts.dc.html': pageMAlerts, 'MAlert.dc.html': pageMAlert,
    'PcMap.dc.html': pagePcMap, 'PcMissions.dc.html': pagePcMissions, 'PcPlan.dc.html': pagePcPlan, 'PcHistory.dc.html': pagePcHistory, 'PcReview.dc.html': pagePcReview,
    'PcRobot.dc.html': pagePcRobot, 'PcSettings.dc.html': pagePcSettings, 'Report.dc.html': pageReport };

  let D, M;
  function paint() {
    if (D) paintDrive(D); if (M) paintMain(M); if (P) P.paint();
    for (const V of MAPS) V.draw();
    if (drawer) drawer.paint();
  }
  function boot() {
    const root = document.getElementById('dc-root');
    if (!root) return setTimeout(boot, 50);
    if (LOGIN_PAGES.includes(PAGE)) return setupLogin();
    if (!LIVE_PAGES.includes(PAGE)) return;
    root.dataset.liveOwned = '1';   // 이제 이 화면은 실연결이 그린다 — 시안 실행기(dc.js)의 다시 그리기(setState) 중지
    applyTheme();
    if (PAGE === 'MDrive.dc.html') D = setupDrive();
    else if (PAGE === 'Main.dc.html') M = setupMain();
    else { P = PAGES[PAGE](); if (!S.el && PAGE !== 'Report.dc.html') mountStatus(); wireStop(); }   // 상태 줄·STOP(PcMissions 는 다시 그릴 때마다 afterRender 에서)
    addEventListener('resize', () => { for (const V of MAPS) V.draw(); });
    guardLinks(); paint(); connect(); loadDocs(); loadMedia();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
