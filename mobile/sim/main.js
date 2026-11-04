// 앱 안 오프라인 시뮬(RS-6 창고 브라우저 시뮬을 옮김): 창고 f1 안에서 Go2 를 두 막대로 걷게 한다. 서버·인터넷 없이 앱 번들(www/sim)만 읽는다.
// go2-demo는 예외: 웹 세션의 로봇 상태 GET만 읽어 실기 자세를 그리며 정책·물리·명령은 실행하지 않는다.
// 지도 = ?map=<이름>(maps.json 목록 안, [a-z0-9-] 만 — 없거나 틀리면 warehouse) → assets/<이름>/ 의 scene.json·map.json·<이름>.xml.
// 물리 = MuJoCo wasm(창고 충돌체 + Go2), 그림 = three.js, 정책 = nvidia-demo 파생(sim.js 순수 JS 추론), 라이다 = mj_multiRay 360줄 10 Hz.
// RS-6 에서 바뀐 것: 보이는 글자 0(아이콘·색만) · STOP 은 «다시 시작» 아이콘으로만 풀림(막대를 만져도 안 풀림) · 앱 숨김·화면 꺼짐 = STOP
// · 막대 밖 한 손가락 끌기 = 따라가기 돌리기/탑뷰 이동, 두 손가락 = 확대·축소. 정책 계약은 policy-adapters.js 에서 id 로 고른다.
import * as THREE from './vendor/three.module.js';
import load from './mujoco/mujoco.js';
import { createSim, ISAAC_LIKE } from './sim.js';
import { POLICY_MODES, DEFAULT_POLICY_ID, getPolicyMode as getPolicyAdapter } from './policy-modes.js';
import { ame2Joystick } from './ame2-adapter.js';
import { topFrame, topPoint } from './top-fit.js';
import { makeLidar, decodeMap, cell } from './lidar.js';
import { validateScenarios, createScenarioRunner, frontDistance, bindScenarioInterrupts } from './scenario.js';
import { CLEARANCE, inflate, fits, findPath, planRoute } from './astar.js';
import { MIN_UP } from './walk-surface.js';
import { loadSimSettings, simSettings } from './settings.js';
import { manualSettings, manualCommand, commandCaps, modeCapText } from './manual-settings.js';
import { createFrameClock } from './frame-clock.js';
import { startDemoMapMode } from './start-demo-adapter.js';
import { createReplayReader, replayRequirement } from './go2-replay.js';

let adapter = getPolicyAdapter(), selectionError = null;
try { adapter = getPolicyAdapter(new URLSearchParams(location.search).get('policy') ?? DEFAULT_POLICY_ID); }
catch (e) { selectionError = e; }
const DEFAULT_POLICY_BACKEND = 'wasm';
const START_DRAW_MAX_GAP_MS = 100;
let startMapMode = 'gt';
try {
  if (adapter.depth) {
    startMapMode = startDemoMapMode(new URLSearchParams(location.search).get('startMap') ?? 'gt');
    adapter = { ...adapter, onnx: { ...adapter.onnx, file: adapter.onnx.files[startMapMode] } };
  }
} catch (e) { selectionError = e; }
const POLICY_DT = adapter.timing.policyDt;
const readonly = adapter.command.kind === 'none';
const FLOOR_RGB = [[255, 60, 60], [255, 193, 7], [66, 165, 245], [171, 71, 188]];   // 층 지도 색(1층 = 예전 한 층 지도 빨강)
const neutral = () => adapter.stop.input.slice();

const $ = (id) => document.getElementById(id);
const MESHES = ['base_0', 'base_1', 'base_2', 'base_3', 'base_4', 'hip_0', 'hip_1', 'thigh_0', 'thigh_1', 'thigh_mirror_0',
  'thigh_mirror_1', 'calf_0', 'calf_1', 'calf_mirror_0', 'calf_mirror_1', 'foot'];
const get = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(`${u} ${r.status}`); return r; };
const bytes = async (u) => new Uint8Array(await (await get(u)).arrayBuffer());
const json = async (u) => (await get(u)).json();
const backendFor = (mode) => {
  const params = new URLSearchParams(location.search);
  return params.get('policyBackend') ?? (mode.command.kind === 'nearby_goal' ? params.get('ame2Backend') : null) ?? (mode.fallback === null ? 'wasm' : DEFAULT_POLICY_BACKEND);
};
const st = (window.__sim = { ready: false, err: null });   // 시험용(headless) — 화면에는 안 보임

// ── STOP 잠금: 명령 0. «다시 시작»(#go)만 푼다. 잡고 있던 막대 손가락도 놓게 해서 풀린 뒤엔 새로 누른 손가락만 명령이 된다
let heading = null;
const goalAxes = [0, 0, 0];
let joy = neutral(), stopped = true, sim = null, ready = false, onLock = null;   // onLock = 찍은 점 가기가 찾던 길을 버림
const sticks = [];
let inputSettings = manualSettings({}, adapter.command), refreshSettings = async () => {}, startEpoch = 0, clock;
let applySettings = () => {};
function lock() {
  startEpoch++; clock?.reset();
  stopped = true; joy = neutral(); onLock?.();
  if (sim) { sim.cmd = neutral(); sim.cancelPolicyStep(); }
  if (adapter.command.kind === 'nearby_goal') { heading = null; goalAxes.fill(0); sim?.clearPolicyState(); }
  sticks.forEach((s) => s.release());
  ui();
}
function ui() {
  document.body.classList.toggle('stopped', stopped);
  $('stop').setAttribute('aria-pressed', String(stopped));
  $('go').hidden = readonly || !stopped || !ready;
}
$('stop').addEventListener('pointerdown', lock);   // 누르는 순간(click 은 손을 뗄 때라 늦다)
const scenarioPanel = $('scenarioPanel'), scenarioMenu = $('scenarioMenu');
const showScenarioPanel = (open) => {
  scenarioPanel.hidden = !open;
  scenarioMenu.setAttribute('aria-expanded', String(open));
};
scenarioMenu.onclick = () => showScenarioPanel(scenarioPanel.hidden);
// 바깥 누름은 닫기만: 손을 뗄 때의 목표 찍기·click 단추와 끌기까지 capture 단계에서 막는다.
// STOP·조종 입력은 자식 SVG 를 눌러도 전달한다. 시나리오 중 막대는 기존 hand 중단·잠금을 먼저 거친다.
const scenarioDismissPointers = new Set();
const swallowScenarioPress = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
document.addEventListener('pointerdown', (e) => {
  scenarioDismissPointers.delete(e.pointerId);   // 같은 포인터의 다음 누름은 정상 입력
  if (scenarioPanel.hidden || scenarioPanel.contains(e.target) || scenarioMenu.contains(e.target)) return;
  showScenarioPanel(false);
  if (['stop', 'stickL', 'stickR', 'keys'].some((id) => $(id).contains(e.target))) return;
  scenarioDismissPointers.add(e.pointerId);
  swallowScenarioPress(e);
}, { capture: true, passive: false });
for (const type of ['pointermove', 'pointerup', 'pointercancel', 'click']) {
  document.addEventListener(type, (e) => {
    // 일부 WebView 의 click 은 PointerEvent 대신 MouseEvent 다. 키보드 click(detail=0)은 통과.
    if (!scenarioDismissPointers.has(e.pointerId) && !(type === 'click' && e.pointerId === undefined && e.detail > 0 && scenarioDismissPointers.size)) return;
    swallowScenarioPress(e);
    if (type === 'click' && e.pointerId === undefined) scenarioDismissPointers.clear();
    else if (type === 'click' || type === 'pointercancel') scenarioDismissPointers.delete(e.pointerId);
  }, { capture: true, passive: false });
}
document.addEventListener('keydown', (e) => { if (e.code === 'Escape') showScenarioPanel(false); });
$('stop').onclick = lock;                            // 키보드·읽어 주기
$('go').onclick = async () => {
  if (readonly || !ready || !stopped) return;
  const epoch = ++startEpoch, org = await refreshSettings();
  if (epoch !== startEpoch || !stopped) return;
  applySettings(org); clock?.reset();
  sticks.forEach((s) => s.release()); stopped = false; ui();
};
document.addEventListener('visibilitychange', () => { if (document.hidden) lock(); });   // 앱 숨김·화면 꺼짐
for (const ev of ['pagehide', 'freeze', 'blur']) addEventListener(ev, lock);
// 집: 서버 화면(«시뮬 열기», ?from=server)에서 왔으면 뒤로 = 그 서버 화면(RemoteClient 가 /sim/ 에서는 고른 서버를 잊지 않음),
// 웹(같은 출처 /sim/, ?from=web)이면 웹 «시뮬» 화면(폰 틀은 로봇 연결로 바뀜), 아니면 앱 시작 화면
const from = new URLSearchParams(location.search).get('from'), fromServer = from === 'server' && history.length > 1;
$('home').onclick = () => { lock(); if (fromServer) history.back(); else location.href = from === 'web' ? '../#/sim' : '../index.html'; };
addEventListener('contextmenu', (e) => e.preventDefault());

