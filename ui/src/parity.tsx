// 시험 전용: 변환 틀(*.view.tsx)이 원본 dc.js 와 같은 화면을 그리는지 대조한다.
// 시안 Component(예시값)를 dc.js 와 같은 방식으로 실행해 값을 만든다 — 이 쪽에서만. 운영 화면은 예시값을 쓰지 않는다.
import { createRoot } from 'react-dom/client';

const views = import.meta.glob('./screens/*.view.tsx');
const raws = import.meta.glob('../../web/*.dc.html', { query: '?raw', import: 'default' });

class DCLogic { props: any; state: any = {}; constructor(p: any) { this.props = p; } setState(u: any) { this.state = { ...this.state, ...(typeof u === 'function' ? u(this.state, this.props) : u) }; } renderVals() { return {}; } }

async function main() {
  const q = new URLSearchParams(location.search), name = q.get('screen') || 'Report';
  const raw = (await raws[`../../web/${name}.dc.html`]()) as string;
  const doc = new DOMParser().parseFromString(raw, 'text/html');
  const sc = doc.querySelector('script[type="text/x-dc"]') as HTMLScriptElement;
  const spec = JSON.parse(sc.dataset.props || '{}'), props: any = {};
  for (const [k, v] of Object.entries<any>(spec)) if (!k.startsWith('$')) props[k] = q.has(k) ? q.get(k) : v.default;
  const Comp = new Function('DCLogic', `${sc.textContent}\nreturn Component;`)(DCLogic);
  const comp = new Comp(props); comp.props = props; comp.state = comp.state || {};
  const m: any = await views[`./screens/${name}.view.tsx`]();
  const st = document.createElement('style'); st.textContent = m.CSS; document.head.append(st);
  const el = document.createElement('div'); el.id = 'dc-root'; document.body.append(el);
  createRoot(el).render(<m.View v={comp.renderVals() || {}} />);
}
main();
