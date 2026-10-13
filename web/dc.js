// 시안(.dc.html) 실행기 — 시안 원본 마크업·스타일을 그대로 두고 화면만 그린다 (React·외부 런타임 없음).
// 시안 파일 구조: <x-dc>(템플릿: <helmet>·{{값}}·<sc-if>·<sc-for>·onClick/onChange) + <script type="text/x-dc">(class Component extends DCLogic).
// 지원 범위는 시안 10개에 쓰인 것만: {{경로}}·{{ true|false|숫자 }}, sc-if value, sc-for list/as, on* 이벤트, setState(객체|함수).
// 화면 상태 바꾸기(미리보기 전용): 주소 뒤 ?scenario=통신 끊김&theme=밝은 처럼 data-props 이름으로 넘긴다.
// ponytail: 매 setState 마다 전체를 다시 그린다 — 시안 크기에선 충분. 느려지면 바뀐 칸만 고친다.
(() => {
  const hide = document.createElement('style');
  hide.textContent = 'x-dc,script[type="text/x-dc"]{display:none!important}';
  document.head.append(hide);

  class DCLogic {
    constructor(props) { this.props = props; this.state = {}; }
    setState(u) {
      this.state = { ...this.state, ...(typeof u === 'function' ? u(this.state, this.props) : u) };
      render();
    }
    renderVals() { return {}; }
  }
  window.DCLogic = DCLogic;

  let comp, tpl, root;
  const BOOL = new Set(['disabled', 'checked', 'readonly', 'selected', 'hidden']);   // 거짓이면 속성을 뺀다

  function look(expr, scope) {
    const e = expr.trim();
    if (e === 'true') return true;
    if (e === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(e)) return Number(e);
    if (!/^[A-Za-z_$][\w$]*(\.[\w$]+)*$/.test(e)) { console.warn('dc: 모르는 식', e); return undefined; }
    return e.split('.').reduce((o, k) => (o == null ? undefined : o[k]), scope);
  }
  const ONLY = /^\s*\{\{([^}]*)\}\}\s*$/;
  const fill = (s, scope) => s.replace(/\{\{([^}]*)\}\}/g, (_, x) => { const v = look(x, scope); return v == null ? '' : String(v); });

  // 시안 런타임과 같게: 글 속 {{값}} 은 <span class="sc-interp"> 로 감싼다(flex 간격이 여기서 갈린다). null·true/false 는 안 그림.
  // 승인 수정(10-12, Q3): 원본 런타임은 SVG <text> 안에도 span 을 넣어 글자가 안 그려졌다(지도 위 지점명·θ 빈칸).
  // SVG 안에서는 SVG 글자 요소 <tspan> 으로 감싸 그린다 — 위치·색·글꼴은 부모 <text> 그대로.
  const SVG = 'http://www.w3.org/2000/svg';
  function interp(s, scope, ns) {
    return s.split(/\{\{([^}]*)\}\}/).flatMap((part, i) => {
      if (!(i & 1)) return part ? [document.createTextNode(part)] : [];
      const v = look(part, scope);
      if (v == null || typeof v === 'boolean') return [];
      const sp = ns === SVG ? document.createElementNS(SVG, 'tspan') : document.createElement('span');
      sp.setAttribute('class', 'sc-interp'); sp.textContent = String(v); return [sp];
    });
  }

  function walk(node, scope) {
    for (const ch of [...node.childNodes]) {
      if (ch.nodeType === 3) { if (ch.data.includes('{{')) ch.replaceWith(...interp(ch.data, scope, node.namespaceURI)); continue; }
      if (ch.nodeType !== 1) continue;
      const tag = ch.localName;
      if (tag === 'sc-if' || tag === 'sc-for') {
        const out = document.createDocumentFragment();
        if (tag === 'sc-if') {
          if (look(ONLY.exec(ch.getAttribute('value') || '')?.[1] ?? 'false', scope)) {
            const f = document.createDocumentFragment(); f.append(...ch.childNodes); walk(f, scope); out.append(f);
          }
        } else {
          const list = look(ONLY.exec(ch.getAttribute('list') || '')?.[1] ?? '', scope) || [];
          const as = ch.getAttribute('as');
          for (const item of list) {
            const f = document.createDocumentFragment();
            for (const c of ch.childNodes) f.append(c.cloneNode(true));
            walk(f, { ...scope, [as]: item }); out.append(f);
          }
        }
        ch.replaceWith(out);
        continue;
      }
      for (const a of [...ch.attributes]) {
        if (!a.value.includes('{{')) continue;
        const name = a.name, only = ONLY.exec(a.value);
        if (/^on[a-z]+$/.test(name)) {                       // onClick/onChange → 이벤트
          ch.removeAttribute(name);
          const fn = only && look(only[1], scope);
          if (typeof fn === 'function') ch.addEventListener(name === 'onchange' && ch.localName === 'input' ? 'input' : name.slice(2), (ev) => fn(ev));
        } else if (only && BOOL.has(name)) {
          const v = look(only[1], scope);
          if (v) ch.setAttribute(name, ''); else ch.removeAttribute(name);
          if (name === 'checked') ch.checked = !!v;
        } else if (name === 'value' && only) {
          const v = look(only[1], scope); ch.setAttribute('value', v ?? ''); ch.value = v ?? '';
        } else ch.setAttribute(name, fill(a.value, scope));
      }
      walk(ch, scope);
    }
  }

  function render() {
    if (root && root.dataset.liveOwned && !comp.live) return;   // ?live=v2: 시안 Component 의 다시 그리기는 막고, live.js 가 넘긴 실데이터 Component(comp.live)만 같은 원본 틀로 다시 그린다
    const act = document.activeElement, id = act?.id, sel = id && act.selectionStart != null ? [act.selectionStart, act.selectionEnd, act.value] : null;
    const f = tpl.content.cloneNode(true);
    walk(f, comp.renderVals() || {});
    root.replaceChildren(f);
    for (const s of root.querySelectorAll('select[value]')) s.value = s.getAttribute('value');   // 시안의 <select value="…"> (React 의미) — 고른 항목
    if (comp.afterRender) comp.afterRender(root);   // 실연결: 새로 그린 원본 DOM 에 STOP·상태 줄 다시 붙이기
    if (id) { const el = document.getElementById(id); if (el) { el.focus(); if (sel && el.setSelectionRange) { if (el.value === sel[2]) el.setSelectionRange(sel[0], sel[1]); else el.setSelectionRange(el.value.length, el.value.length); } } }  // 입력 중 다시 그려도 커서 유지, 값이 바뀌면 끝으로(React 와 같게)
  }

  function boot() {
    const xdc = document.querySelector('x-dc'), sc = document.querySelector('script[type="text/x-dc"]');
    const helmet = xdc.querySelector('helmet');
    if (helmet) { document.head.append(...helmet.childNodes); helmet.remove(); }
    tpl = document.createElement('template'); tpl.innerHTML = xdc.innerHTML;
    root = document.createElement('div'); root.id = 'dc-root'; xdc.replaceWith(root);
    const spec = JSON.parse(sc.dataset.props || '{}'), props = {}, q = new URLSearchParams(location.search);
    for (const [k, v] of Object.entries(spec)) if (!k.startsWith('$')) props[k] = q.has(k) ? q.get(k) : v.default;
    const Comp = new Function('DCLogic', `${sc.textContent}\nreturn Component;`)(DCLogic);
    comp = new Comp(props); comp.props = props; comp.state = comp.state || {};
    render();
    window.dcUse = (make) => { comp = make(Comp, props); comp.props = props; render(); };   // live.js: 같은 원본 틀에 실데이터 Component 를 끼운다
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
