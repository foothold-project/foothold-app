// 시작 화면: 서버 주소(https origin)를 받아 같은 WebView 로 그 서버의 웹 화면(#/drive)을 연다. 플러그인·브리지를 쓰지 않는다.
// 주소는 매번 넣는다(터널 quick 주소가 바뀜) — 자동으로 마지막 주소를 열지 않고, 최근 주소만 고를 수 있게 남긴다(이 기기 localStorage, 최대 5개)
import { gateOrigin } from './origin.js';

const KEY = 'fh.recent', MAX = 5;
const $ = (id) => document.getElementById(id);
const NOTE = {
  tls: '서버 인증서를 확인할 수 없어 열지 않았습니다. 주소가 맞는지 확인하세요. 인증서 오류는 무시하고 열 수 없습니다.',
  out: '입력한 서버 밖 주소로 가려 해서 막았습니다. 이 앱은 넣은 서버 주소만 엽니다.',
  net: '서버에 연결하지 못했습니다. 주소가 바뀌었거나(터널 다시 켬) 서버가 꺼졌을 수 있습니다. 새 주소를 받아 넣으세요.',
};
const recent = () => { try { const a = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(a) ? a.filter((o) => { try { return gateOrigin(o) === o; } catch { return false; } }) : []; } catch { return []; } };
const save = (o) => { try { localStorage.setItem(KEY, JSON.stringify([o, ...recent().filter((x) => x !== o)].slice(0, MAX))); } catch { /* 저장 못 해도 연다 */ } };

function open(raw) {
  let o;
  try { o = gateOrigin(raw.trim()); } catch (e) { $('err').textContent = e.message; $('addr').focus(); return; }
  $('err').textContent = '';
  save(o);
  location.href = `${o}/#/drive`;
}

function draw() {
  const r = recent(), ul = $('list');
  ul.replaceChildren(...r.map((o) => {
    const li = document.createElement('li'), b = document.createElement('button');
    b.type = 'button'; b.className = 'btn'; b.textContent = o; b.onclick = () => open(o);
    li.append(b); return li;
  }));
  $('recent').hidden = !r.length;
}

$('note').textContent = NOTE[new URLSearchParams(location.search).get('e')] || '';
const ver = navigator.userAgent.match(/FootholdApp\/(\S+)/)?.[1];
$('ver').textContent = ver ? `FOOTHOLD 앱 ${ver}` : '';
$('f').onsubmit = (e) => { e.preventDefault(); open($('addr').value); };
$('paste').onclick = async () => {
  try { $('addr').value = (await navigator.clipboard.readText()).trim(); $('err').textContent = ''; }
  catch { $('err').textContent = '붙여넣기를 쓸 수 없습니다. 입력칸을 길게 눌러 붙여넣으세요.'; }
  $('addr').focus();
};
$('clear').onclick = () => { try { localStorage.removeItem(KEY); } catch { /* 없음 */ } draw(); };
draw();
