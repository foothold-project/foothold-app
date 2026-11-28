import { createRoot } from 'react-dom/client';
import { Root } from './session';
import './frame.css';
import './brand.css';
import './shell.css';   // 시안 껍데기(proto pc.css · ui.css 값)
import { syncTheme } from './theme';
import { syncGamepad } from './gamepad';

syncTheme();
syncGamepad();
createRoot(document.getElementById('root')!).render(<Root />);
