import { useEffect, useRef } from 'react';
import type { MessageTemplateDto } from '@btx24/shared';

/** Частые за 30 дней — сверху; при равенстве — по названию. */
export function byUsage(list: MessageTemplateDto[]): MessageTemplateDto[] {
  return [...list].sort((a, b) => (b.uses30d ?? 0) - (a.uses30d ?? 0) || a.name.localeCompare(b.name, 'ru'));
}

/**
 * Окно «Шаблоны» в чате: сверху — «Новый шаблон» (название, сообщения, вложения), ниже — шаблоны чата
 * по частоте использования за 30 дней. Нажатие вставляет шаблон в поле сообщения (не отправляет).
 */
export function TemplatesPicker({ templates, onPick, onCreate, onManage, onClose }: {
  templates: MessageTemplateDto[];
  onPick: (t: MessageTemplateDto) => void;
  onCreate: () => void;
  onManage: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => ref.current?.showModal(), []);
  const list = byUsage(templates.filter((t) => t.purpose === 'chat'));
  return (
    <dialog ref={ref} className="new-dialog templates-picker" aria-label="Шаблоны" onCancel={(e) => { e.preventDefault(); onClose(); }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <header className="new-dialog-head">
        <h3>Шаблоны</h3>
        <button type="button" className="new-dialog-close" aria-label="Закрыть" onClick={onClose}>×</button>
      </header>
      <button type="button" className="primary templates-picker-new" onClick={onCreate}>＋ Новый шаблон</button>
      {!list.length && <p className="muted">Шаблонов пока нет.</p>}
      <ul className="templates-picker-list">
        {list.map((t) => {
          const text = t.steps.map((s) => s.text).find(Boolean) ?? '';
          const files = t.steps.reduce((n, s) => n + s.files.length, 0);
          return (
            <li key={t.id}>
              <button type="button" onClick={() => onPick(t)} title="Вставить в сообщение">
                <span className="templates-picker-name">
                  <b>{t.name}</b>
                  {t.shared && <span className="pill">общий</span>}
                  {!!t.uses30d && <span className="muted">· {t.uses30d} за 30 дн.</span>}
                </span>
                {text && <span className="templates-picker-text muted">{text}</span>}
                {(t.steps.length > 1 || files > 0) && (
                  <span className="templates-picker-meta muted">
                    {t.steps.length > 1 && `сообщений: ${t.steps.length}`}
                    {t.steps.length > 1 && files > 0 && ' · '}
                    {files > 0 && `📎 ${files}`}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {!!list.length && (
        <button type="button" className="link templates-picker-manage" onClick={onManage}>
          Изменить или удалить шаблоны
        </button>
      )}
    </dialog>
  );
}
