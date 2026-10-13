// v2 시뮬 실연결 모드 — 주소에 ?live=v2 가 있을 때만 켜진다. 없으면 시안 그대로 두고 «시안 · 동작 안 함» 안내만 띄운다.
// 서버 sim/v2_link.py(127.0.0.1:8790)와 WebSocket 으로 잇는다. 안전 판단은 서버가 하고, 이 화면은 믿지 않는 층이다:
//   누르는 동안만 입력을 보내고, 연결·조종권·STOP·리셋·에피소드·시뮬 상태·확대/닫기·창 떠남이 바뀌면 모든 누름을 버린다(새로 눌러야 움직임).
// 시안 마크업은 바꾸지 않는다. 실연결 중에는 시안 예시값을 실제값이나 «미연결»로 바꾸고, 지원 안 되는 버튼은 눌러서 이유를 보게 한다.
(() => {
  const PAGE = location.pathname.split('/').pop();
  const LIVE_PAGES = ['Main.dc.html', 'MDrive.dc.html'];          // 실연결을 붙인 화면은 이 둘뿐
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
  // 미지원 목록(설정 패널·README 와 같은 내용). 작동하는 척하지 않고 이유를 보여 준다.
  const UNSUP = [
    ['임무 실행·임무 단계·복귀', '실제 임무 기능 없음 — 이 화면은 시뮬 직접 조종 시험'],
    ['목표 보내기·자동 이동(NAV)', 'Nav2 미연결'],
    ['지도·SLAM·위치 맞추기', '지도 없음 — Gazebo 정답 위치(GT) 궤적만'],
    ['AI 탐지·발견물 판독', '판독 모델 미연결'],
    ['뎁스 영상·3D 점군', 'v2 시뮬은 RGB 압축 영상만 보냄'],
    ['측정값·가스·통신 품질·금지 구역', '해당 센서·기능 없음'],
    ['배터리', '시뮬 상태에 배터리 값 없음'],
    ['후진·제자리 회전·옆걸음·저속·자세', '시뮬 검증 안 됨 — 서버가 0으로 막음'],
    ['실기 Go2', '연결 안 함(시뮬 전용)'],
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
.lv-bigbar .lv-stop{border:0;background:#D7261E;color:#fff;font-weight:700;letter-spacing:.06em;min-width:96px}`;
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
  async function takePhoto() {
    const r = await ask('photo');
    if (!r.ok) return toast(r.text);
    const p = r.photo, pos = p.x == null ? '위치 미확인' : `x ${sgn(p.x)} y ${sgn(p.y)} m · 방향 ${deg(p.yaw)}`;
    note('사진', `사진 서버 저장 · 프레임 수신 ${p.frame_at.slice(11, 19)} · ${pos} · ${p.url}`);
    if (PHONE) return toast(`사진 서버 저장 · 프레임 수신 ${p.frame_at.slice(11, 19)} · ${pos} · «기록»에서 보기`);
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
    const v = view(), r = [['링크', v.linkTxt], ['조종권', v.roleTxt], ['STOP 잠금', String(v.latch)], ['보낸 명령', v.sent],
      ['서버 이유', (st && st.reason) || '—'], ['state_age s', st ? num(st.state_age, 2) : '미확인'], ['cam_age s', st ? num(st.cam_age, 2) : '미확인'],
      ['episode', st ? String(st.episode) : '미확인'], ['배터리', '미연결(시뮬에 값 없음)'], ['이 기기', (st && st.me) || '미확인'],
      ['조종 중인 기기', (st && st.holder) || '없음'], ['시뮬 세션(RL 상태)', sessTxt() || '미확인'], ['화면 판', `${firstVer || '미확인'} (서버 지금 ${(st && st.ver) || '미확인'})`]];
    for (const [k, x] of Object.entries((st && st.sim) || {})) r.push([`sim.${k}`, typeof x === 'string' ? x : JSON.stringify(x)]);
    return r;
  }
  function rowsInto(dl) { dl.replaceChildren(); for (const [k, x] of stateRows()) dl.append(el('dt', k), el('dd', x)); }
  function openRobot() {
    openDrawer('로봇 상태 · 실제 시뮬 값', (b) => {
      if (!b.firstChild) b.append(el('p', `${TRIAL} · 실기 Go2 아님`), el('dl'));
      rowsInto(b.querySelector('dl'));
    });
  }
  let theme = store.get('fh.live.theme', 'dark') === 'light' ? 'light' : 'dark';   // 이번 화면의 선택값(저장 실패해도 이 값으로 그림)
  function applyTheme() { const fh = $('.fh'); if (fh) fh.classList.toggle('light', theme === 'light'); }
  function openSettings() {
    openDrawer('설정 · 이 브라우저에 저장', (b) => {
      if (b.firstChild) return;
      if ($('.fh')) {
        const t = el('button'); const lab = () => { t.textContent = `테마: ${theme === 'light' ? '밝은' : '어두운'} (눌러 바꾸기)`; };
        t.onclick = () => { theme = theme === 'light' ? 'dark' : 'light'; applyTheme(); lab(); toast(store.set('fh.live.theme', theme) ? '테마 저장됨(이 브라우저)' : '테마 저장 실패(브라우저 저장 막힘) — 이번 화면에만 적용'); }; lab(); b.append(t);
      } else b.append(el('p', '가로 조종 화면은 영상 위 표시라 어두운 테마 고정입니다.'));
      if (M) {
        const f = el('button'); const lab = () => { f.textContent = `지도 기본: ${store.get('fh.live.follow', false) ? '로봇 따라가기' : '전체 맞춤'} (눌러 바꾸기)`; };
        f.onclick = () => { store.set('fh.live.follow', !store.get('fh.live.follow', false)); M.follow = store.get('fh.live.follow', false); lab(); paint(); }; lab(); b.append(f);
      }
      if (D) {
        const cur = Q.get('stickLayout') || LAYOUTS[0];
        const lb = el('button', `막대 배치: ${cur} (눌러 바꾸기 · 화면 다시 열림)`);
        lb.onclick = () => {
          if (role === 'control') return toast('조종 중에는 바꾸지 않습니다 — 조종권 반납 뒤');
          const nx = LAYOUTS[(LAYOUTS.indexOf(cur) + 1) % LAYOUTS.length];
          if (!store.set('fh.live.layout', nx)) toast('저장 실패 — 이번만 적용');
          Q.set('stickLayout', nx); location.replace(`${PAGE}?${Q}`);
        };
        b.append(lb, el('p', '앞뒤 막대: 앞만 움직입니다. 뒤로 당기면 후진 미검증이라 서버가 0으로 막습니다(이유 표시).'));
      }
      b.append(el('button', '기록 보기(사진·조종 기록)', { onclick: openRecords }));
      b.append(el('button', '설치·접속 안내(QR·홈 화면 추가)', { onclick: () => location.assign('start.html') }));
      if (GATED) b.append(el('button', `로그아웃 · ${(st && st.me) || ''}`, { onclick: async () => {
        dropAll(); send({ op: 'hidden' });                    // 조종권 해제 · 0 · STOP 잠금(서버)
        try { await fetch('api/logout', { method: 'POST', credentials: 'same-origin' }); } catch (_) { /* 아래로 */ }
        location.assign(loginURL());
      } }));
      b.append(el('p', `화면 판 ${firstVer || '미확인'} · 서버 판 ${(st && st.ver) || '미확인'}${STANDALONE ? ' · 홈 화면 웹 앱' : ''}`));
      b.append(el('h3', '안 되는 기능과 이유'));
      const dl = el('dl'); for (const [k, x] of UNSUP) dl.append(el('dt', k), el('dd', x)); b.append(dl);
      b.append(el('p', `주의: ${RELURCH} · 원인 미확인`));
    });
  }

  // 실연결 화면 사이만 ?live=v2 유지. 기록·로봇·설정은 이 화면의 패널로, 나머지 시안 링크는 막고 이유를 보여 준다.
  const LINK_ACT = { 'PcHistory.dc.html': openRecords, 'PcReview.dc.html': openRecords, 'PcRobot.dc.html': openRobot, 'PcSettings.dc.html': openSettings };
  const LINK_WHY = { 'PcMissions.dc.html': `임무 — ${WHY['임무 실행·임무 단계·복귀']}`, 'PcMap.dc.html': `지도 — ${WHY['지도·SLAM·위치 맞추기']}`,
    'MMap.dc.html': `지도 — ${WHY['지도·SLAM·위치 맞추기']}`, 'PcPlan.dc.html': `임무 계획 — ${WHY['임무 실행·임무 단계·복귀']}` };
  function guardLinks() {
    for (const a of $$('a[href]')) {
      const page = a.getAttribute('href').split(/[?#]/)[0];
      if (LIVE_PAGES.includes(page)) { a.href = page + '?live=v2'; continue; }
      const act = LINK_ACT[page], t = LINK_WHY[page] || '이 화면은 시안(미연결)입니다 · 실연결은 관제(Main)·조종(MDrive)만';
      a.dataset.designHref = a.getAttribute('href'); a.removeAttribute('href'); a.setAttribute('role', 'button'); a.tabIndex = 0; a.style.cursor = 'pointer';
      if (!act) { a.setAttribute('aria-disabled', 'true'); a.title = t; a.classList.add('lv-why'); }
      const go = (e) => { e.preventDefault(); if (act) act(); else toast(t); };
      a.addEventListener('click', go); a.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') go(e); });
    }
  }

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
  function wireStop() {
    stopBtn($('button[aria-label="비상 정지"]'));
    addEventListener('keydown', (e) => {
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
    const mm = document.createElement('div');
    mm.style.cssText = 'position:absolute;inset:0;padding:8px;font-size:11px;line-height:1.5;color:#E6EBEF;background:rgba(14,19,23,.82)';
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
    const back = byText('a.pill', '임무로 돌아가기'); back.textContent = '관제 화면'; back.setAttribute('href', 'Main.dc.html');
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
    D.mm.textContent = '';
    D.mm.append(`지도 미연결 · 판 ${firstVer || '—'}`, document.createElement('br'),
      s ? `위치 출처 ${v.src}` : '위치 미연결', document.createElement('br'),
      s ? `x ${sgn(s.x)} y ${sgn(s.y)} m · 방향 ${deg(s.yaw)}` : '');
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
    mapSvg.style.visibility = 'hidden';
    const cv = document.createElement('canvas'); cv.style.cssText = 'position:absolute;pointer-events:none';
    mapSvg.parentElement.style.position = 'relative'; mapSvg.parentElement.append(cv);
    const mapTitle = byText('span', 'B1 · 저장 지도', map);
    // 지도 버튼: 따라가기·확대·축소·경로는 GT 궤적에 실제로 연결, 나머지 레이어는 이유 안내
    const [fol, zin, zout] = $$('button.ibtn', map);
    const layers = $$('button.layer', map), trailBtn = layers[0];
    for (const n of $$('button.layer .mono', map)) n.textContent = '—';   // 시안 예시 개수(발견물 2) → 미연결
    for (const b of layers.slice(1)) {
      const name = b.firstChild.textContent.trim();
      b.setAttribute('aria-pressed', 'false');
      why(b, `${name} — ${name === '3D 점군' ? WHY['뎁스 영상·3D 점군'] : name === '발견물' ? WHY['AI 탐지·발견물 판독'] : WHY['측정값·가스·통신 품질·금지 구역']}`);
    }
    trailBtn.title = 'Gazebo GT 궤적 보이기/숨기기';
    fol.title = '로봇 따라가기(누르면 켜기/끄기)'; zin.title = '확대'; zout.title = '축소';
    const legend = byText('div', '지나온 경로', map); if (legend) legend.style.visibility = 'hidden';
    const stepHead = byText('span', '경과', map); const stepList = $('.step', map)?.parentElement;
    // 비어 있던 임무 단계 자리 → 상태 상세(서버 원값) 펼침
    const det = el('details'); det.style.cssText = 'padding:4px 2px;font-size:13px';
    const sum = el('summary', '상태 상세 · 서버 원값 펼치기'); sum.style.cssText = 'cursor:pointer;min-height:32px;color:var(--accent)';
    const dl = el('dl'); dl.style.cssText = 'display:grid;grid-template-columns:auto 1fr;gap:2px 14px;margin:8px 0 0';
    det.append(sum, dl);
    if (stepList) { stepList.style.display = 'none'; stepList.after(det); }
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
    // 임무 예시 패널(확인·탐지·가스)은 실연결 중 숨긴다 — 임무·AI·가스는 미연결
    for (const t of ['이 지점에서 할 일', 'AI 탐지', '가스 측정']) { const h = byText('span', t, vsec); if (h) h.parentElement.parentElement.style.display = 'none'; }
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
      const k = K[e.key]; if (!k || drawer) return; e.preventDefault();
      if (e.repeat || role !== 'control') return;          // 키보드 조종은 «조종권 받기» 뒤 새로 누른 키만
      keys.set(e.key, { fx: 0, fy: 0, fw: 0, [k[0]]: k[1] }); merge();
    });
    addEventListener('keyup', (e) => { if (keys.delete(e.key)) merge(); });
    wireStop();
    const M = { siteLine, stepTitle, modeEl, opRole, cv, mapSvg, mapTitle, stepHead, vlabel, b1, b2, b3, motion, evBox, det, dl, box, bRes, bSt, drive, ex, bStart, bReload, exTxt,
      chips: $$('.chip', H), trail: [], ep: null, follow: store.get('fh.live.follow', false), zoom: 1, showTrail: true };
    const pressed = () => { fol.setAttribute('aria-pressed', String(M.follow)); fol.style.borderColor = M.follow ? 'var(--accent)' : ''; trailBtn.setAttribute('aria-pressed', String(M.showTrail)); };
    fol.addEventListener('click', () => { M.follow = !M.follow; pressed(); paint(); });
    zin.addEventListener('click', () => { M.zoom = Math.min(8, M.zoom * 1.5); paint(); });
    zout.addEventListener('click', () => { M.zoom = Math.max(0.25, M.zoom / 1.5); paint(); });
    trailBtn.addEventListener('click', () => { M.showTrail = !M.showTrail; pressed(); paint(); });
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
    M.stepTitle.textContent = '직접 조종 시험 · 임무 없음'; M.stepTitle.title = v.flags;   // 원문 플래그는 툴팁으로
    M.modeEl.textContent = !v.linkOk ? '링크 끊김' : st.reset_pending ? '리셋 중' : st.resume_pending ? 'STOP 해제 대기' : v.latch ? 'STOP 요청' : role === 'control' ? '직접 조종' : '보기 전용';
    if (M.opRole) M.opRole.textContent = v.roleTxt;
    chip(M.chips[0], '링크', v.linkTxt, v.linkOk && !st.sim_block);
    chip(M.chips[1], '위치', s ? (s.source === 'gz_gt' ? 'Gazebo GT' : v.src) : '미연결', !!s);
    chip(M.chips[2], '영상', v.camTxt, v.camOk);
    chip(M.chips[3], '배터리', '미연결', false);
    M.mapTitle.textContent = s ? `지도·SLAM 아님 · 선은 ${v.src} 위치 · x ${sgn(s.x)} y ${sgn(s.y)} m` : '지도·SLAM 아님 · 위치 미연결';
    if (M.stepHead) M.stepHead.textContent = '임무 미연결';
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
    if (st && st.episode !== M.ep) { M.trail = []; M.ep = st.episode; }   // 새 에피소드면 지나온 선을 새로
    if (s && ok(s.x) && ok(s.y)) {
      const p = M.trail[M.trail.length - 1];
      if (!p || Math.hypot(p[0] - s.x, p[1] - s.y) > 0.02) M.trail.push([s.x, s.y]);
      if (M.trail.length > 2000) M.trail.shift();
    }
    drawTrail(M, s && ok(s.x) && ok(s.y) ? s : null);
  }
  function drawTrail(M, s) {   // 지도 없이 위치만: 1 m 격자, 지나온 선, 로봇 방향. 따라가기·확대/축소.
    const r = M.mapSvg.getBoundingClientRect(), pr = M.mapSvg.parentElement.getBoundingClientRect();
    const cv = M.cv; cv.style.left = (r.left - pr.left) + 'px'; cv.style.top = (r.top - pr.top) + 'px';
    cv.style.width = r.width + 'px'; cv.style.height = r.height + 'px'; cv.width = r.width; cv.height = r.height;
    const g = cv.getContext('2d'), W = r.width, Hh = r.height; g.clearRect(0, 0, W, Hh);
    const pts = M.trail.concat(s ? [[s.x, s.y]] : []);
    const xs = pts.map((p) => p[0]).concat(0), ys = pts.map((p) => p[1]).concat(0);
    let cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const span = Math.max(4, Math.max(...xs) - Math.min(...xs) + 2, Math.max(...ys) - Math.min(...ys) + 2);
    if (M.follow && s) { cx = s.x; cy = s.y; }
    const sc = Math.min(W, Hh) / span * M.zoom, X = (x) => W / 2 + (x - cx) * sc, Y = (y) => Hh / 2 - (y - cy) * sc;
    g.strokeStyle = 'rgba(128,140,150,.25)'; g.lineWidth = 1;
    for (let i = Math.floor(cx - W / sc / 2); i <= cx + W / sc / 2; i++) { g.beginPath(); g.moveTo(X(i), 0); g.lineTo(X(i), Hh); g.stroke(); }
    for (let j = Math.floor(cy - Hh / sc / 2); j <= cy + Hh / sc / 2; j++) { g.beginPath(); g.moveTo(0, Y(j)); g.lineTo(W, Y(j)); g.stroke(); }
    cv.dataset.view = `${M.follow ? 'follow' : 'fit'}|${+M.zoom.toFixed(2)}|${M.showTrail ? 'trail' : 'notrail'}`;   // 시험·상태 확인용
    g.fillStyle = '#9AA7B2'; g.font = '12px sans-serif';
    g.fillText(`격자 1 m · 시작점 + · Gazebo GT 위치(지도·SLAM 아님) · ${M.follow ? '따라가기' : '전체 맞춤'} ×${+M.zoom.toFixed(2)}${M.showTrail ? '' : ' · 궤적 숨김'}`, 8, Hh - 8);
    g.strokeStyle = '#9AA7B2'; g.beginPath(); g.moveTo(X(0) - 6, Y(0)); g.lineTo(X(0) + 6, Y(0)); g.moveTo(X(0), Y(0) - 6); g.lineTo(X(0), Y(0) + 6); g.stroke();
    if (!pts.length) return;
    if (M.showTrail) { g.strokeStyle = '#38C6D9'; g.lineWidth = 3; g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(X(p[0]), Y(p[1])) : g.moveTo(X(p[0]), Y(p[1])))); g.stroke(); }
    if (s && ok(s.yaw)) {
      g.save(); g.translate(X(s.x), Y(s.y)); g.rotate(-s.yaw); g.fillStyle = s.fallen === true ? '#FF5A4F' : '#38C6D9';
      g.beginPath(); g.moveTo(14, 0); g.lineTo(-10, 9); g.lineTo(-5, 0); g.lineTo(-10, -9); g.closePath(); g.fill(); g.restore();
    }
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

  let D, M;
  function paint() { if (D) paintDrive(D); if (M) paintMain(M); if (drawer) drawer.paint(); }
  function boot() {
    if (!document.getElementById('dc-root')) return setTimeout(boot, 50);
    if (PAGE === 'MDrive.dc.html') D = setupDrive();
    else if (PAGE === 'Main.dc.html') M = setupMain();
    else if (LOGIN_PAGES.includes(PAGE)) return setupLogin();
    else return;
    guardLinks(); paint(); connect();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
