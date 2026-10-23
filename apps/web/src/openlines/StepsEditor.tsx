import { useLayoutEffect, useRef, useState } from 'react';
import type { StoredFileDto } from '@btx24/shared';
import { apiUpload } from '../api.js';
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
}: {
  steps: ChainStep[];
  onChange: (steps: ChainStep[]) => void;
  disabled?: boolean;
  /** Меню «＋ Переменная» (редактор шаблонов; при вставке в чат значения подставит сделка). */
  variables?: boolean;
  /** В меню — и переменные оплаты ({link}, {prepayment}…): шаблон сообщения об оплате. */
  paymentVariables?: boolean;
  /** Ctrl/⌘+Enter в тексте. */
  onSubmitShortcut?: () => void;
}) {
  const [uploading, setUploading] = useState<string | null>(null);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const target = useRef<string | null>(null);
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

  const pick = (key: string) => {
    target.current = key;
    input.current?.click();
  };
  const upload = async (files: FileList | null) => {
    const key = target.current;
    if (!files?.length || !key) return;
    setError('');
    setUploading(key);
    try {
      const added: StoredFileDto[] = [];
      for (const f of Array.from(files)) {
        if (f.size > 10 * 1024 * 1024) throw new Error(`«${f.name}» больше 10 МБ`);
        added.push(await apiUpload<StoredFileDto>('/openlines/files', f));
      }
      const step = steps.find((s) => s.key === key);
      if (step) patch(key, { files: [...step.files, ...added].slice(0, 10) });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось загрузить файл');
    } finally {
      setUploading(null);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <div className="steps-editor">
      <input ref={input} type="file" multiple hidden onChange={(e) => void upload(e.target.files)} />
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
              disabled={disabled}
              maxLength={4000}
              onChange={(e) => patch(s.key, { text: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && onSubmitShortcut) {
                  e.preventDefault();
                  onSubmitShortcut();
                }
              }}
            />
            {variables && (
              <VariableMenu
                payment={paymentVariables}
                disabled={disabled}
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
                      disabled={disabled}
                      onClick={() => patch(s.key, { files: s.files.filter((x) => x.id !== f.id) })}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="step-actions">
            <button
              type="button"
              title="Вложение"
              aria-label={`Вложение к сообщению ${i + 1}`}
              disabled={disabled || uploading !== null}
              onClick={() => pick(s.key)}
            >
              {uploading === s.key ? '…' : '📎'}
            </button>
            {steps.length > 1 && (
              <>
                <button
                  type="button"
                  aria-label={`Выше: сообщение ${i + 1}`}
                  disabled={disabled || i === 0}
                  onClick={() => onChange(moveStep(steps, i, -1))}
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={`Ниже: сообщение ${i + 1}`}
                  disabled={disabled || i === steps.length - 1}
                  onClick={() => onChange(moveStep(steps, i, 1))}
                >
                  ↓
                </button>
                <button
                  type="button"
                  aria-label={`Удалить сообщение ${i + 1}`}
                  disabled={disabled}
                  onClick={() => onChange(steps.filter((x) => x.key !== s.key))}
                >
                  ×
                </button>
              </>
            )}
          </div>
        </div>
      ))}
      <button
        type="button"
        className="link"
        disabled={disabled || steps.length >= 20}
        onClick={() => onChange([...steps, newStep()])}
      >
        + ещё сообщение в цепочку
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
