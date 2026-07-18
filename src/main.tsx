import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/global.scss';
import catAvatar from '@/assets/cat-avatar.png';
import App from './App.tsx';

document.title = 'CPA-Manager';
document.documentElement.setAttribute('translate', 'no');
document.documentElement.classList.add('notranslate');

const faviconEl = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
if (faviconEl) {
  faviconEl.href = catAvatar;
  faviconEl.type = 'image/png';
} else {
  const newFavicon = document.createElement('link');
  newFavicon.rel = 'icon';
  newFavicon.type = 'image/png';
  newFavicon.href = catAvatar;
  document.head.appendChild(newFavicon);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
