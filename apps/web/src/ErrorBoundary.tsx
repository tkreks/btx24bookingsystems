import { Component, type ReactNode } from 'react';
import type { ClientErrorDto } from '@btx24/shared';
import { apiPost } from './api.js';

declare const __BUILD_ID__: string;

/**
 * Перехват ошибки отрисовки: вместо белого экрана — сообщение и «Закрыть», трасса — в журнал
 * действий (`app.error`), чтобы причину можно было найти по сборке.
 */
export class ErrorBoundary extends Component<{ where: string; onClose?: () => void; children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    const report: ClientErrorDto = {
      where: this.props.where.slice(0, 64),
      message: String(error?.message ?? error).slice(0, 500),
      stack: `${error?.stack ?? ''}\n--- components:${info.componentStack ?? ''}`.slice(0, 4000),
      build: (typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : '').slice(0, 64),
    };
    void apiPost('/activity/error', report).catch(() => undefined);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="sheet-backdrop">
        <div className="sheet card" role="alertdialog" aria-label="Ошибка">
          <h3>Что-то пошло не так</h3>
          <p className="muted">Ошибка уже записана в журнал. Закройте окно и попробуйте ещё раз; если повторится — сообщите администратору.</p>
          <p className="notice error">{this.state.error.message}</p>
          <div className="form-actions">
            <button
              type="button"
              className="primary"
              onClick={() => {
                this.setState({ error: null });
                this.props.onClose?.();
              }}
            >
              Закрыть
            </button>
          </div>
        </div>
      </div>
    );
  }
}