// ── 막대 두 개(RS-5 배치): 왼쪽 위·아래 = vx ±1, 좌우 = vy ±0.5 / 오른쪽 좌우 = wz ±1. 학습 범위 밖은 자르지 않고 테두리 색으로만 알림
function stick(el, set) {
  const knob = el.querySelector('b');
  let id = null;
  const release = () => { if (id !== null && el.hasPointerCapture(id)) el.releasePointerCapture(id); id = null; knob.style.transform = ''; set(0, 0); };
  const move = (e) => {
    const r = el.getBoundingClientRect(), R = r.width / 2;
    let x = (e.clientX - r.left - R) / R, y = (e.clientY - r.top - R) / R;
    const n = Math.hypot(x, y);
    if (n > 1) { x /= n; y /= n; }
    knob.style.transform = `translate(${x * R * 0.7}px, ${y * R * 0.7}px)`;
    set(x, y);
  };
  el.addEventListener('pointerdown', (e) => { if (stopped || id !== null) return; id = e.pointerId; el.setPointerCapture(id); move(e); });
  el.addEventListener('pointermove', (e) => { if (e.pointerId === id && !stopped) move(e); });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) el.addEventListener(ev, (e) => { if (e.pointerId === id) release(); });
  sticks.push({ release });
}
const r2 = (v) => +v.toFixed(2) || 0; // −0 → 0
const stickAxes = [0, 0, 0];
const updateStickAxes = () => {
  const axes = adapter.command.kind === 'nearby_goal' ? goalAxes : joy;
  axes.splice(0, 3, ...manualCommand(stickAxes, inputSettings).map(r2));
};
stick($('stickL'), (x, y) => { stickAxes[0] = -y; stickAxes[1] = -x; updateStickAxes(); });
stick($('stickR'), (x) => { stickAxes[2] = -x; updateStickAxes(); });
const inRange = (c) => adapter.command.inRange(c);

// ── 키(컴퓨터는 조이스틱을 숨김 — index.html 의 (hover: hover) and (pointer: fine)): 실기 웹 조종칸(serverdrive)과 같게 ↑·W / ↓·S = 앞·뒤,
// ← / → = 옆걸음(왼 막대 좌우), A / D = 제자리 회전(오른 막대), 막대를 끝까지 민 값과 같다. 떼면 0. 학습 범위 밖은 자르지 않고 테두리 색만
// STOP 중에 누른 키와 잠글 때 쥐고 있던 키는 버린다(반복 keydown 무시) — «다시 시작» 뒤 새로 눌러야 움직인다. Esc·Space = STOP. 입력칸·고르기 칸에서는 조종 안 함
const KEYS = { ArrowUp: [0, 1], KeyW: [0, 1], ArrowDown: [0, -1], KeyS: [0, -1], ArrowLeft: [1, 1], ArrowRight: [1, -1], KeyA: [2, 1], KeyD: [2, -1] };
const held = new Set();
const keyAxes = () => {   // 축마다 방향 하나씩(↑+W 도 끝 값 — 막대 범위를 넘지 않음), 반대 방향 둘 다면 0
  const axes = adapter.command.kind === 'nearby_goal' ? goalAxes : joy, on = (i, v) => [...held].some((k) => KEYS[k][0] === i && KEYS[k][1] === v);
  axes.splice(0, 3, ...manualCommand([0, 1, 2].map((i) => on(i, 1) - on(i, -1)), inputSettings, true).map(r2));
};
const dropKeys = () => { held.clear(); keyAxes(); };
sticks.push({ release: dropKeys });   // lock()·#go·시나리오 실행이 막대와 함께 놓는다
const field = (t) => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || !!t?.isContentEditable;
addEventListener('keydown', (e) => {
  if (e.code === 'Escape') return lock();
  if (e.key === 'Meta' || e.key === 'Control' || e.key === 'Alt') return dropKeys();   // 단축키 시작 — macOS 는 Cmd 뒤 keyup 이 안 올 수 있음(웹 simdrive 와 같음)
  if (e.ctrlKey || e.metaKey || e.altKey || field(e.target)) return;
  if (e.code === 'Space') { e.preventDefault(); return lock(); }   // 초점 있는 단추(#go 등)가 눌리지 않게
  if (!(e.code in KEYS)) return;
  e.preventDefault();
  if (stopped || e.repeat) return;
  held.add(e.code); keyAxes();
});
addEventListener('keyup', (e) => {
  if (e.code === 'Space' && !field(e.target)) e.preventDefault();   // 단추는 Space 를 뗄 때 눌린다
  if (held.delete(e.code)) keyAxes();
});

try {
  if (selectionError) throw selectionError;
  await preparePolicies();
  await main();
} catch (e) {
  st.err = String(e?.stack || e);
  console.error(e);
  $('busy').hidden = true; $('fail').removeAttribute('hidden');
  const option = Array.from($('policySelect').options).find((x) => x.value === adapter.id);
  if (option) option.disabled = true;
  $('policyReason').textContent = e.message;
  if (selectionError || !$('policyEngine').textContent) $('policyEngine').textContent = e.message;
  $('policyEngine').hidden = false;
}

