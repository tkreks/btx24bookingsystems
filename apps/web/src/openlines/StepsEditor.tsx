import { useLayoutEffect, useRef, useState } from 'react';
import { AttachmentButtons } from './AttachmentButtons.js';
import { moveStep, newStep, type ChainStep } from './chain.js';
import { fileSize } from './format.js';
import { insertAt, VariableMenu } from '../settings/VarTextarea.js';

/**
 * Цепочка сообщений: каждый шаг — текст и вложения; шаги уходят по порядку. Используется и при
 * отправке в чат, и в редакторе шаблонов.
 */
export function StepsEditor({
  steps,
  onChange,
  disabled = false,
  onSubmitShortcut,
  variables = false,
  paymentVariables = false,
  onUploadingChange,
  compact = false,
}: {
  /** Чат: без «＋ ещё сообщение», вложения — значками в правом верхнем углу поля. */
  compact?: boolean;
  steps: ChainStep[];
  onChange: (steps: ChainStep[]) => void;
  disabled?: boolean;
  onUploadingChange?: (busy: boolean) => void;
  /** Меню «＋ Переменная» (редактор шаблонов; при вставке в чат значения подставит сделка). */
  variables?: boolean;
  /** В меню — и переменные оплаты ({link}, {prepayment}…): шаблон сообщения об оплате. */
  paymentVariables?: boolean;
  /** Ctrl/⌘+Enter в тексте. */
  onSubmitShortcut?: () => void;
}) {
  const [uploading, setUploading] = useState<string | null>(null);

  const areas = useRef(new Map<string, HTMLTextAreaElement>());
  // Курсор после вставки переменной — когда React уже записал новый текст в поле.
  const caret = useRef<{ key: string; pos: number } | null>(null);
  useLayoutEffect(() => {
    const c = caret.current;
    const el = c ? areas.current.get(c.key) : undefined;
    if (!c || !el) return;
    el.focus();
    el.setSelectionRange(c.pos, c.pos);
    caret.current = null;
  });
  const patch = (key: string, p: Partial<ChainStep>) =>
    onChange(steps.map((s) => (s.key === key ? { ...s, ...p } : s)));

  return (
    <div className={`steps-editor${compact ? ' compact' : ''}`}>
      {steps.map((s, i) => (
        <div className="step" key={s.key}>
          {steps.length > 1 && <span className="step-number">{i + 1}</span>}
          <div className="step-body">
            <textarea
              ref={(el) => {
                if (el) areas.current.set(s.key, el);
                else areas.current.delete(s.key);
              }}
              rows={steps.length > 1 ? 2 : 3}
              placeholder={steps.length > 1 ? `Сообщение ${i + 1}` : 'Сообщение'}
              aria-label={`Текст сообщения ${i + 1}`}
              value={s.text}
              disabled={disabled || uploading !== null}
              maxLength={4000}
              onChange={(e) => patch(s.key, { text: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && onSubmitShortcut) {
                  e.preventDefault();
                  onSubmitShortcut();
                }
              }}
            />
            {compact && <AttachmentButtons compact disabled={disabled || uploading !== null} remaining={10 - s.files.length} onBusyChange={(busy) => { setUploading(busy ? s.key : null); onUploadingChange?.(busy); }} onAdd={(files) => patch(s.key, { files: [...s.files, ...files] })} />}
            {variables && (
              <VariableMenu
                payment={paymentVariables}
                disabled={disabled || uploading !== null}
                onPick={(token) => {
                  const r = insertAt(areas.current.get(s.key) ?? null, s.text, token);
                  caret.current = { key: s.key, pos: r.caret };
                  patch(s.key, { text: r.text });
                }}
              />
            )}
            {s.files.length > 0 && (
              <ul className="step-files">
                {s.files.map((f) => (
                  <li key={f.id}>
                    📎 {f.name} <span className="muted">{fileSize(f.size)}</span>
                    <button
                      type="button"
                      aria-label={`Убрать вложение ${f.name}`}
                      disabled={disabled || uploading !== null}
                      onClick={() => patch(s.key, { files: s.files.filter((x) => x.id !== f.id) })}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {!compact && <AttachmentButtons disabled={disabled || uploading !== null} remaining={10 - s.files.length} onBusyChange={(busy) => { setUploading(busy ? s.key : null); onUploadingChange?.(busy); }} onAdd={(files) => patch(s.key, { files: [...s.files, ...files] })} />}
          <div className="step-actions">
            {steps.length > 1 && (
              <>
                <button
                  type="button"
                  aria-label={`Выше: сообщение ${i + 1}`}
                  disabled={disabled || uploading !== null || i === 0}
                  onClick={() => onChange(moveStep(steps, i, -1))}
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={`Ниже: сообщение ${i + 1}`}
                  disabled={disabled || uploading !== null || i === steps.length - 1}
                  onClick={() => onChange(moveStep(steps, i, 1))}
                >
                  ↓
                </button>
                <button
                  type="button"
                  aria-label={`Удалить сообщение ${i + 1}`}
                  disabled={disabled || uploading !== null}
                  onClick={() => onChange(steps.filter((x) => x.key !== s.key))}
                >
                  ×
                </button>
              </>
            )}
          </div>
        </div>
      ))}
      {!compact && (
        <button
          type="button"
          className="link"
          disabled={disabled || uploading !== null || steps.length >= 20}
          onClick={() => onChange([...steps, newStep()])}
        >
          + ещё сообщение в цепочку
        </button>
      )}
    </div>
  );
}
