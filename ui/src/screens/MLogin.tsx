// MLogin(원본 틀): 보호 관문 로그인 — 실제 로그인은 app/login · 전송은 data/auth(웹 쿠키 관문). 예시 계정·비밀번호 없음.
import { CSS, View } from './MLogin.view';
import { themeClass } from '../data/fmt';
import { useLoginVals } from '../app/login';

export default function MLogin() {
  const v = { themeClass: themeClass(false), ...useLoginVals(true) };
  return <><style>{CSS}</style><div id="dc-root"><View v={v} /></div></>;
}
