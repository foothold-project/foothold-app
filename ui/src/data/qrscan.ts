// QR 스캔 한 번의 수명(①) — React·DOM 없이 시험할 수 있게 의존을 받는다.
// 규칙: stop() 뒤(닫기·hidden·pagehide·unmount)에는 늦은 detect/getUserMedia/play 결과가 onOrigin·onClose·setMsg 를 부르지 않는다.
// detect 는 동시에 1개, 주소 수락은 한 번뿐. 수락 = 입력칸에 넣기까지 — 저장·주소 변경은 기존 «주소 저장» 확인 뒤에만(여기서 0).
export type Code = { rawValue?: unknown };
export type ScanDeps = {
  getMedia: () => Promise<MediaStream>;
  video: { srcObject: unknown; readyState: number; play: () => Promise<void> };
  makeDet: () => { detect: (v: any) => Promise<Code[]> };
  parse: (t: string) => { origin: string } | { why: string };
  onOrigin: (o: string) => void;
  onClose: (why?: string) => void;
  setMsg: (m: string) => void;
  every?: number;
};

/** 시작하고 stop 을 돌려준다. stop() 은 여러 번 불러도 됨, 처음 부른 경우만 true(그때 호출자가 닫기 안내를 낼 수 있음) */
export function startScan(d: ScanDeps): () => boolean {
  let gone = false, busy = false, timer: ReturnType<typeof setInterval> | undefined, stream: MediaStream | null = null;
  const stop = () => {
    if (gone) return false;
    gone = true; if (timer !== undefined) clearInterval(timer);
    stream?.getTracks().forEach((t) => t.stop()); stream = null; d.video.srcObject = null;
    return true;
  };
  const fail = (e: unknown) => {   // 살아 있을 때만 안내(끝난 옛 화면에 0)
    if (!stop()) return;
    const n = (e as Error)?.name;
    d.onClose(n === 'NotAllowedError' ? '카메라 권한 거절 — 설정에서 카메라를 허용하거나 주소를 붙여넣으세요' : `카메라를 못 엶(${n || e}) — 주소를 붙여넣으세요`);
  };
  (async () => {
    try {
      const s = await d.getMedia();
      if (gone) { s.getTracks().forEach((t) => t.stop()); return; }
      stream = s; d.video.srcObject = s; await d.video.play();
      if (gone) return;
      const det = d.makeDet();
      d.setMsg('관문 주소 QR 을 비추세요');
      timer = setInterval(async () => {
        if (gone || busy || d.video.readyState < 2) return;
        busy = true;
        const r = await det.detect(d.video).catch(() => [] as Code[]);
        busy = false;
        if (gone) return;   // 기다리는 동안 닫힘·숨김·떠남 → 결과 버림
        for (const c of r) {
          const g = d.parse(String(c.rawValue ?? ''));
          if ('origin' in g) { stop(); d.onOrigin(g.origin); return; }   // 한 번만: stop 뒤 다른 detect 결과는 위 gone 에서 버려짐
          d.setMsg(`관문 주소가 아닌 QR — ${g.why}`);
        }
      }, d.every ?? 300);
    } catch (e) { fail(e); }
  })();
  return stop;
}
