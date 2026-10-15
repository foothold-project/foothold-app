// 앱 입구: 해시 경로로 화면 하나만 그린다(렌더러 하나). 링크(WS)는 여기서 한 번만 연다.
import { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { qc } from './data/shared';
import { startLink, useLink } from './data/link';
import { auth, isLogin, loginHash } from './data/auth';
import { dropScratch } from './data/scratch';
import { useEffect } from 'react';
import { Toast, useRoute, useStopKey } from './app/shell';
import './live.css';
import './brand.css';
import { syncTheme } from './app/theme';

// 옮긴 화면만 여기 있다. 나머지는 묶음 2·3 에서(아래 «아직 옮기지 않음» 안내).
const SCREENS: Record<string, React.LazyExoticComponent<() => JSX.Element>> = {
  Report: lazy(() => import('./screens/Report')),
  PcHistory: lazy(() => import('./screens/PcHistory')),
  MHistory: lazy(() => import('./screens/MHistory')),
  MAlerts: lazy(() => import('./screens/MAlerts')),
  MAlert: lazy(() => import('./screens/MAlert')),
  PcMissions: lazy(() => import('./screens/PcMissions')),
  PcPlan: lazy(() => import('./screens/PcPlan')),
  MHome: lazy(() => import('./screens/MHome')),
  MFinding: lazy(() => import('./screens/MFinding')),
  MDrive: lazy(() => import('./screens/MDrive')),
  PcRobot: lazy(() => import('./screens/PcRobot')),
  PcSettings: lazy(() => import('./screens/PcSettings')),
  PcMap: lazy(() => import('./screens/PcMap')),
  MMap: lazy(() => import('./screens/MMap')),
  PcReview: lazy(() => import('./screens/PcReview')),
  Main: lazy(() => import('./screens/Main')),
  MLogin: lazy(() => import('./screens/MLogin')),
  PcLogin: lazy(() => import('./screens/PcLogin')),
  System: lazy(() => import('./screens/System')),
};
const HOME = 'Main';   // B2 A1: PC 첫 화면 = 관제(기록은 메뉴)

function App() {
  useStopKey();
  const { name } = useRoute(), S = SCREENS[name || HOME], authEnd = useLink((s) => s.authEnd);
  // 관문이 로그인 없음·세션 끝(WS 4401)을 알리면 로그인 화면으로(돌아올 곳 기억). 이 PC 전용 주소(http)는 로그인 없음
  useEffect(() => { if (authEnd) dropScratch(); }, [authEnd]);   // 세션 끝(WS 4401) → 탭 보관 초안·지점 선택 버림(다른 계정으로 복원 0)
  useEffect(() => { if (authEnd && auth.gated && !isLogin(name)) location.replace(loginHash()); }, [authEnd, name]);
  return (
    <QueryClientProvider client={qc}>
      <Suspense fallback={<p className="lv-note">화면 여는 중…</p>}>
        {S ? <S /> : <p className="lv-note" style={{ padding: 16 }}>{`«${name}» 화면은 아직 React 로 옮기지 않았습니다.`} <a href={`#/${HOME}`}>관제로</a></p>}
      </Suspense>
      <Toast />
    </QueryClientProvider>
  );
}
startLink();
syncTheme();
createRoot(document.getElementById('root')!).render(<App />);
