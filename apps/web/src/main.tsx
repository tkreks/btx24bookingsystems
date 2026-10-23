import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import './styles.css';
// Тёмная тема — после основных стилей (её правила той же специфичности должны идти позже).
import 'virtual:dark-theme.css';
import { applyTheme, savedTheme } from './theme/theme.js';

applyTheme(savedTheme());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary where="app" onClose={() => window.location.reload()}>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
