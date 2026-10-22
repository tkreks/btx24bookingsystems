import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from 'react';
import { VARIABLE_MENU } from '@btx24/shared';

/** Вставить текст в позицию курсора поля (или в конец, если поле не в фокусе). */
export function insertAt(el: HTMLTextAreaElement | null, value: string, token: string): { text: string; caret: number } {
  const start = el?.selectionStart ?? value.length;
  const end = el?.selectionEnd ?? value.length;
  return { text: value.slice(0, start) + token + value.slice(end), caret: start + token.length };
}

/** Список «＋ Переменная» — как вставка полей в шаблонизаторе Битрикс24, только проще. */
export function VariableMenu({ payment = false, onPick, disabled }: { payment?: boolean; onPick: (token: string) => void; disabled?: boolean }) {
  return (
    <select
      className="var-menu"
      aria-label="Вставить переменную"
      value=""
      disabled={disabled}
      onChange={(e) => {
        if (e.target.value) onPick(e.target.value);
      }}
    >
      <option value="">＋ Переменная</option>
      {VARIABLE_MENU.filter((v) => payment || !v.payment).map((v) => (
        <option key={v.token} value={v.token}>
          {v.label} — {v.token}
        </option>
      ))}
    </select>
  );
}

/** Текст сообщения с кнопкой вставки переменных в позицию курсора. */
export function VarTextarea({
  value,
  onChange,
  payment = false,
  ...rest
}: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange' | 'value'> & { value: string; onChange: (v: string) => void; payment?: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // Курсор — после того, как React записал новый текст в поле (иначе он уезжает в конец).
  const caret = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (caret.current === null || !ref.current) return;
    ref.current.focus();
    ref.current.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  });
  return (
    <span className="var-textarea">
      <textarea ref={ref} value={value} onChange={(e) => onChange(e.target.value)} {...rest} />
      <VariableMenu
        payment={payment}
        disabled={rest.disabled}
        onPick={(token) => {
          const r = insertAt(ref.current, value, token);
          caret.current = r.caret;
          onChange(r.text);
        }}
      />
    </span>
  );
}
