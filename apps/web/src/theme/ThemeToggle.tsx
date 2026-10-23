import { useState } from 'react';
import { applyTheme, saveTheme, savedTheme, THEME_LABELS, THEME_NEXT, type ThemeChoice } from './theme.js';

const ICON: Record<ThemeChoice, string> = { light: '☀', dark: '☾', auto: '◐' };

/** Кнопка темы: светлая → тёмная → как в системе. */
export function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>(savedTheme);
  const next = THEME_NEXT[choice];
  return (
    <button
      className="settings-button theme-toggle"
      title={`${THEME_LABELS[choice]}. Нажмите: ${THEME_LABELS[next].toLowerCase()}`}
      aria-label={`${THEME_LABELS[choice]}, переключить`}
      onClick={() => {
        setChoice(next);
        saveTheme(next);
        applyTheme(next);
      }}
    >
      <span aria-hidden="true">{ICON[choice]}</span>
    </button>
  );
}
