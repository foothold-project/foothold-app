import { createRoot } from 'react-dom/client';
import { App } from './App';
import { USERS } from './fake';
import './frame.css';
import './brand.css';
import { syncTheme } from './theme';

// 가짜 로그인: ?as=<사용자 id> (기본 = 첫 사용자). 진짜 로그인은 서버 계약이 나온 뒤
const as = new URLSearchParams(location.search).get('as');
syncTheme();
createRoot(document.getElementById('root')!).render(<App initialUser={USERS.some((u) => u.id === as) ? as! : undefined} />);