async function preparePolicies() {
  const choice = $('policySelect'), reason = $('policyReason');
  choice.replaceChildren(...Object.values(POLICY_MODES).map((mode) => new Option(mode.label, mode.id)));
  choice.value = adapter.id;
  const replayOption = Array.from(choice.options).find((x) => x.value === POLICY_MODES.go2.id);
  const replayReason = replayRequirement(new URL(location.href));
  replayOption.disabled = !!replayReason;
  if (replayReason) replayOption.textContent += ` · ${replayReason}`;
  choice.onchange = () => {
    lock();
    const mode = getPolicyAdapter(choice.value);
    const url = new URL(location.href); url.searchParams.set('policy', mode.id);
    location.href = url.href;
  };
  const mapChoice = $('startMapSelect');
  $('startMapLabel').hidden = !adapter.depth; mapChoice.hidden = !adapter.depth;
  mapChoice.value = startMapMode;
  mapChoice.onchange = () => {
    lock();
    const url = new URL(location.href); url.searchParams.set('startMap', mapChoice.value);
    location.href = url.href;
  };
  const ame2 = POLICY_MODES.ame2;
  const option = Array.from(choice.options).find((x) => x.value === ame2.id);
  const exists = async (file) => {
    const response = await fetch(file, { method: 'HEAD' }).catch(() => null);
    return response?.ok && !/^text\/html(?:\s*;|\s*$)/i.test(response.headers.get('content-type') ?? '');
  };
  const start = POLICY_MODES.start;
  const startAvailable = (await Promise.all([...new Set(Object.values(start.onnx.files))].map(exists))).every(Boolean);
  const startOption = Array.from(choice.options).find((x) => x.value === start.id);
  startOption.disabled = !startAvailable;
  if (!startAvailable) startOption.textContent = `${start.label} · ONNX 파일 없음`;
  const [onnxAvailable, weightsAvailable, manifest] = await Promise.all([
    exists(ame2.onnx.file), exists(ame2.network.file), json(ame2.network.manifest).catch(() => null),
  ]);
  const f32Available = weightsAvailable && manifest?.schema === 'ame2-f32-v1';
  const backend = backendFor(ame2);
  const available = backend === 'f32' ? f32Available
    : ['wasm', 'webgpu'].includes(backend) && (onnxAvailable || f32Available);
  if (option) option.disabled = !available;
  reason.textContent = available ? 'AME-2: 실기 불가 · 참 높이지도 · 관절 순서 가정'
    : backend === 'f32' ? 'AME-2 · JS f32 파일 또는 배치표 없음' : 'AME-2 · ONNX와 JS f32 파일 없음';
  // A URL selecting AME-2 stays on that mode: its own optional f32 can recover.
  if (readonly) {
    reason.textContent = replayReason || '실기 보기 전용';
    if (replayReason) throw new Error(replayReason);
  }
}

