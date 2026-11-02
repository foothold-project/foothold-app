// One in-flight request; a timeout/cancel settles the caller but keeps the slot
// occupied until the Worker replies. Never build an inference queue.
export async function loadWorkerPolicy(model, contract, backend, {
  deadlineMs, createWorker = (url) => new Worker(url, { type: 'module' }), initTimeoutMs = 15000, onFailure = () => {},
} = {}) {
  const worker = createWorker(new URL('./policy-worker.js', import.meta.url));
  let seq = 0, active = null, failure = null, disposed = false;
  const settle = (request, value, error) => {
    clearTimeout(request.timer);
    if (error) request.reject(error); else request.resolve(value);
  };
  const fail = (error) => {
    failure = error;
    if (active) settle(active, null, error);
    active = null;
    worker.terminate();
    onFailure(error);
  };
  worker.onerror = (event) => { event.preventDefault?.(); fail(new Error(event.message || 'Worker 실행 실패')); };
  worker.onmessageerror = () => fail(new Error('Worker 메시지 읽기 실패'));
  worker.onmessage = ({ data }) => {
    if (!active || data.seq !== active.seq) return;
    const request = active;
    active = null;
    if (data.type === 'error') { fail(new Error(data.error)); settle(request, null, failure); return; }
    if (data.type !== request.reply) { fail(new Error('Worker 응답 형식 오류')); settle(request, null, failure); return; }
    // Check elapsed wall time as well as the timer: a busy main thread can
    // deliver a result before its overdue timeout callback gets a turn.
    const late = performance.now() - request.started >= request.budget;
    if (late && request.reply === 'ready') { fail(new Error('Worker 초기화 시간 초과')); settle(request, null, failure); return; }
    settle(request, late ? null : data.action);
  };
  const request = (message, reply, budget, transfer = []) => new Promise((resolve, reject) => {
    const current = active = { seq: ++seq, resolve, reject, reply, budget, started: performance.now() };
    current.timer = setTimeout(() => {
      if (reply === 'ready') fail(new Error('Worker 초기화 시간 초과'));
      else settle(current, null); // retain active until the late reply is drained
    }, budget);
    try { worker.postMessage({ ...message, seq: current.seq }, transfer); }
    catch (error) { fail(error); }
  });
  try {
    // Keep the already SHA-verified main-thread buffer for fallback.
    const copy = model.slice(0);
    await request({ type: 'init', model: copy, contract, backend }, 'ready', initTimeoutMs, [copy]);
  } catch (error) { worker.terminate(); throw error; }
  const policy = (...args) => {
    if (failure) return Promise.reject(failure);
    if (disposed || active) return Promise.resolve(null);
    const inputs = contract.inputs.map((_, i) => Float32Array.from(args[i]));
    return request({ type: 'infer', inputs }, 'result', deadlineMs, inputs.map((v) => v.buffer));
  };
  policy.async = true;
  policy.cancel = () => { if (active) settle(active, null); };
  policy.dispose = async () => { disposed = true; policy.cancel(); worker.terminate(); active = null; };
  return policy;
}
