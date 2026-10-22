import { useSessionProblem } from './session-guard.js';

/** Блокирует интерфейс, когда продолжать без обновления страницы нельзя. */
export function SessionOverlay() {
  const problem = useSessionProblem();
  if (!problem) return null;
  return (
    <div className="session-overlay" role="alertdialog" aria-modal="true" aria-labelledby="session-overlay-title">
      <div className="card">
        <h2 id="session-overlay-title">{problem === 'auth' ? 'Сессия Битрикс24 истекла' : 'Вышло обновление приложения'}</h2>
        <p className="muted">
          {problem === 'auth'
            ? 'Портал не выдал новый доступ — обычно после долгого бездействия или выхода из Битрикс24. Обновите страницу, несохранённые данные формы придётся ввести заново.'
            : 'Обновите страницу, чтобы продолжить работу в новой версии.'}
        </p>
        <button className="primary" type="button" onClick={() => window.location.reload()}>
          Обновить страницу
        </button>
      </div>
    </div>
  );
}
