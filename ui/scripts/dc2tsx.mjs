// 시안(web/*.dc.html) → React 화면 틀(TSX) 1회 변환기.
// 원본 마크업·인라인 스타일·CSS 를 그대로 옮긴다(시각 원본 보존). 시안 Component(예시값 renderVals)는 옮기지 않는다 — 예시 가짜값 금지.
// 변환 규칙은 web/dc.js 실행기와 같다: {{경로}} → <span class="sc-interp">(SVG 안은 <tspan>), null·true/false 는 안 그림,
// sc-if value → 조건부, sc-for list/as → map, on* → 이벤트, disabled 등 불리언 속성, value.
// 쓰임: node scripts/dc2tsx.mjs Report MHistory …  → src/screens/<이름>.view.tsx (있으면 덮지 않음, --force 로만)
// 생성 뒤에는 손으로 고친다(예시 글자를 실데이터 식으로). 다시 돌려 덮지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import { parseDocument } from 'htmlparser2';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));

const WEB = path.resolve(HERE, '../../web');
const OUT = path.resolve(HERE, '../src/screens');
const force = process.argv.includes('--force');
const names = process.argv.slice(2).filter((a) => !a.startsWith('--'));

const BOOL = new Set(['disabled', 'checked', 'readonly', 'readOnly', 'selected', 'hidden']);
const RENAME = { class: 'className', for: 'htmlFor', autocomplete: 'autoComplete', tabindex: 'tabIndex', readonly: 'readOnly', colspan: 'colSpan', rowspan: 'rowSpan', maxlength: 'maxLength' };
const SVG_TAGS = new Set(['svg', 'line', 'polyline', 'circle', 'text', 'path', 'rect', 'defs', 'radialGradient', 'stop', 'polygon', 'ellipse', 'g', 'pattern', 'tspan']);
const NUM = new Set(['rows', 'cols', 'colSpan', 'rowSpan', 'tabIndex', 'maxLength', 'size']);
const ONLY = /^\s*\{\{([^}]*)\}\}\s*$/;
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

function cssObj(s) {   // 정적 style 문자열 → JSX 객체 글자
  const o = {};
  for (const decl of s.split(';')) {
    const i = decl.indexOf(':'); if (i < 0) continue;
    const k = decl.slice(0, i).trim(), v = decl.slice(i + 1).trim(); if (!k) continue;
    o[k.startsWith('--') ? k : camel(k)] = v;
  }
  return JSON.stringify(o);
}

