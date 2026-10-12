// v2 시뮬 실연결 모드 — 주소에 ?live=v2 가 있을 때만 켜진다. 없으면 아무것도 하지 않는다(시안 미리보기 그대로).
// 서버 sim/v2_link.py(127.0.0.1:8790)와 WebSocket 으로 잇는다. 안전 판단은 서버가 하고, 이 화면은 믿지 않는 층이다:
//   누르는 동안만 입력을 보내고, 연결·조종권·STOP·리셋·에피소드·시뮬 상태가 바뀌면 모든 누름을 버린다(새로 눌러야 움직임).
// 시안 마크업은 바꾸지 않는다. 실연결 중에는 시안 예시값을 실제값이나 «미연결»로 바꿔 보여 준다.
(() => {
  if (new URLSearchParams(location.search).get('live') !== 'v2') return;
  const TRIAL = 'Gazebo · foothold-v2 시험 · 낙상·정지 지연 미검증';
  // RL 기록(online RESULT 「관찰」·exp33): 명령 0 뒤에도 1~2 s 안에 한 번 다시 움직일 수 있음(최대 약 .33 m/s·기울기 28°)
  const RELURCH = '정지 뒤 1~2 s 안에 한 번 다시 움직일 수 있음(시뮬 기록 최대 약 .33 m/s·28°)';
  const LIVE_PAGES = ['Main.dc.html', 'MDrive.dc.html'];          // 실연결을 붙인 화면은 이 둘뿐
  const $ = (sel, r = document) => r.querySelector(sel);
  const $$ = (sel, r = document) => [...r.querySelectorAll(sel)];
  const byText = (sel, t, r = document) => $$(sel, r).find((e) => e.textContent.trim().startsWith(t));
  const ok = (v) => typeof v === 'number' && isFinite(v);
  const num = (v, d = 2, u = '') => (ok(v) ? v.toFixed(d) + u : '미확인');
  const sgn = (v, d = 2, u = '') => (ok(v) ? (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(d) + u : '미확인');
  const SRC = { gz_gt: 'Gazebo 정답값(GT)', fake_kinematic: '가짜 발행기(앱 시험용)' };

  let ws, st = null, lastMsg = 0, role = 'view', camURL = null, camFrames = [], sig = null;
  const zones = new Map();                      // 막대 → {pid, p}: 막대마다 손가락 하나, 전체 둘
  const keys = new Map();                       // 누르고 있는 화살표 키(Main)
  const intent = { fx: 0, fy: 0, fw: 0 };
  const knobs = [];

  function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
  // 모든 누름 폐기: 지금 누르고 있는 손가락·키는 뗄 때까지 죽은 입력. 다시 눌러야 새 입력.
  function dropAll() {
    for (const [g, z] of zones) { try { g.releasePointerCapture(z.pid); } catch (_) { /* 이미 놓임 */ } }
    zones.clear(); keys.clear(); merge(); for (const k of knobs) k.style.transform = '';
  }
  function merge() {
    intent.fx = intent.fy = intent.fw = 0;
    for (const p of [...[...zones.values()].map((z) => z.p), ...keys.values()]) { intent.fx += p.fx; intent.fy += p.fy; intent.fw += p.fw; }
  }
  function hide() { dropAll(); send({ op: 'hidden' }); }

  function connect() {
    ws = new WebSocket(`ws://${location.host}/ws`); ws.binaryType = 'blob';
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') {                 // 카메라 jpeg
        if (camURL) URL.revokeObjectURL(camURL);
        camURL = URL.createObjectURL(e.data); const now = performance.now();
        camFrames = camFrames.filter((t) => now - t < 2000).concat(now);
        for (const img of $$('img[data-live-cam]')) img.src = camURL;
        return;
      }
      st = JSON.parse(e.data); lastMsg = performance.now(); role = st.role;
      const s2 = [role, st.latch, st.reset_pending, st.resume_pending, st.episode, !!st.sim_block].join('|');
      if (s2 !== sig) { if (sig !== null) dropAll(); sig = s2; }   // 조종권·STOP·리셋·에피소드·시뮬 상태 변화 → 누름 폐기
      paint();
    };
    ws.onclose = () => { dropAll(); role = 'view'; sig = null; setTimeout(connect, 1000); };
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) hide(); });
  addEventListener('pagehide', hide);
  addEventListener('blur', dropAll);
  if (screen.orientation) screen.orientation.addEventListener('change', dropAll);
  setInterval(() => { if (role === 'control') send({ op: 'cmd', ...intent }); }, 50);   // 20 Hz, 손 떼면 0
  setInterval(() => {                                                                   // 링크 끊김: 표시 갱신 + 누름 폐기
    if (lastMsg && performance.now() - lastMsg > 1000) { dropAll(); paint(); }
  }, 500);

  // 실연결 화면 사이만 ?live=v2 유지. 나머지 링크는 시안(미연결)이라 막고 안내한다.
  function guardLinks() {
    for (const a of $$('a[href]')) {
      const page = a.getAttribute('href').split(/[?#]/)[0];
      if (LIVE_PAGES.includes(page)) { a.href = page + '?live=v2'; continue; }
      a.dataset.designHref = a.getAttribute('href'); a.removeAttribute('href');
      a.setAttribute('role', 'link'); a.setAttribute('aria-disabled', 'true'); a.tabIndex = 0;
      a.title = '시안 화면 · 실연결 아님';
      const tell = (e) => { e.preventDefault(); toast('이 화면은 시안(미연결)입니다 · 실연결은 관제(Main)·조종(MDrive)만'); };
      a.addEventListener('click', tell); a.addEventListener('keydown', (e) => { if (e.key === 'Enter') tell(e); });
    }
  }
  let toastEl, toastT;
  function toast(t) {
    if (!toastEl) {
      toastEl = document.createElement('div'); toastEl.setAttribute('role', 'status');
      toastEl.style.cssText = 'position:fixed;left:50%;top:96px;transform:translateX(-50%);z-index:50;max-width:90vw;padding:8px 14px;border-radius:8px;background:rgba(8,11,14,.9);color:#E6EBEF;font-size:13px;pointer-events:none';
      document.body.append(toastEl);
    }
    toastEl.textContent = t; toastEl.style.display = 'block'; clearTimeout(toastT); toastT = setTimeout(() => { toastEl.style.display = 'none'; }, 3000);
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
      roleTxt: role === 'control' ? '조종권 · 이 기기' : role === 'view_other' ? '다른 기기가 조종 중' : '보기 전용',
      latch: !!(linkOk && st.latch),
      flags: `online_ready=${fl(s && s.online_ready)} · safe_fallback_verified=${fl(s && s.safe_fallback_verified)}`,
      body: !s ? '몸 상태 미연결' : s.fallen === true ? '넘어짐' : s.fallen == null ? '넘어짐 미확인'
        : s.body_still === true ? '몸 정지' : `실측 ${ok(s.vx) && ok(s.vy) ? Math.hypot(s.vx, s.vy).toFixed(2) + ' m/s' : '속도 미확인'}`,
      // 서버가 지금 보내는 명령(누가 조종하든 같은 값). 링크가 끊기면 모름.
      sent: linkOk ? `앞 ${sgn(st.applied[0])} m/s · 회전 ${sgn(st.applied[2])} rad/s` : '미확인',
    };
  }
  function stopNow() { dropAll(); send({ op: 'stop' }); }
  function resumeNow() { dropAll(); send({ op: 'resume' }); }
  function resetNow() { dropAll(); send({ op: 'reset' }); }
  function wireStop() {
    $('button[aria-label="비상 정지"]').addEventListener('pointerdown', stopNow);
    addEventListener('keydown', (e) => { if (e.code === 'Space') { e.preventDefault(); stopNow(); } });
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
  const disable = (el, why) => { if (el) { el.disabled = true; el.setAttribute('aria-disabled', 'true'); el.title = why; el.style.opacity = '.45'; el.style.cursor = 'not-allowed'; } };
  const setDis = (b, off) => { b.disabled = off; b.style.opacity = off ? '.45' : ''; };

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
    disable(radios[0], '저속 미검증 — 시험한 속도는 0.6 m/s 뿐'); radios[1].title = '앞 0.6 m/s (시험한 값)';
    disable(byText('button.pill', '자세'), '자세 명령 미연결');
    for (const g of $$('.glass[role="group"]')) stick(g);
    wireStop();
    return { huds, banner, mm, resume: bigBtn('STOP 해제', resumeNow), reset: bigBtn('시뮬 리셋', resetNow) };
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
      if (role !== 'control') { send({ op: 'take' }); return; }      // 첫 누름은 조종권만 얻는다 — 손 떼고 다시 눌러야 움직임
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
    D.mm.append('지도 미연결', document.createElement('br'),
      s ? `위치 출처 ${v.src}` : '위치 미연결', document.createElement('br'),
      s ? `x ${sgn(s.x)} y ${sgn(s.y)} m · 방향 ${ok(s.yaw) ? (s.yaw * 180 / Math.PI).toFixed(0) + '°' : '미확인'}` : '');
    // 가운데 알림: 끊김·STOP·리셋·넘어짐·미검증 입력 — 없으면 숨김
    const msgs = [];
    if (!v.linkOk) msgs.push(`링크 ${v.linkTxt} · 명령 0`);
    else {
      if (st.sim_block) msgs.push(`${st.sim_block} · 명령 0`);
      if (st.reset_pending) msgs.push('시뮬 리셋 처리 중 · STOP 유지');
      else if (st.resume_pending) msgs.push('STOP 해제 확인 대기 · 명령 0');
      else if (v.latch) msgs.push(`STOP 요청 · 명령 0 잠금 · ${v.body} · ${RELURCH}`);
      if (s && s.fallen === true) msgs.push('넘어짐 · 시뮬 리셋 필요');
      if (st.reason && !v.latch && !st.sim_block && st.reason !== '조종권 없음') msgs.push(st.reason);
      if (role !== 'control') msgs.push(role === 'view_other' ? '다른 기기가 조종 중 · 보기 전용' : '막대를 한 번 눌러 조종권 얻기');
    }
    paintCam(v);
    const b = D.banner; b.textContent = '';
    b.style.display = msgs.length ? 'flex' : 'none';
    b.append(msgs.join(' · '));
    const can = v.linkOk && role === 'control' && !st.reset_pending && !st.resume_pending;
    if (can && v.latch) b.append(D.resume);
    if (can && (v.latch || (s && s.fallen === true))) b.append(D.reset);
  }

  // ---- PC 관제 Main ----
  function setupMain() {
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
    for (const b of $$('button.layer, button.ibtn', map)) disable(b, '지도 미연결');
    for (const n of $$('button.layer .mono', map)) n.textContent = '—';   // 시안 예시 개수(발견물 2) → 미연결
    const legend = byText('div', '지나온 경로', map); if (legend) legend.style.visibility = 'hidden';
    const stepHead = byText('span', '경과', map); const stepList = $('.step', map)?.parentElement;
    if (stepList) stepList.style.visibility = 'hidden';
    const vsec = $('section[aria-label="영상과 측정"]');
    const vsvg = $('svg', vsec); vsvg.parentElement.style.position = 'relative'; camInto(vsvg);
    const vlabel = byText('span', '전방 RGB', vsec); const rec = byText('div', '기록 중', vsec); if (rec) rec.style.visibility = 'hidden';
    for (const t of ['전방', '뎁스', '사진 찍기']) disable(byText('button', t, vsec), '미연결');
    disable($('button[aria-label="영상 크게 보기"]', vsec), '미연결');
    const bar = byText('button.btn', '일시정지', vsec).parentElement, [b1, b2, b3] = $$('button.btn', bar);
    const motion = $(':scope > span', bar);
    // 임무 예시 패널(확인·탐지·가스)은 실연결 중 숨긴다 — 임무·AI·가스는 미연결
    for (const t of ['이 지점에서 할 일', 'AI 탐지', '가스 측정']) { const h = byText('span', t, vsec); if (h) h.parentElement.parentElement.style.display = 'none'; }
    const evBox = byText('span', '사건 기록', vsec).parentElement.parentElement;
    b1.lastChild.textContent = 'STOP 해제'; b1.addEventListener('click', resumeNow);
    b2.addEventListener('click', () => { dropAll(); send({ op: role === 'control' ? 'release' : 'take' }); });
    b3.lastChild.textContent = '시뮬 리셋'; b3.addEventListener('click', resetNow);
    const K = { ArrowUp: ['fx', 1], ArrowDown: ['fx', -1], ArrowLeft: ['fw', 1], ArrowRight: ['fw', -1] };
    addEventListener('keydown', (e) => {
      const k = K[e.key]; if (!k) return; e.preventDefault();
      if (e.repeat || role !== 'control') return;          // 키보드 조종은 «직접 조종»으로 조종권을 얻은 뒤 새로 누른 키만
      keys.set(e.key, { fx: 0, fy: 0, fw: 0, [k[0]]: k[1] }); merge();
    });
    addEventListener('keyup', (e) => { if (keys.delete(e.key)) merge(); });
    wireStop();
    return { siteLine, stepTitle, modeEl, opRole, cv, mapSvg, mapTitle, stepHead, vlabel, b1, b2, b3, motion, evBox, chips: $$('.chip', H), trail: [], ep: null };
  }
  function chip(c, k, v, good) {
    c.className = 'chip ' + (good ? 'ok' : 'warn');
    c.querySelector('.mk').textContent = good ? '●' : '▲'; c.children[1].textContent = k; c.children[2].textContent = v;
  }
  function paintMain(M) {
    const v = view(), s = v.s;
    M.siteLine.textContent = TRIAL;
    M.stepTitle.textContent = '직접 조종 시험 · 임무 없음'; M.stepTitle.title = v.flags;   // 원문 플래그는 툴팁으로
    M.modeEl.textContent = !v.linkOk ? '링크 끊김' : st.reset_pending ? '리셋 중' : st.resume_pending ? 'STOP 해제 대기' : v.latch ? 'STOP 요청' : role === 'control' ? '직접 조종' : '보기 전용';
    if (M.opRole) M.opRole.textContent = v.roleTxt;
    chip(M.chips[0], '링크', v.linkTxt, v.linkOk && !st.sim_block);
    chip(M.chips[1], '위치', s ? (s.source === 'gz_gt' ? 'Gazebo GT' : v.src) : '미연결', !!s);
    chip(M.chips[2], '영상', v.camTxt, v.camOk);
    chip(M.chips[3], '배터리', '미연결', false);
    M.mapTitle.textContent = s ? `지도 미연결 · 선은 ${v.src} 위치(지도 아님) · x ${sgn(s.x)} y ${sgn(s.y)} m` : '지도 미연결 · 위치 미연결';
    if (M.stepHead) M.stepHead.textContent = '임무 미연결';
    M.vlabel.textContent = v.camOk ? `Gazebo 렌더 카메라(실카메라 아님) · ${v.camTxt}` : `카메라 ${v.camTxt}`;
    paintCam(v);
    const ctl = v.linkOk && role === 'control', busy = v.linkOk && (st.reset_pending || st.resume_pending);
    setDis(M.b1, !(ctl && v.latch && !busy));
    M.b2.lastChild.textContent = role === 'control' ? '조종 놓기' : '직접 조종';
    setDis(M.b2, !v.linkOk || role === 'view_other');
    setDis(M.b3, !(ctl && !busy));
    // 보낸 명령(서버 출력, 누구에게나 같은 값)과 시뮬 실측을 따로 적는다
    M.motion.textContent = `보낸 명령 ${v.sent} · 시뮬 ${v.body}` + (s ? ` · 기울기 ${num(s.tilt_deg, 0, '°')}` : '')
      + (v.linkOk && st.reason && st.reason !== '조종권 없음' ? ` · ${st.reason}` : '') + (role === 'control' ? ' · ↑ 앞 0.6 · ↑+←/→ 회전' : '')
      + ` · 주의: ${RELURCH}`;
    for (const e of $$('.ev', M.evBox)) e.remove();
    for (const e of (st ? st.events : []).slice(0, 5)) {
      const r = document.createElement('div'); r.className = 'ev';
      r.innerHTML = '<span class="mono"></span><span class="em"></span><span></span>';
      r.children[0].textContent = e.t; r.children[1].className = 'em ' + e.st; r.children[1].textContent = { ok: '●', warn: '▲', bad: '■' }[e.st] || '·';
      r.children[2].textContent = e.text; M.evBox.append(r);
    }
    if (st && st.episode !== M.ep) { M.trail = []; M.ep = st.episode; }   // 새 에피소드면 지나온 선을 새로
    if (s && ok(s.x) && ok(s.y)) {
      const p = M.trail[M.trail.length - 1];
      if (!p || Math.hypot(p[0] - s.x, p[1] - s.y) > 0.02) M.trail.push([s.x, s.y]);
      if (M.trail.length > 2000) M.trail.shift();
    }
    drawTrail(M, s && ok(s.x) && ok(s.y) ? s : null);
  }
  function drawTrail(M, s) {   // 지도 없이 위치만: 1 m 격자, 지나온 선, 로봇 방향
    const r = M.mapSvg.getBoundingClientRect(), pr = M.mapSvg.parentElement.getBoundingClientRect();
    const cv = M.cv; cv.style.left = (r.left - pr.left) + 'px'; cv.style.top = (r.top - pr.top) + 'px';
    cv.style.width = r.width + 'px'; cv.style.height = r.height + 'px'; cv.width = r.width; cv.height = r.height;
    const g = cv.getContext('2d'), W = r.width, Hh = r.height; g.clearRect(0, 0, W, Hh);
    const pts = M.trail.concat(s ? [[s.x, s.y]] : []);
    const xs = pts.map((p) => p[0]).concat(0), ys = pts.map((p) => p[1]).concat(0);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const span = Math.max(4, Math.max(...xs) - Math.min(...xs) + 2, Math.max(...ys) - Math.min(...ys) + 2);
    const sc = Math.min(W, Hh) / span, X = (x) => W / 2 + (x - cx) * sc, Y = (y) => Hh / 2 - (y - cy) * sc;
    g.strokeStyle = 'rgba(128,140,150,.25)'; g.lineWidth = 1;
    for (let i = Math.floor(cx - W / sc / 2); i <= cx + W / sc / 2; i++) { g.beginPath(); g.moveTo(X(i), 0); g.lineTo(X(i), Hh); g.stroke(); }
    for (let j = Math.floor(cy - Hh / sc / 2); j <= cy + Hh / sc / 2; j++) { g.beginPath(); g.moveTo(0, Y(j)); g.lineTo(W, Y(j)); g.stroke(); }
    g.fillStyle = '#9AA7B2'; g.font = '12px sans-serif'; g.fillText('격자 1 m · 시작점 +', 8, Hh - 8);
    g.strokeStyle = '#9AA7B2'; g.beginPath(); g.moveTo(X(0) - 6, Y(0)); g.lineTo(X(0) + 6, Y(0)); g.moveTo(X(0), Y(0) - 6); g.lineTo(X(0), Y(0) + 6); g.stroke();
    if (!pts.length) return;
    g.strokeStyle = '#38C6D9'; g.lineWidth = 3; g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(X(p[0]), Y(p[1])) : g.moveTo(X(p[0]), Y(p[1])))); g.stroke();
    if (s && ok(s.yaw)) {
      g.save(); g.translate(X(s.x), Y(s.y)); g.rotate(-s.yaw); g.fillStyle = s.fallen === true ? '#FF5A4F' : '#38C6D9';
      g.beginPath(); g.moveTo(14, 0); g.lineTo(-10, 9); g.lineTo(-5, 0); g.lineTo(-10, -9); g.closePath(); g.fill(); g.restore();
    }
  }

  let D, M;
  function paint() { if (D) paintDrive(D); if (M) paintMain(M); }
  function boot() {
    if (!document.getElementById('dc-root')) return setTimeout(boot, 50);
    if (location.pathname.endsWith('MDrive.dc.html')) D = setupDrive();
    else if (location.pathname.endsWith('Main.dc.html')) M = setupMain();
    else return;
    guardLinks(); paint(); connect();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