async function main() {
  const settings = {}; // Runner snapshots this at start; never mutate during a run.
  const failedSettings = Symbol('settings unavailable');
  let lastOrg = {};
  refreshSettings = async () => {
    const org = await loadSimSettings(new URL(location.href), globalThis.fetch, undefined, failedSettings);
    // Failed fetch keeps the last successful response; invalid/missing fields
    // in a successful response still fall back individually to defaults.
    if (org !== failedSettings) lastOrg = org;
    return lastOrg;
  };
  applySettings = (org) => {
    const caps = commandCaps(adapter.command);
    Object.assign(settings, simSettings(org, { vx: caps.forward, wz: caps.turnInPlace }));
    inputSettings = manualSettings(org, adapter.command);
    $('modeCaps').textContent = modeCapText(adapter.command, inputSettings);
  };
  applySettings(readonly ? {} : await refreshSettings());
  const params = new URLSearchParams(location.search);
  const q = params.get('map') ?? '', maps = await json('maps.json');
  const id = /^[a-z0-9-]+$/.test(q) && maps.some((x) => x.id === q) ? q : 'warehouse', dir = `assets/${id}`;
  const [mj, sceneJ, mapJ] = await Promise.all([load(), json(`${dir}/scene.json`), json(`${dir}/map.json`)]);
  let fallbackPolicy = null;
  try {
    if (adapter.network) {
      const [polBuf, manifest] = await Promise.all([get(adapter.network.file).then((r) => r.arrayBuffer()), adapter.network.manifest ? json(adapter.network.manifest) : null]);
      if (adapter.network.sha256) {
        const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', polBuf)), (x) => x.toString(16).padStart(2, '0')).join('');
        if (digest !== adapter.network.sha256) throw new Error('가중치 SHA-256 불일치');
      }
      fallbackPolicy = adapter.loadPolicy(polBuf, manifest);
    }
  } catch (error) { st.fallbackUnavailable = error.message; }
  let map = decodeMap(mapJ);   // 로봇이 지금 선 층의 지도(찍기·시나리오 검사) — 여러 층이면 몸 높이로 바뀐다
  // 여러 층(top.json floors, z = 로봇 몸 높이 반열린 띠 [아래, 위)): 층마다 지도·시나리오 파일. 한 층이면 지금처럼 map.json·scenarios.json 하나
  const floors = await json(`${dir}/top.json`).then((t) => (t.floors?.length > 1 ? Promise.all(t.floors.map(async (f) => ({ id: f.id, name: f.name, z: f.z, scn: f.scenarios_file,
    map: decodeMap(await json(`${dir}/${f.map_file}`)) }))) : []), () => []);
  const layers = floors.length ? floors : [{ name: '', map }];
  const startFloor = Math.max(0, floors.findIndex((f) => f.id === params.get('floor')));
  if (floors.length) map = floors[startFloor].map;
  inflate(map);   // 선택한 층의 길 찾기 막힘 격자를 미리(쉬어 가며) 만들어 둔다
  let start = map.spawn_xyyaw.slice(), startReason = '';
  if (params.has('start')) {
    const fields = params.get('start').split(',').map((v) => v.trim());
    const values = fields.map(Number), [x, y] = values;
    if (![2, 3].includes(fields.length) || fields.some((v) => !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(v)) || !values.every(Number.isFinite)) startReason = '좌표·방향은 유한한 숫자여야 합니다';
    else if (x < map.origin[0] || y < map.origin[1] || x >= map.origin[0] + map.w * map.res || y >= map.origin[1] + map.h * map.res) startReason = '지도 밖';
    else if (cell(map, x, y) !== 254) startReason = '장애물·모르는 칸';
    else if (!(await fits(map, { x, y }))) startReason = `벽·물건에서 ${CLEARANCE} m 안`;
    else start = [x, y, values[2] ?? start[2]];
  }
  const startNote = startReason ? `고른 시작 위치를 쓸 수 없어 기본 위치에서 시작(${startReason})` : '';
  mj.FS.mkdir('/go2'); mj.FS.mkdir('/go2/assets');
  const physicsAssets = mapJ.physics_assets ?? [];
  if (!Array.isArray(physicsAssets) || physicsAssets.length > 8 || physicsAssets.some((f) => typeof f !== 'string' || !/^[a-z0-9_-]+\.png$/.test(f))) throw new Error('지형 파일 목록 형식');
  await Promise.all([
    bytes('assets/unitree_go2/go2.xml').then((b) => mj.FS.writeFile('/go2/go2.xml', b)),
    bytes(`${dir}/${id}.xml`).then((b) => mj.FS.writeFile('/go2/world.xml', b)),
    // MuJoCo include resources and the Go2 compiler use these two asset roots.
    ...physicsAssets.map(async (f) => { const b = await bytes(`${dir}/${f}`);
      mj.FS.writeFile(`/go2/${f}`, b); mj.FS.writeFile(`/go2/assets/${f}`, b); }),
    ...MESHES.map(async (f) => mj.FS.writeFile(`/go2/assets/${f}.obj`, await bytes(`assets/unitree_go2/assets/${f}.obj`))),
  ]);
  mj.FS.writeFile('/go2/scene.xml', `<mujoco model="go2 ${id}"><include file="go2.xml"/><include file="world.xml"/></mujoco>`);
  let policy = fallbackPolicy;
  if (!readonly) {
    const { selectOnnxPolicy } = await import('./policy-onnx.js');
    policy = await selectOnnxPolicy(adapter, policy, {
      worker: params.get('policyThread') !== 'main', // explicit comparison/recovery path
      backend: backendFor(adapter),
      notify: (text) => {
        st.policyEngine = text;
        st.ame2Engine = text; // existing diagnostics compatibility
        // Keep the engine/fallback reason visible during simulation.
        $('policyReason').textContent = `${text} · 시뮬 전용${st.policyUnavailable ? ' · ' + st.policyUnavailable : ''}`;
        $('policyEngine').textContent = `${text} · 시뮬 전용`;
      },
    });
  }
  sim = createSim(mj, '/go2/scene.xml', ISAAC_LIKE, policy, { floorZ: map.floor_z, spawn: start,
    resolveSpawnFloor: params.has('start') && !startReason, floorCeiling: floors[startFloor] ? floors[startFloor].z[1] - .4 : Infinity }, adapter.id, { ame2DelaySteps: 0, startMapMode });
  const { m, d } = sim;
  layers.forEach((layer, i) => sim.walkSurface?.attach(layer.map, floors[i] ? floors[i].z[1] - .4 : Infinity));
  const replay = readonly ? createReplayReader(sim, new URL(location.href)) : null;
  if (replay) {
    const timer = setInterval(() => { if (!document.hidden) void replay.poll(); }, 200);
    addEventListener('pagehide', () => clearInterval(timer), { once: true });
    void replay.poll();
    $('policyEngine').hidden = false;
    for (const id of ['stop', 'go', 'reset', 'stickL', 'stickR', 'keys']) {
      $(id).hidden = true; $(id).setAttribute('aria-disabled', 'true');
    }
  }
  const lidar = makeLidar(mj, m, d, 360, settings);
  const runner = createScenarioRunner(sim, () => stopped, settings);
  let scenarios = [];
  // 층 시나리오는 floor_id 가 그 층이고 지점이 그 층 지도의 빈 칸이어야 한다(floor = 층 번호)
  try { scenarios = floors.length ? (await Promise.all(floors.map(async (f, i) => validateScenarios(await json(`${dir}/${f.scn}`), f.map)
    .map((x) => { if (x.floor_id !== f.id) throw new Error('시나리오 층이 파일 층과 다름'); return { ...x, floor: i }; })))).flat()
    : validateScenarios(await json(`${dir}/scenarios.json`), map); }
  catch (e) { console.warn('시나리오를 읽지 못함', e); runner.status = '시나리오 없음'; }
  const select = $('scenarioSelect');
  for (const s of scenarios) { const o = document.createElement('option'); o.value = s.id; o.textContent = s.name; select.append(o); }
  const initialScenario = scenarios.find((s) => s.floor === startFloor);
  if (initialScenario) select.value = initialScenario.id;
  let scenarioText = '', here = startFloor, pin = null;   // here = 로봇이 선 층, pin = 볼 층(null 자동 = here, 'all' 전체, 층 번호)
  const away = () => { const c = scenarios.find((x) => x.id === select.value); return c && c.floor !== undefined && c.floor !== here ? c : null; };   // 다른 층 시나리오
  const scenarioUI = () => {
    if (readonly) {
      select.disabled = $('scenarioRun').disabled = $('scenarioHalt').disabled = true;
      $('scenarioStatus').textContent = '실기 보기 전용'; $('scenarioHint').hidden = true;
      return;
    }
    const far = away();
    const text = runner.active && runner.goal ? '찍은 곳으로 가는 중' : runner.active ? `지점 ${(runner.points[runner.index]?.mark ?? 0) + 1}/${runner.points.at(-1).mark + 1}`
      : far ? `${floors[far.floor].name} 시나리오 — 실행하면 ${floors[far.floor].name} 출발점에 다시 세워 시작` : runner.status;
    if (text !== scenarioText) { $('scenarioStatus').textContent = scenarioText = text; }
    select.disabled = runner.active || !scenarios.length;
    $('scenarioRun').disabled = !ready || stopped || runner.active || !scenarios.length;
    $('scenarioHalt').disabled = !runner.active;
    $('scenarioHint').hidden = !stopped;
  };
  const { hand } = bindScenarioInterrupts({ runner, lock, left: $('stickL'), right: $('stickR'), stop: $('stop'), doc: document, win: window, home: $('home'), reset: $('reset') });
  for (const el of [$('stickL'), $('stickR')]) el.addEventListener('pointerdown', () => { sim.cancelPolicyStep(); clock?.reset(); }, true);
  addEventListener('keydown', (e) => { if (e.code in KEYS && !e.repeat && !field(e.target)) { sim.cancelPolicyStep(); clock?.reset(); } }, true);
  // 막대를 누를 때처럼 조종 키도 실행을 끊는다 — 시나리오는 잠그고(키는 위 keydown 이 먼저 받았어도 lock 이 버린다), 찍은 곳 가기는 취소만(그 키로 바로 손 조종)
  addEventListener('keydown', (e) => { if (runner.active && e.code in KEYS && !e.repeat && !field(e.target) && !(e.ctrlKey || e.metaKey || e.altKey)) hand(); });

  $('scenarioHalt').onclick = () => { runner.cancel('중단'); lock(); scenarioUI(); };

  // ── three.js: Z-up
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const cv = renderer.domElement;
  document.body.prepend(cv);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x14171c);
  const followCamera = new THREE.PerspectiveCamera(55, 1, 0.05, 200);
  const topCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
  let camera = followCamera;   // 처음 = 따라가기(로봇 뒤 외부 카메라, 10-30)
  camera.up.set(0, 0, 1);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x404048, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(-4, -6, 10);
  scene.add(sun);
  const resize = () => { renderer.setSize(innerWidth, innerHeight); followCamera.aspect = innerWidth / innerHeight; followCamera.updateProjectionMatrix(); };
  addEventListener('resize', resize);
  resize();

  // 창고: scene.json 의 메시를 모델 자세에 놓는다. quat 은 w,x,y,z
  const geoCache = {}, textureCache = {}, solids = [];   // rendered scene + robot meshes
  for (const md of sceneJ.models) {
    let geo = geoCache[md.mesh];
    if (!geo) {
      const src = sceneJ.meshes[md.mesh];
      geo = geoCache[md.mesh] = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(src.p, 3));
      geo.setIndex(src.i);
      if (src.uv) geo.setAttribute('uv', new THREE.Float32BufferAttribute(src.uv, 2));
      geo.computeVertexNormals();
    }
    let texture = null;
    if (md.texture) {
      if (!/^[a-z0-9_-]+\.png$/.test(md.texture)) throw new Error('장면 재질 파일 형식');
      texture = textureCache[md.texture] ??= await new THREE.TextureLoader().loadAsync(`${dir}/${md.texture}`);
      texture.colorSpace = THREE.SRGBColorSpace;
      if (md.texture_repeat) texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    }
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: new THREE.Color(...md.color), map: texture, flatShading: !!md.flat_shading, side: THREE.DoubleSide }));
    mesh.position.set(...md.pos);
    mesh.quaternion.set(md.quat[1], md.quat[2], md.quat[3], md.quat[0]);
    scene.add(mesh); solids.push(mesh);
  }

  // 정답 지도(f1.png) 판: 점유 칸만 층 색으로(1층 빨강 — 한 층 지도도 같은 색), 위에서 보기 때만. DataTexture 행 0 = 아래라서 위아래를 뒤집는다
  const planes = layers.map(({ map: mp }, i) => {
    const tex = new Uint8Array(mp.w * mp.h * 4);
    for (let r = 0; r < mp.h; r++) for (let c = 0; c < mp.w; c++) {
      const v = mp.px[r * mp.w + c], o = ((mp.h - 1 - r) * mp.w + c) * 4;
      if (v === 0) tex.set([...FLOOR_RGB[i % FLOOR_RGB.length], 150], o); else if (v === 205) tex.set([120, 120, 140, 90], o);
    }
    const mapTex = new THREE.DataTexture(tex, mp.w, mp.h);
    mapTex.magFilter = THREE.NearestFilter; mapTex.needsUpdate = true;
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(mp.w * mp.res, mp.h * mp.res),
      new THREE.MeshBasicMaterial({ map: mapTex, transparent: true, depthWrite: false }));
    plane.position.set(mp.origin[0] + (mp.w * mp.res) / 2, mp.origin[1] + (mp.h * mp.res) / 2, mp.floor_z + 0.02);
    scene.add(plane);
    return plane;
  });

  // 두 시점 모두 선택한 지점과 점선 경로를 표시한다. 선택할 때만 geometry 갱신.
  const route = new THREE.Group();
  scene.add(route);
  const showRoute = () => {
    while (route.children.length) { const c = route.children[0]; route.remove(c); c.geometry.dispose(); c.material.dispose(); }
    const chosen = scenarios.find((s) => s.id === select.value);
    if (!chosen) return;
    const pts = chosen.points.map((p) => new THREE.Vector3(p.x, p.y, layers[chosen.floor ?? 0].map.floor_z + 0.07));
    const path = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color: 0x81c784, dashSize: 0.15, gapSize: 0.12, depthTest: false }));
    path.computeLineDistances(); route.add(path);
    route.add(new THREE.Points(new THREE.BufferGeometry().setFromPoints(pts), new THREE.PointsMaterial({ color: 0xe6e8eb, size: 9, sizeAttenuation: false, depthTest: false })));
  };
  select.onchange = () => { showRoute(); scenarioUI(); };
  showRoute();

  // Go2: 컴파일된 메시(group 2)를 geom 마다 그린다
  const geoms = [], meshGeo = new Map();
  for (let g = 0; g < m.ngeom; g++) {
    if (m.geom_group[g] !== 2 || m.geom_dataid[g] < 0) continue;
    const id = m.geom_dataid[g];
    if (!meshGeo.has(id)) {
      const va = m.mesh_vertadr[id], vn = m.mesh_vertnum[id], fa = m.mesh_faceadr[id], fn = m.mesh_facenum[id];
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(m.mesh_vert.slice(va * 3, (va + vn) * 3), 3));
      geo.setIndex(Array.from(m.mesh_face.slice(fa * 3, (fa + fn) * 3)));
      geo.computeVertexNormals();
      meshGeo.set(id, geo);
    }
    const mat = m.geom_matid[g], c = mat >= 0 ? m.mat_rgba.slice(mat * 4, mat * 4 + 3) : m.geom_rgba.slice(g * 4, g * 4 + 3);
    const mesh = new THREE.Mesh(meshGeo.get(id), new THREE.MeshLambertMaterial({ color: new THREE.Color(c[0], c[1], c[2]).multiplyScalar(0.85).addScalar(0.08) }));
    mesh.matrixAutoUpdate = false;
    scene.add(mesh); solids.push(mesh);
    geoms.push([g, mesh]);
  }
  const draw = () => {
    const p = d.geom_xpos, R = d.geom_xmat;
    for (const [g, mesh] of geoms) {
      const r = g * 9, o = g * 3;
      mesh.matrix.set(R[r], R[r + 1], R[r + 2], p[o], R[r + 3], R[r + 4], R[r + 5], p[o + 1], R[r + 6], R[r + 7], R[r + 8], p[o + 2], 0, 0, 0, 1);
    }
  };

  // 라이다는 안전 판정·다시 찾기에만 사용한다. 화면 점·광선·범위 그림은 만들지 않는다.
  let lastScan = 0, front = Infinity, rays = null;   // rays = 마지막 라이다 줄(다시 찾기에 앞 장애물로)
  const yawOf = () => 2 * Math.atan2(d.qpos[6], d.qpos[3]); // 기울기 무시한 근사(서 있을 때 충분)
  const scan = () => {
    const x = d.qpos[0], y = d.qpos[1], z = d.qpos[2] + 0.1, yaw = yawOf(), r = lidar(x, y, z, yaw);
    front = frontDistance(r); rays = r;
  };
  // 다른 층 시나리오 = 그 층 출발점(spawn_xyyaw)에 다시 세워 시작 — 월드 기준(datum 0)은 그대로, 몸 높이만 그 층 바닥 + 0.4(sim.reset 과 같음)
  const spawnOn = (i) => {
    const { spawn_xyyaw: [x, y, yaw], floor_z: z } = floors[i].map, q = d.qpos;
    sim.reset(); q[0] = x; q[1] = y; q[2] = z + 0.4; q[3] = Math.cos(yaw / 2); q[6] = Math.sin(yaw / 2);
    mj.mj_forward(m, d); sim.hold(0.5); clock?.reset(); pin = null; floorTick(q[2]);
  };
  $('scenarioRun').onclick = async () => {
    if (!ready || stopped || runner.active || busy) return;
    const chosen = scenarios.find((s) => s.id === select.value);
    if (!chosen) return;
    const far = away();
    if (far) spawnOn(far.floor);
    // 지점 사이도 찍은 점과 같은 A* 경유점으로 잇는다(안전 규칙은 실행기 그대로 — 막히면 멈춤, 다시 찾기는 찍은 점만)
    const at = pos(), g0 = gen;
    busy = true; runner.status = '길 찾는 중'; scenarioUI();
    const [pts, org] = await Promise.all([planRoute(map, at, chosen.points), refreshSettings()]).finally(() => { busy = false; });
    const why = stale(at, g0) || (pts ? '' : '갈 수 있는 길이 없습니다');   // 찾는 동안(큰 지도는 쉬어 가며) STOP·움직임이면 시작하지 않는다
    if (why) { runner.status = why; scenarioUI(); return; }
    sticks.forEach((s) => s.release());
    scan(); lastScan = performance.now();
    applySettings(org);
    sim.cancelPolicyStep(); clock?.reset();
    // A* keeps XY/mark only; retain an explicit arrival yaw at each destination.
    for (let i = 0; i < pts.length; i++) if (pts[i + 1]?.mark !== pts[i].mark && Number.isFinite(chosen.points[pts[i].mark]?.yaw)) pts[i].yaw = chosen.points[pts[i].mark].yaw;
    runner.start(pts);
    runner.tick(front); // 가까운 장애물은 실행 순간부터 0
    scenarioUI();
  };

  // ── 찍은 점 가기: 캔버스를 짧게 누르면(끌기·두 손가락 아님) 그 바닥 점으로 바로 간다. 가는 중에 누르면 그 자리를 끝에 줄 세우고(지금 목적지 그대로),
  // 한 목적지에 닿으면 그 고리는 사라지고 멈추지 않고 다음으로 — 마지막에 닿으면 멈춤. 목적지 사이는 층 지도 A*(astar.js) 경유점(선은 안 그림) — 길이 없으면 받지 않는다.
  // 막히면(앞 막힘·진전 없음) 지금 자리에서 앞 라이다 장애물을 더해 한 번만 다시 찾고, 또 막히면 멈춤. 안전 규칙은 시나리오와 같다(STOP·흐림·숨김·pagehide·reset = 취소+잠금).
  // 막대·키 = 취소만(손 조종 우선). 끝나거나 끊기면 남은 고리는 모두 지운다
  const ray = new THREE.Raycaster();
  let vp = [0, 0, 1, 1];   // 마지막으로 그린 칸(CSS px 왼쪽·위·폭·높이) — 누른 점을 그 칸의 카메라로 바닥에 비춘다
  const GOAL_END = { 완료: '도착했습니다', 막힘: '막혀서 멈췄습니다', 중단: '정지(잠금)로 목표를 취소했습니다', '손 조종': '손 조종으로 목표를 취소했습니다', 지움: '점을 지웠습니다' };
  let note = { text: '', until: 0 }, wasGoal = false, goalText = '';
  let marks = [], plan = [], retried = false;   // 목적지들(가는 중 차례), 가는 경유점(= runner.points, mark = 목적지 번호), 이번 출발에서 다시 찾았나
  // 길 찾기는 async(큰 지도는 쉬어 가며) — busy = 시나리오·다시 찾기 하나만, adding = 누른 점 차례로, gen = 지움·끊김·층 바뀜마다 +1(찾던 결과 버림)
  let busy = false, adding = Promise.resolve(), gen = 0;
  const say = (text) => { note = { text, until: performance.now() + 4000 }; };
  const pos = () => ({ x: d.qpos[0], y: d.qpos[1] });
  // 찾는 동안 바뀐 것이 있으면 그 까닭(출발하지 않음), 없으면 ''
  const stale = (at, g0) => stopped ? '정지(잠금)로 출발하지 않았습니다' : g0 !== gen ? '점이 바뀌어 출발하지 않았습니다'
    : runner.active ? '다른 실행 중입니다' : Math.hypot(d.qpos[0] - at.x, d.qpos[1] - at.y) > 0.2 ? '길 찾는 동안 움직였습니다 — 다시 누르세요' : '';
  // 예전(#211 앞) 노란 고리: 지금 가는 목적지만 진하게, 줄 선 다음 목적지는 흐리게. 지난 목적지는 안 그림
  const marksG = new THREE.Group(), ringGeo = new THREE.RingGeometry(0.12, 0.24, 32);
  const ringMat = [1, 0.3].map((opacity) => new THREE.MeshBasicMaterial({ color: 0xffd54f, depthTest: false, transparent: true, opacity }));
  scene.add(marksG);
  const curMark = () => (runner.active && runner.goal ? runner.points[runner.index]?.mark ?? 0 : 0);
  let shown = -1;   // 그린 고리의 지금 목적지 번호 — 바뀌면(닿으면) 다시 그린다
  const drawMarks = () => {
    marksG.clear(); shown = curMark();
    marks.forEach((p, i) => {
      if (i < shown) return;
      const r = new THREE.Mesh(ringGeo, ringMat[i === shown ? 0 : 1]);
      r.position.set(p.x, p.y, p.z + 0.03); r.renderOrder = 2; marksG.add(r);
    });
    $('wpClear').hidden = !marks.length;
  };
  // 앞 ±30° 1 m 안 라이다 점 = 지도에 없을 수 있는 장애물(다시 찾기에만 더함)
  const seen = () => {
    const out = [], yaw = yawOf(), n = rays?.length ?? 0;
    for (let i = 0; i < n; i++) {
      if (Math.min(i, n - i) * 2 * Math.PI / n > Math.PI / 6 || !(rays[i] <= 1)) continue;
      const a = yaw + (i * 2 * Math.PI) / n; out.push({ x: d.qpos[0] + Math.cos(a) * rays[i], y: d.qpos[1] + Math.sin(a) * rays[i] });
    }
    return out;
  };
  const begin = (p) => {
    plan = p;
    sticks.forEach((s) => s.release());
    scan(); lastScan = performance.now();
    runner.start(plan, true);
    drawMarks();
    runner.tick(front);   // 이미 닿았거나 막혔으면 바로 0
  };
  // 찍은 점 가기가 끝남(완료·막힘·취소) — 고리를 모두 지운다. 막힘이면 이번 출발에 한 번만 지금 자리에서 남은 목적지로 다시 찾는다
  const finish = () => {
    const left = marks.slice(runner.points[runner.index]?.mark ?? marks.length);
    const end = (why = GOAL_END[runner.status] ?? runner.status) => {
      if (runner.status !== '완료') gen++;   // 끊김 = 찾던 목적지도 버림(도착 뒤 찾던 점은 거기서 새로 출발)
      marks = []; plan = []; drawMarks();
      say(why + (runner.status !== '완료' && left.length ? ` — 남은 목적지 ${left.length}개 지움` : ''));
    };
    if (runner.status !== '막힘' || retried || !left.length || busy) return end();
    retried = true; busy = true; say('막혀서 지금 자리에서 길을 다시 찾는 중');
    marks = left;
    const at = pos(), g0 = gen, near = seen();
    adding.then(() => planRoute(map, at, marks.slice(), near)).finally(() => { busy = false; }).then((p) => {
      const why = stale(at, g0);
      if (why || !p) return end(why || '막혀서 멈췄습니다');
      begin(p);
      if (runner.active) return say('막혀서 지금 자리에서 길을 다시 찾았습니다');
      finish();
    });
  };
  const goTo = (cx, cy) => {
    if (readonly) return say('실기 보기 전용');
    const [l, t, w, h] = vp;
    if (!ready || cx < l || cy < t || cx > l + w || cy > t + h) return;
    if (stopped) return say('정지 중입니다 — ▶ 로 시작한 뒤 다시 누르세요');
    if (runner.active && !runner.goal) return say('시나리오 실행 중에는 찍어서 이동할 수 없습니다');
    if (busy) return say('길 찾는 중입니다 — 잠시 뒤 찍으세요');
    if (top && (pin ?? here) !== here) return say(`로봇이 선 층(${floors[here].name})을 볼 때만 찍을 수 있습니다`);
    ray.setFromCamera(new THREE.Vector2(((cx - l) / w) * 2 - 1, 1 - ((cy - t) / h) * 2), camera);
    const origin = ray.ray.origin.clone(), direction = ray.ray.direction;
    // Top view starts above the building. Enter the selected layer below its
    // ceiling, so upstairs floors/roof cannot steal a downstairs click.
    const ceiling = floors[here] ? floors[here].z[1] - .4 : Infinity;
    if (origin.z > ceiling && direction.z < 0) origin.addScaledVector(direction, (ceiling - origin.z) / direction.z);
    const hit = sim.walkSurface.pick(origin.toArray(), direction.toArray(), map, ceiling);
    if (!hit) return say('걸을 수 있는 바닥을 찍으세요');
    if (hit.up < MIN_UP) return say('벽·천장·가파른 면으로는 갈 수 없습니다');
    const ox = map.origin[0], oy = map.origin[1];
    if (hit.x < ox || hit.y < oy || hit.x >= ox + map.w * map.res || hit.y >= oy + map.h * map.res) return say('지도 밖은 갈 수 없습니다');
    if (cell(map, hit.x, hit.y) !== 254) return say('장애물·모르는 칸이라 갈 수 없습니다');
    const support = map.heightAt(hit.x, hit.y);
    if (hit.z >= ceiling || !Number.isFinite(support) || Math.abs(hit.z - support) > .05) return say('지금 층의 걸을 수 있는 바닥을 찍으세요');
    const p = { x: hit.x, y: hit.y, z: hit.z };
    const g0 = gen, f = map;   // 누른 순간의 세대·층 — 그 뒤 지움·끊김·층 바뀜이면 차례가 와도 버림
    adding = adding.then(() => addMark(p, g0, f));   // 누른 차례대로(앞 점 길 찾기가 끝난 뒤 그 점에서 잇는다)
  };
  // 끊김(STOP·흐림·숨김·pagehide·reset = lock, 막대·조종 키 = 손 조종) 순간 찾던 길·줄 선 누름을 모두 버린다 — 늦은 결과가 출발하거나 손 조종을 덮지 않게
  onLock = () => { gen++; };
  for (const el of [$('stickL'), $('stickR')]) el.addEventListener('pointerdown', () => { gen++; });
  addEventListener('keydown', (e) => { if (e.code in KEYS && !e.repeat && !field(e.target) && !(e.ctrlKey || e.metaKey || e.altKey)) gen++; });
  const going = () => runner.active && runner.goal && marks.length > 0;
  const addMark = async (p, g0, f) => {
    if (g0 !== gen || f !== map) return;
    if (!(await fits(f, p))) return g0 === gen && say(`벽·물건에서 ${CLEARANCE} m 안이라 갈 수 없습니다 — 조금 떨어진 곳을 찍으세요`);
    // 가는 중이면 마지막 목적지에서 잇고(끝에 줄 세움), 아니면 로봇 자리에서 바로 출발
    const was = going(), from = was ? marks.at(-1) : pos(), leg = await findPath(f, from, p);
    if (g0 !== gen || f !== map) return;   // 찾는 동안 지움·끊김·층 바뀜
    if (was && !going()) return runner.status === '완료' ? addMark(p, g0, f) : undefined;   // 찾는 동안 다 도착 = 지금 자리에서 새로, 끊김(손 조종·막힘)은 버림
    if (!leg) return say('갈 수 있는 길이 없습니다');
    if (was) {
      marks.push(p);
      plan.push(...leg.map((q) => ({ ...q, mark: marks.length - 1 })));   // plan = runner.points — 실행기가 끝에 이어 간다
      drawMarks();
      return say(`목적지 추가 — 남은 ${marks.length - curMark()}곳을 차례로 갑니다`);
    }
    const org = await refreshSettings();
    const why = stale(from, g0);
    if (why) return say(why);
    applySettings(org);
    sim.cancelPolicyStep(); clock?.reset();
    retried = false; note = { text: '', until: 0 };
    marks = [p];
    begin(leg.map((q) => ({ ...q, mark: 0 })));
    if (!runner.active) finish();
  };
  $('wpClear').onclick = () => {
    if (runner.active && runner.goal) runner.cancel('지움');
    gen++; marks = []; plan = []; drawMarks();
    if (!runner.active) { wasGoal = false; say(GOAL_END.지움); }
  };
  const goalUI = (now) => {
    const on = runner.active && runner.goal;
    if (wasGoal && !on && runner.goal) finish();
    wasGoal = runner.active && runner.goal;
    if (on && curMark() !== shown) drawMarks();   // 목적지에 닿음 = 그 고리 지우고 다음을 진하게
    const m = on && marks[curMark()];
    // 안내(추가·다시 찾음·끝남)는 4초, 그 밖에는 가는 중 진행
    const text = now < note.until ? note.text : m ? `찍은 곳으로 가는 중 · 목적지 ${curMark() + 1}/${marks.length} · ${Math.hypot(m.x - d.qpos[0], m.y - d.qpos[1]).toFixed(1)} m` : startNote;
    if (text !== goalText) { $('goalNote').textContent = goalText = text; $('goalNote').hidden = !text; }
  };

  // ── 따라가기: 기존 돌리기. 탑뷰: 끌어 이동·가리킨 곳 확대, 중심은 프레임 사이 보존.
  const view = { yaw: 0, pitch: Math.atan2(0.75, 1.7), dist: Math.hypot(0.75, 1.7), topH: 1, topRot: 0, topX: null, topY: null };
  let top = false;   // 단추 처음 상태(aria-pressed false·«위에서 보기»)는 index.html
  const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
  const topFit = () => topFrame(map, vp[2] / vp[3], view.topRot, view.topH, [view.topX, view.topY]);
  const centerTop = (x, y) => {
    const f = topFrame(map, vp[2] / vp[3], view.topRot, view.topH, [x, y]);
    view.topX = f.cx; view.topY = f.cy;
  };
  const pointAt = (x, y) => topPoint(topFit(), view.topRot, (x - vp[0]) / vp[2], (y - vp[1]) / vp[3]);
  const zoom = (k, x, y, toX = x, toY = y) => {
    if (!top) { view.dist = clamp(view.dist * k, 0.8, 8); return; }
    const before = pointAt(x, y);
    view.topH = clamp(view.topH * k, 0.08, 3);
    const after = pointAt(toX, toY), f = topFit();
    centerTop(f.cx + before[0] - after[0], f.cy + before[1] - after[1]);
  };
  const pan = (x, y, dx, dy) => {
    const a = pointAt(x, y), b = pointAt(x + dx, y + dy), f = topFit();
    centerTop(f.cx + a[0] - b[0], f.cy + a[1] - b[1]);
  };
  const ptrs = new Map();
  const pair = () => {
    const [a, b] = [...ptrs.values()];
    return { d: Math.hypot(a[0] - b[0], a[1] - b[1]), x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2 };
  };
  let pinch = null, tap = null;   // 8 px·0.5 s 안 짧은 누름만 목표; 다중 터치·취소는 목표 없음
  cv.addEventListener('pointerdown', (e) => {
    if (top && e.button !== 0) return;
    cv.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    pinch = ptrs.size === 2 ? pair() : null;
    tap = ptrs.size === 1 && e.button === 0 ? { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp } : null;
  });
  cv.addEventListener('pointerup', (e) => {
    // Event timestamps measure the press, even if rendering delays its handlers.
    if (tap?.id === e.pointerId && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) <= 8 && e.timeStamp - tap.t < 500) goTo(e.clientX, e.clientY);
    tap = null;
  });
  cv.addEventListener('pointermove', (e) => {
    const p = ptrs.get(e.pointerId);
    if (!p) return;
    const start = tap;
    if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 8) tap = null;
    if (ptrs.size === 1) {
      const dx = e.clientX - p[0], dy = e.clientY - p[1];
      if (top) { if (!tap) pan(p[0], p[1], start ? e.clientX - start.x : dx, start ? e.clientY - start.y : dy); }
      else { view.yaw -= dx * 0.006; view.pitch = clamp(view.pitch + dy * 0.006, 0.05, 1.45); }
    }
    p[0] = e.clientX; p[1] = e.clientY;
    if (ptrs.size === 2) {
      const next = pair();
      if (pinch?.d && next.d) zoom(pinch.d / next.d, pinch.x, pinch.y, next.x, next.y);
      pinch = next;
    }
  });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) cv.addEventListener(ev, (e) => { ptrs.delete(e.pointerId); pinch = null; tap = null; });
  for (const ev of ['blur', 'pagehide']) addEventListener(ev, () => { ptrs.clear(); pinch = null; tap = null; });
  cv.addEventListener('wheel', (e) => { e.preventDefault(); zoom(Math.exp(e.deltaY * 0.001), e.clientX, e.clientY); }, { passive: false });
  $('topCenter').onclick = () => { view.topH = 1; view.topRot = 0; view.topX = view.topY = null; };

  $('reset').onclick = () => { lock(); sim.reset(); sim.hold(0.5); clock?.reset(); pin = null; floorTick(d.qpos[2]); };   // 주소로 고른 시작점으로 다시 세우기 = STOP 잠금 — «시작»으로만 다시
  $('cam').onclick = () => {
    top = !top; camera = top ? topCamera : followCamera;
    $('cam').setAttribute('aria-pressed', String(top));
    $('cam').setAttribute('aria-label', top ? '따라가기' : '위에서 보기');
    $('topCenter').hidden = !top;
    camera.updateProjectionMatrix();
  };
  for (const b of ['reset', 'cam']) $(b).disabled = readonly && b === 'reset';
  sim.hold(0.5);
  ready = true;
  $('busy').hidden = true;
  if (stopped) sim.cmd = neutral();
  ui();
  scenarioUI();

  // ── 층(여러 층 지도만): 로봇 몸 높이로 지금 층 → 찍기·시나리오 지도. 위에서 보기는 볼 층 천장 높이에서 내려다봐 위층을 잘라 낸다.
  // 단추 «전체 · 1층 · 2층»: 전체 = 층 지도 모두 층 색으로(보기만), 다른 층 = 그 층 고정, 로봇이 선 층 = 다시 자동
  const bar = $('floorBar'), fbs = [['all', '전체'], ...floors.map((f, i) => [i, f.name])].map(([k, t]) => {
    const b = document.createElement('button'); b.type = 'button'; b.dataset.floor = k; b.textContent = t;
    if (k !== 'all') b.style.boxShadow = `inset 5px 0 0 rgb(${FLOOR_RGB[k % FLOOR_RGB.length]})`;   // 전체 겹침 범례
    b.onclick = () => { pin = k === 'all' ? 'all' : k === here ? null : k; };
    bar.append(b); return [k, b, t];
  });
  let floorKey = '';
  const floorTick = (z) => {
    const i = floors.findIndex((f) => z >= f.z[0] && z < f.z[1]);
    if (i >= 0 && i !== here) { here = i; map = floors[i].map; gen++; marks = []; plan = []; drawMarks(); inflate(map); }   // 다른 층 점은 받지 않는다
    const v = pin ?? here;
    planes.forEach((p, j) => { p.visible = top && (v === 'all' || v === j); p.material.depthTest = v !== 'all'; });
    const key = `${top}|${here}|${pin}`;
    if (key === floorKey) return;
    floorKey = key; bar.hidden = !top || !floors.length;
    for (const [k, b, t] of fbs) { b.setAttribute('aria-pressed', String(k === v)); b.textContent = k === here ? `${t} · 지금` : t; }
    scenarioUI();
  };

  // Fixed policy dt/decimation; keep debt through inference, bounded catch-up.
  let frames = 0, fps = 0, fpsT = performance.now();
  Object.assign(st, { ready: true, sim, steps: 0, stepsBehind: 0, fps: () => fps, joy: () => joy.slice(), cmd: () => sim.cmd.slice(), stopped: () => stopped,
    timing: () => clock.stats,
    start: () => ({ xy: start.slice(0, 2), yaw: start[2], floor: floors[startFloor]?.id ?? null, floorIndex: startFloor,
      floorZ: layers[startFloor].map.floor_z, spawnFloorZ: sim.spawnFloorZ, custom: params.has('start') && !startReason, reason: startReason, note: startNote }),
    top: () => top, view: () => ({ ...view }), cam: () => camera.position.toArray(), scenario: runner,
    // 시험용: 지도 좌표 → 화면(CSS px) 점(그 점을 찍는 시험), 지금 보이는 찍기 안내
    toScreen: (x, y, z = map.heightAt?.(x, y) ?? map.floor_z) => { const v = new THREE.Vector3(x, y, Number.isFinite(z) ? z : map.floor_z).project(camera); return [vp[0] + (v.x + 1) / 2 * vp[2], vp[1] + (1 - v.y) / 2 * vp[3]]; }, goalNote: () => goalText,
    marks: () => marks.map((p) => ({ ...p })), plan: () => plan.map((p) => ({ ...p })), rings: () => marksG.children.map((c) => c.material.opacity),
    settled: () => adding.then(() => new Promise((r) => { const w = () => (busy ? setTimeout(w, 5) : r()); w(); })),   // 찍은 점·출발용 길 찾기가 끝날 때까지
    floor: () => ({ here, view: pin ?? here, names: floors.map((f) => f.name) }) });
  const camPos = new THREE.Vector3(), look = new THREE.Vector3();
  const timingUI = () => {
    const timing = clock.stats;
    st.stepsBehind = timing.drops;
    $('simSlow').hidden = !timing.slow;
    $('simSlow').textContent = timing.dropped > 0 ? `시뮬 느림 · 처리 한도 초과 ${timing.dropped.toFixed(2)}초` : '시뮬 느림 · 밀린 시간 처리 중';
  };
  clock = createFrameClock({ dt: POLICY_DT,
    yieldOnRejected: !!adapter.depth,
    prepare: () => {
      if (runner.active) {
        runner.tick(front, POLICY_DT); // #253: runner owns velocity/goal policy commands.
        if (adapter.command.kind === 'nearby_goal') { heading = null; joy = sim.cmd.slice(); }
      } else if (adapter.command.kind === 'nearby_goal') {
        const goal = ame2Joystick(heading, adapter.yawOf(d.qpos), stopped ? [0, 0, 0] : goalAxes, POLICY_DT);
        heading = goal.heading; joy = goal.command; sim.cmd = joy.slice();
      } else sim.cmd = stopped ? neutral() : joy.slice();
    },
    step: () => sim.step(),
    onStep: () => { st.steps++; timingUI(); },
    onError: (e) => {
      lock(); st.err = String(e);
      if (adapter.fallback === null) { ready = st.ready = false; ui(); }
      $('policyEngine').textContent = st.policyEngine?.includes('정책 잠금') ? st.policyEngine : `정책 계산 중단 · ${e.message}`;
    },
  });
  clock.reset();
  let lastDrawAt = -Infinity;
  function frame(now) {
    // Account wall time on every RAF, including while inference is pending.
    // For start, finish due decisions before submitting a new GPU redraw:
    // SwiftShader work otherwise competes with the 20 ms Worker delivery.
    // Bound deferral even under continuous inference, so drawing, lidar and
    // scenario/goal/floor UI continue on slow CPUs as well as idle RAFs.
    if (adapter.depth) {
      clock.frame(now, !ready || document.hidden || (adapter.stop.pause && stopped));
      if (clock.stats.pending && performance.now() - lastDrawAt < START_DRAW_MAX_GAP_MS) { timingUI(); requestAnimationFrame(frame); return; }
    }
    if (now - lastScan >= 100) { scan(); lastScan = now; }
    if (!adapter.depth && !readonly) clock.frame(now, !ready || document.hidden || (adapter.stop.pause && stopped));
    if (replay) $('policyEngine').textContent = replay.status();
    timingUI();
    floorTick(d.qpos[2]);
    scenarioUI();
    goalUI(now);
    draw();
    const bx = d.qpos[0], by = d.qpos[1], bz = d.qpos[2];
    if (top) {
      // Keep the first whole-map view clear of the fixed header and camera/scenario buttons.
      const upper = Math.max($('home').getBoundingClientRect().bottom, $('stop').getBoundingClientRect().bottom, bar.hidden ? 0 : bar.getBoundingClientRect().bottom) + 12;   // 층 단추 아래부터
      const lower = $('btns').getBoundingClientRect().top - 12;
      const width = innerWidth - 24, height = Math.max(1, lower - upper);
      renderer.setViewport(12, innerHeight - lower, width, height); vp = [12, upper, width, height];
      const fit = topFit();
      view.topX = fit.cx; view.topY = fit.cy;
      topCamera.left = -fit.width / 2; topCamera.right = fit.width / 2;
      topCamera.top = fit.height / 2; topCamera.bottom = -fit.height / 2;
      // 한 층을 볼 때는 그 위층 바닥 조금 아래(천장)에서 — 카메라 뒤(위층)는 그리지 않는다. 전체·맨 위층은 높이 100 m
      const v = pin ?? here, vz = v === 'all' ? map.floor_z : layers[v].map.floor_z, up = v === 'all' ? null : floors[v + 1];
      camPos.set(fit.cx, fit.cy, up ? up.map.floor_z - 0.2 : vz + 100); look.set(fit.cx, fit.cy, vz - 1);
      camera.up.set(-Math.sin(view.topRot), Math.cos(view.topRot), 0); // 돌리기 0 = 지도처럼 +y 가 화면 위
      camera.near = 0.1; // Roof-free assets; the whole site stays inside the orthographic frustum.
    } else {
      renderer.setViewport(0, 0, innerWidth, innerHeight); vp = [0, 0, innerWidth, innerHeight];
      const a = yawOf() + view.yaw, h = view.dist * Math.cos(view.pitch);
      camPos.set(bx - Math.cos(a) * h, by - Math.sin(a) * h, bz + view.dist * Math.sin(view.pitch)); look.set(bx, by, bz);
      camera.near = 0.05;
    }
    camera.updateProjectionMatrix();
    camera.position.lerp(camPos, top || !camera.position.lengthSq() ? 1 : 0.25);   // 첫 프레임(원점)은 바로 제자리
    camera.lookAt(look);
    renderer.render(scene, camera);
    lastDrawAt = performance.now();
    frames++;
    if (now - fpsT > 1000) { fps = Math.round(frames * 1000 / (now - fpsT)); frames = 0; fpsT = now; }
    $('stickL').classList.toggle('out', !inRange(sim.cmd)); $('keys').classList.toggle('out', !inRange(sim.cmd));
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
