// 앱 입구: 해시 경로로 화면 하나만 그린다(렌더러 하나). 링크(WS)는 여기서 한 번만 연다.
import { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { qc } from './data/shared';
import { startLink } from './data/link';
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
  PcRobot: lazy(() => import('./screens/PcRobot')),
  PcSettings: lazy(() => import('./screens/PcSettings')),
  PcMap: lazy(() => import('./screens/PcMap')),
  MMap: lazy(() => import('./screens/MMap')),
};
const HOME = 'PcHistory';

function App() {
  useStopKey();
  const { name } = useRoute(), S = SCREENS[name || HOME];
  return (
    <QueryClientProvider client={qc}>
      <Suspense fallback={<p className="lv-note">화면 여는 중…</p>}>
        {S ? <S /> : <p className="lv-note" style={{ padding: 16 }}>{`«${name}» 화면은 아직 React 로 옮기지 않았습니다.`} <a href={`#/${HOME}`}>기록으로</a></p>}
      </Suspense>
      <Toast />
    </QueryClientProvider>
  );
}
startLink();
syncTheme();
createRoot(document.getElementById('root')!).render(<App />);
