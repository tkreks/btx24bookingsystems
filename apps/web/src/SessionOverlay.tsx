import { useSessionProblem } from './session-guard.js';

/** Блокирует интерфейс, когда продолжать без обновления страницы нельзя. */
export function SessionOverlay() {
  const problem = useSessionProblem();
  if (!problem) return null;
  return (
    <div className="session-overlay" role="alertdialog" aria-modal="true" aria-labelledby="session-overlay-title">
      <div className="card">
        <h2 id="session-overlay-title">{TITLES[problem]}</h2>
        <p className="muted">{TEXTS[problem]}</p>
        <button className="primary" type="button" onClick={() => window.location.reload()}>
          Обновить страницу
        </button>
      </div>
    </div>
  );
}

const TITLES = {
  auth: 'Сессия Битрикс24 истекла',
  update: 'Вышло обновление приложения',
  denied: 'Доступ к приложению ограничен',
} as const;
const TEXTS = {
  auth: 'Портал не выдал новый доступ — обычно после долгого бездействия или выхода из Битрикс24. Обновите страницу, несохранённые данные формы придётся ввести заново.',
  update: 'Обновите страницу, чтобы продолжить работу в новой версии.',
  denied: 'Администратор убрал вас из списка доступа к приложению. Обратитесь к администратору портала.',
} as const;
