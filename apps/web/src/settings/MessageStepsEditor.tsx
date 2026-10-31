import { clientFileKey, unknownVariables, type ClientMessageStep } from '@btx24/shared';
import { AttachmentButtons } from '../openlines/AttachmentButtons.js';
import { VarTextarea } from './VarTextarea.js';
import { move } from './group-form.js';

/** Редактор цепочки сообщений клиенту: текст с переменными и файлы (Диск / устройство), порядок, удаление. */
export function MessageStepsEditor({
  steps,
  onChange,
  label,
  empty,
  onUploadingChange,
}: {
  steps: ClientMessageStep[];
  onChange: (steps: ClientMessageStep[]) => void;
  /** Подпись для скринридера: «<label>: сообщение N». */
  label: string;
  /** Что написать, когда сообщений нет. */
  empty: string;
  onUploadingChange?: (busy: boolean) => void;
}) {
  const patchStep = (k: number, p: Partial<ClientMessageStep>) => onChange(steps.map((s, j) => (j === k ? { ...s, ...p } : s)));
  return (
    <>
      {!steps.length && <p className="muted">{empty}</p>}
      <ol className="message-steps">
        {steps.map((s, k) => {
          const unknown = unknownVariables(s.text);
          return (
            <li key={k}>
              <VarTextarea
                rows={Math.min(12, Math.max(2, s.text.split('\n').length))}
                maxLength={4000}
                value={s.text}
                aria-label={`${label}: сообщение ${k + 1}`}
                placeholder="Текст (можно пустой, если только файлы)"
                onChange={(text) => patchStep(k, { text })}
              />
              {unknown.length > 0 && <p className="error">Неизвестные переменные: {unknown.map((u) => `{${u}}`).join(', ')}</p>}
              <div className="step-files-row">
                {s.files.map((f) => (
                  <span key={clientFileKey(f)} className="pill">
                    📎 {f.name}
                    <button type="button" aria-label={`Убрать файл ${f.name}`} onClick={() => patchStep(k, { files: s.files.filter((x) => clientFileKey(x) !== clientFileKey(f)) })}>
                      ×
                    </button>
                  </span>
                ))}
                <AttachmentButtons onBusyChange={onUploadingChange} remaining={10 - s.files.length} onAdd={(files) => patchStep(k, { files: [...s.files, ...files.map((f) => ({ storedFileId: f.id, name: f.name }))] })} />
              </div>
              <span className="row-actions">
                <button type="button" aria-label="Выше" disabled={k === 0} onClick={() => onChange(move(steps, k, -1))}>
                  ↑
                </button>
                <button type="button" aria-label="Ниже" disabled={k === steps.length - 1} onClick={() => onChange(move(steps, k, 1))}>
                  ↓
                </button>
                <button type="button" aria-label={`Удалить сообщение ${k + 1}`} onClick={() => onChange(steps.filter((_, j) => j !== k))}>
                  ×
                </button>
              </span>
            </li>
          );
        })}
      </ol>
      <div className="form-actions">
        <button type="button" className="link" onClick={() => onChange([...steps, { text: '', files: [] }])}>
          + сообщение
        </button>
      </div>
    </>
  );
}
