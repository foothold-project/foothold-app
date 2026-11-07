// Mission JSON and deterministic tick executor. No DOM, robot, clock or simulator imports.
export const TREE_FORMAT = 'fh_mission_tree/1';
export const RESULTS = Object.freeze(['running', 'success', 'failure', 'abort']);
export const ACTION_SECONDS = Object.freeze({ goto: 180, photo: 5, wait: 120, operator_review: 120,
  sensor_log: 5, map_mark: 5, alert: 5, skip_log: 5, return_home: 180, hold: 5, report: 5 });
const CONDITIONS = ['fallen', 'battery_low', 'review_is'];
const GROUPS = ['sequence', 'fallback', 'reactive_fallback'];
const pointOK = (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y);
const positive = (v, max) => Number.isFinite(v) && v > 0 && v <= max;
export function validateTree(tree) {
  if (tree?.format !== TREE_FORMAT || !positive(tree.max_seconds, 3600)) throw new Error('나무 형식·전체 max_seconds (1~3600)');
  let count = 0;
  const visit = (n, depth, inPoints = false) => {
    if (++count > 200 || depth > 16) throw new Error('나무 노드 200개·깊이 16 초과');
    if (!n || typeof n !== 'object' || Array.isArray(n)) throw new Error('나무 노드 형식');
    if (GROUPS.includes(n.type)) {
      if (!Array.isArray(n.children) || !n.children.length) throw new Error('children 필요');
      n.children.forEach((c) => visit(c, depth + 1, inPoints));
    } else if (n.type === 'retry' || n.type === 'for_each_point') {
      if (n.type === 'retry' && (!Number.isInteger(n.times) || n.times < 1 || n.times > 3)) throw new Error('retry.times 1~3');
      if (n.type === 'for_each_point' && (!Array.isArray(n.points) || !n.points.length || n.points.length > 200 || !n.points.every(pointOK))) throw new Error('순찰 points 필요');
      visit(n.child, depth + 1, inPoints || n.type === 'for_each_point');
    } else if (CONDITIONS.includes(n.type)) {
      if (n.type === 'review_is' && !['clear', 'minor', 'danger'].includes(n.level)) throw new Error('판단 level 필요');
    } else if (Object.hasOwn(ACTION_SECONDS, n.type)) {
      if (n.max_seconds !== undefined && !positive(n.max_seconds, ACTION_SECONDS[n.type])) throw new Error('행동 시간 상한');
      if (n.type === 'goto' && !(pointOK(n.point) || (n.point === 'current' && inPoints))) throw new Error('goto.point 필요');
      if (n.type === 'wait' && !positive(n.seconds, n.max_seconds ?? ACTION_SECONDS.wait)) throw new Error('wait.seconds 필요');
      if (['alert', 'sensor_log', 'skip_log', 'report', 'hold'].includes(n.type) && (typeof n.message !== 'string' || !n.message.trim())) throw new Error('message 필요');
      if (n.type === 'map_mark' && !['minor', 'danger'].includes(n.level)) throw new Error('표시 level 필요');
      if (n.finish !== undefined && (n.type !== 'report' || typeof n.finish !== 'boolean')) throw new Error('finish는 report만');
    } else throw new Error(`모르는 나무 종류: ${n.type}`);
  };
  visit(tree.root, 1);
  return tree;
}
export function treeFromScenario(s) {
  return validateTree({ format: TREE_FORMAT, max_seconds: 3600, root: { type: 'sequence', children: s.points.map((p) => ({ type: 'goto', point: { ...p } })) } });
}
export function treeRows(tree) {
  const rows = [];
  const walk = (node, path, depth) => {
    rows.push({ node, path, depth });
    (node.children ?? (node.child ? [node.child] : [])).forEach((n, i) => walk(n, `${path}.${i}`, depth + 1));
  };
  walk(tree.root, '0', 0); return rows;
}
// Injected action: start(node, context) -> { tick(dt): result, halt(reason) }.
// times counts total attempts (2 = the first attempt plus one retry).
export function createTreeRunner(tree, { actions = {}, conditions = {}, isStopped = () => false, onFinish = () => {}, onEvent = () => {} } = {}) {
  validateTree(tree);
  const states = new Map();
  const ctx = { point: null, index: 0, review: null, skipPoint: false, finish: false, reason: '' };
  const runner = { active: false, status: '대기', elapsed: 0, states, context: ctx, tree };
  const state = (path) => { if (!states.has(path)) states.set(path, { result: null, index: 0, elapsed: 0, attempts: 0 }); return states.get(path); };
  const halt = (prefix, reason) => {
    for (const [p, s] of states) if ((p === prefix || p.startsWith(prefix + '.')) && s.result === 'running') {
      s.handle?.halt(reason); s.handle = null; s.result = null; s.index = 0; s.elapsed = 0;
      onEvent({ path: p, result: 'halt', reason });
    }
  };
  const reset = (prefix, reason = 'reset') => { halt(prefix, reason); for (const p of states.keys()) if (p === prefix || p.startsWith(prefix + '.')) states.delete(p); };
  const end = (result, reason = ctx.reason || result) => {
    if (!runner.active) return runner.status;
    runner.active = false; runner.status = result; ctx.reason = reason;
    halt('0', reason); onFinish({ result, reason, elapsed: runner.elapsed, context: ctx }); return result;
  };
  runner.cancel = (reason = '중단') => end('abort', reason);
  runner.start = () => {
    if (runner.active || isStopped()) return false;
    states.clear(); Object.assign(ctx, { point: null, index: 0, review: null, skipPoint: false, finish: false, reason: '' });
    runner.elapsed = 0; runner.active = true; runner.status = 'running'; return true;
  };
  const tick = (n, path, dt) => {
    if (!runner.active || isStopped()) return 'abort';
    const s = state(path);
    const done = (r) => { if (s.result !== r) onEvent({ path, result: r, type: n.type, point: ctx.index }); s.result = r; return r; };
    if (CONDITIONS.includes(n.type)) return done((conditions[n.type]?.(n, ctx) ?? false) ? 'success' : 'failure');
    if (s.result === 'success' || s.result === 'failure' || s.result === 'abort') return s.result;
    if (GROUPS.includes(n.type)) {
      s.composite = true;
      const sequence = n.type === 'sequence', reactive = n.type === 'reactive_fallback';
      for (let i = reactive ? 0 : s.index; i < n.children.length; i++) {
        if (reactive && state(`${path}.${i}`).result === 'failure') {
          // Recheck guard sequences without restarting failed asynchronous actions
          // in front of an already running lower branch on every tick.
          const prefix = `${path}.${i}`;
          for (const [p, previous] of states) if ((p === prefix || p.startsWith(prefix + '.')) && !previous.handle && previous.composite) { previous.result = null; previous.index = 0; }
        }
        const r = tick(n.children[i], `${path}.${i}`, dt);
        if ((ctx.finish || ctx.skipPoint) && r !== 'abort') return done('success');
        if (r === 'abort') return done(r);
        if (reactive && r !== 'failure') for (let j = i + 1; j < n.children.length; j++) if (states.get(`${path}.${j}`)?.result === 'running') reset(`${path}.${j}`, '우선 갈래');
        if (r === 'running') { s.index = i; return done(r); }
        if (r === (sequence ? 'failure' : 'success')) return done(r);
        s.index = i + 1;
      }
      return done(sequence ? 'success' : 'failure');
    }
    if (n.type === 'retry') {
      const r = tick(n.child, `${path}.0`, dt);
      if (r !== 'failure') return done(r);
      if (++s.attempts >= n.times) return done('failure');
      reset(`${path}.0`); return done('running');
    }
    if (n.type === 'for_each_point') {
      ctx.point = n.points[s.index]; ctx.index = s.index;
      const r = tick(n.child, `${path}.0`, dt);
      if (r === 'abort' || r === 'failure') return done(r);
      if (ctx.finish) return done('success');
      if (r === 'success' || ctx.skipPoint) {
        ctx.skipPoint = false; reset(`${path}.0`);
        if (++s.index >= n.points.length) return done('success');
        ctx.review = null;
      }
      return done('running');
    }
    if (!s.handle) {
      s.elapsed = 0;
      s.handle = actions[n.type]?.(n, ctx);
      if (!s.handle || typeof s.handle.tick !== 'function' || typeof s.handle.halt !== 'function') throw new Error(`행동 주입 필요: ${n.type}`);
      return done('running');
    }
    s.elapsed += dt;
    let r;
    const limit = n.max_seconds ?? ACTION_SECONDS[n.type];
    if (s.elapsed > limit) { s.handle.halt('행동 시간 초과'); r = 'failure'; }
    else {
      r = s.handle.tick(dt);
      if (r === 'running' && s.elapsed >= limit) { s.handle.halt('행동 시간 초과'); r = 'failure'; }
    }
    if (!RESULTS.includes(r)) throw new Error(`행동 결과 형식: ${r}`);
    if (r === 'abort') s.handle?.halt('중단');
    if (r !== 'running') s.handle = null;
    return done(r);
  };
  runner.tick = (dt = 0) => {
    if (!runner.active) return runner.status;
    // STOP is checked before any condition/action, including stationary actions.
    if (isStopped()) return end('abort', '중단');
    if (!Number.isFinite(dt) || dt < 0) throw new Error('틱 시간 형식');
    runner.elapsed += dt;
    if (runner.elapsed >= tree.max_seconds) return end('abort', '전체 시간 초과');
    try {
      const r = tick(tree.root, '0', dt);
      if (!runner.active) return runner.status;
      if (isStopped() || r === 'abort') return end('abort', ctx.reason || '중단');
      if (ctx.finish) return end('success');
      if (r !== 'running') return end(r);
      return 'running';
    } catch (e) { end('abort', `실행 오류: ${e.message}`); throw e; }
  };
  return runner;
}
