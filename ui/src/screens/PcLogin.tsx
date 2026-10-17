// PcLogin(원본 틀): 보호 관문 로그인 — 실제 로그인은 app/login · 전송은 data/auth(웹 쿠키 관문). 예시 계정·비밀번호 없음.
import { CSS, View } from './PcLogin.view';
import { themeClass } from '../data/fmt';
import { useLoginVals } from '../app/login';

export default function PcLogin() {
  const v = { themeClass: themeClass(true), ...useLoginVals(false) };
  return <><style>{CSS}</style><div id="dc-root"><View v={v} /></div></>;
}