function convert(name) {
  const src = fs.readFileSync(path.join(WEB, `${name}.dc.html`), 'utf8');
  const doc = parseDocument(src, { lowerCaseAttributeNames: false, lowerCaseTags: false, recognizeSelfClosing: true });
  const find = (n, pred) => { for (const c of n.children || []) { if (pred(c)) return c; const r = find(c, pred); if (r) return r; } return null; };
  const xdc = find(doc, (n) => n.name === 'x-dc');
  const helmet = find(xdc, (n) => n.name === 'helmet');
  const css = helmet ? (helmet.children.filter((c) => c.name === 'style').map((s) => s.children.map((t) => t.data).join('')).join('\n')) : '';
  const fonts = helmet ? helmet.children.filter((c) => c.name === 'link').map((l) => l.attribs.href) : [];
  const script = find(doc, (n) => n.name === 'script' && n.attribs.type === 'text/x-dc');
  const preview = script ? (JSON.parse(script.attribs['data-props'] || '{}').$preview || null) : null;

  const keys = new Set();
  const expr = (e, locals) => {   // dc.js look(): true/false/숫자/점 경로만
    e = e.trim();
    if (e === 'true' || e === 'false' || /^-?\d+(\.\d+)?$/.test(e)) return e;
    if (!/^[A-Za-z_$][\w$]*(\.[\w$]+)*$/.test(e)) throw new Error(`${name}: 모르는 식 ${e}`);
    const [h, ...rest] = e.split('.');
    if (!locals.has(h)) keys.add(h);
    return [locals.has(h) ? h : `v.${h}`, ...rest].join('?.');
  };
  const fillStr = (s, locals) => '`' + s.split(/\{\{([^}]*)\}\}/).map((p, i) => (i & 1 ? '${str(' + expr(p, locals) + ')}' : p.replace(/[`\\$]/g, '\\$&'))).join('') + '`';

  const kids = (n, locals, svg, ind) => (n.children || []).map((c) => node(c, locals, svg, ind)).filter(Boolean).join('\n');
  function node(n, locals, svg, ind) {
    const pad = '  '.repeat(ind);
    if (n.type === 'text') {
      if (!n.data.includes('{{')) return /^\s*$/.test(n.data) ? (svg ? '' : `${pad}{" "}`) : `${pad}{${JSON.stringify(n.data.replace(/\s+/g, ' '))}}`;
      return n.data.split(/\{\{([^}]*)\}\}/).map((p, i) => (i & 1 ? `${pad}{${svg ? 'ivs' : 'iv'}(${expr(p, locals)})}` : p ? `${pad}{${JSON.stringify(p.replace(/\s+/g, ' '))}}` : '')).filter(Boolean).join('\n');
    }
    if (n.type === 'comment') return '';
    if (n.type !== 'tag') return '';
    if (n.name === 'helmet') return '';
    if (n.name === 'sc-if') {
      const e = expr(ONLY.exec(n.attribs.value || '')?.[1] ?? 'false', locals);
      return `${pad}{${e} ? (<>\n${kids(n, locals, svg, ind + 1)}\n${pad}</>) : null}`;
    }
    if (n.name === 'sc-for') {
      const e = expr(ONLY.exec(n.attribs.list || '')?.[1] ?? '', locals), as = n.attribs.as;
      const l2 = new Set(locals); l2.add(as);
      return `${pad}{arr(${e}).map((${as}: any, i${ind}: number) => (<Fragment key={i${ind}}>\n${kids(n, l2, svg, ind + 1)}\n${pad}</Fragment>))}`;
    }
    const isSvg = svg || n.name === 'svg';
    const hasChange = Object.keys(n.attribs).some((a) => /^on(Change|change|Input|input)$/.test(a));
    const props = [];
    for (const [a0, val] of Object.entries(n.attribs)) {
      if (a0.startsWith('hint-placeholder')) continue;
      const only = ONLY.exec(val);
      if (/^on[A-Za-z]+$/.test(a0)) {
        if (!only) continue;
        const ev = 'on' + a0[2].toUpperCase() + a0.slice(3);
        props.push(`${ev}={fn(${expr(only[1], locals)})}`); continue;
      }
      let a = RENAME[a0] || a0;
      if (isSvg && a.includes('-') && !a.startsWith('aria-') && !a.startsWith('data-')) a = camel(a);
      if (a === 'style') { props.push(val.includes('{{') ? `style={css(${fillStr(val, locals)})}` : `style={${cssObj(val)}}`); continue; }
      if (BOOL.has(a0)) {
        const r = RENAME[a0] || a0;
        if (only) props.push(`${r === 'checked' && !hasChange ? 'defaultChecked' : r}={!!(${expr(only[1], locals)})}`);
        else props.push(r === 'checked' ? 'defaultChecked' : r);
        continue;
      }
      if (a === 'value') {
        const v2 = only ? `{str(${expr(only[1], locals)})}` : JSON.stringify(val);
        props.push(`${hasChange ? 'value' : 'defaultValue'}=${v2}`); continue;
      }
      if (!val.includes('{{') && NUM.has(a) && /^\d+$/.test(val)) { props.push(`${a}={${val}}`); continue; }
      props.push(val.includes('{{') ? `${a}={${fillStr(val, locals)} as any}` : `${a}=${JSON.stringify(val)}`);
    }
    const open = `${pad}<${n.name}${props.length ? ' ' + props.join(' ') : ''}`;
    if (n.name === 'textarea') {   // 글 상자 안 글 = 처음 값
      const t = (n.children || []).map((c) => c.data || '').join('');
      if (t.includes('{{')) throw new Error(`${name}: textarea 안 {{}} 미지원`);
      return t ? `${open.replace(`<textarea`, `<textarea defaultValue={${JSON.stringify(t)}}`)} />` : `${open} />`;
    }
    if (!(n.children || []).length) return `${open} />`;
    const body = kids(n, locals, isSvg && n.name !== 'foreignObject', ind + 1);
    return body ? `${open}>\n${body}\n${pad}</${n.name}>` : `${open} />`;
  }

  const body = kids(xdc, new Set(), false, 3).trim();
  const out = `// 생성: scripts/dc2tsx.mjs ← web/${name}.dc.html (시각 원본). 생성 뒤 손으로 실데이터 연결 — 다시 생성해 덮지 않는다.
/* eslint-disable */
import { Fragment } from 'react';
import { arr, css, fn, iv, ivs, str } from '../dc/jsx';

export const PREVIEW = ${JSON.stringify(preview)};
export const FONTS = ${JSON.stringify(fonts)};
export const CSS = ${JSON.stringify(css)};
/** 원본 틀이 읽는 값 이름 */
export type Vals = { ${[...keys].map((k) => `${k}?: any`).join('; ')} };

export function View({ v }: { v: Vals }) {
  return (
    <>
      ${body}
    </>
  );
}
`;
  const p = path.join(OUT, `${name}.view.tsx`);
  if (fs.existsSync(p) && !force) { console.log('있음(건너뜀)', p); return; }
  fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(p, out);
  console.log('생성', p, '값', [...keys].join(','));
}
for (const n of names) convert(n);
