import { LoadProgress } from './LoadProgress.js';

/**
 * Блок ещё без данных: заготовка строк в форме настоящих записей и надпись «Идёт загрузка данных…»
 * — блок сразу занимает своё место, и при появлении данных страница не прыгает.
 */
export function BlockLoading({ rows = 3, name = 'block' }: { rows?: number; /** Для оценки прогресса по прошлым загрузкам. */ name?: string }) {
  return (
    <div className="block-loading" role="status" aria-label="Идёт загрузка данных">
      <ul className="block-loading-rows" aria-hidden="true">
        {Array.from({ length: rows }, (_, i) => (
          <li key={i}>
            <i className="sk-avatar" />
            <span>
              <i className="sk-line" style={{ width: `${70 - ((i * 17) % 30)}%` }} />
              <i className="sk-line short" />
            </span>
          </li>
        ))}
      </ul>
      <span className="block-loading-label">
        <span className="spinner" aria-hidden="true" />
        <LoadProgress name={name} label="Загрузка данных" />
      </span>
    </div>
  );
}
