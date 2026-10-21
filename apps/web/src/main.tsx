import { createRoot } from 'react-dom/client';
import { Root } from './session';
import './frame.css';
import './brand.css';
import { syncTheme } from './theme';

syncTheme();
createRoot(document.getElementById('root')!).render(<Root />);
