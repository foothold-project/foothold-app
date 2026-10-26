// 서버 주소 검사 — 옛 scripts/gate-profile.mjs 의 gateOrigin 규칙 그대로(https origin 만). 시작 화면·scripts/start-selftest.mjs 가 함께 쓴다
export function gateOrigin(raw) {
  if (typeof raw !== 'string' || !raw || /[\s#@*\\]/.test(raw)) throw new Error('공백·#·@·*·\\ 가 든 주소는 받지 않습니다');
  let u;
  try { u = new URL(raw); } catch { throw new Error('주소 형식이 아닙니다'); }
  if (u.protocol !== 'https:') throw new Error('https:// 주소만 됩니다');
  if (u.username || u.password) throw new Error('사용자 정보가 든 주소는 받지 않습니다');
  if (u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) throw new Error('경로 없이 https://이름 까지만 넣으세요');
  if (raw.replace(/\/$/, '') !== u.origin && raw.replace(/\/$/, '') !== `${u.protocol}//${u.host}`) throw new Error('소문자·기본 포트 없이 적어 주세요');
  // 앱 시작 화면 자신이 https://localhost — 같은 이름이면 서버 화면과 앱 화면이 섞인다
  if (u.hostname === 'localhost' || u.hostname.endsWith('.localhost')) throw new Error('localhost 는 쓸 수 없습니다');
  return u.origin;
}
