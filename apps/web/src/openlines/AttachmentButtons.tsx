import { useEffect, useRef, useState } from 'react';
import type { StoredFileDto } from '@btx24/shared';
import { apiPost, apiUpload } from '../api.js';
import { DiskPicker } from '../settings/DiskPicker.js';
import { Icon } from './icons.js';

/** Одинаковые источники вложений для чата, шаблонов оплаты, рассылки и подтверждений. */
export function AttachmentButtons({ remaining, onAdd, disabled = false, onBusyChange }: { remaining: number; onAdd: (files: StoredFileDto[]) => void; disabled?: boolean; onBusyChange?: (busy: boolean) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const addRef = useRef(onAdd); addRef.current = onAdd;
  const busyRef = useRef(onBusyChange); busyRef.current = onBusyChange;
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; busyRef.current?.(false); }; }, []);
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (load: () => Promise<StoredFileDto[]>) => {
    if (busy || disabled || remaining <= 0) return;
    setBusy(true); onBusyChange?.(true); setError('');
    try { const files = await load(); if (active.current) addRef.current(files); }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось прикрепить файл'); }
    finally { setBusy(false); onBusyChange?.(false); if (input.current) input.current.value = ''; }
  };
  return <div className="attachment-controls">
    <input ref={input} type="file" multiple hidden aria-label="Файлы из устройства" onChange={(e) => {
      const files = Array.from(e.target.files ?? []);
      if (!files.length) return;
      if (files.length > remaining) { setError(`Можно добавить ещё ${remaining} вложений`); e.target.value = ''; return; }
      if (files.some((f) => f.size > 10 * 1024 * 1024)) { setError('Каждый файл должен быть не больше 10 МБ'); e.target.value = ''; return; }
      void run(async () => {
        const added: StoredFileDto[] = [];
        try { for (const f of files) added.push(await apiUpload<StoredFileDto>('/openlines/files', f)); }
        catch (e) { if (added.length && active.current) addRef.current(added); throw e; }
        return added;
      });
    }} />
    <div className="attachment-sources">
      <button type="button" disabled={disabled || busy || remaining <= 0} onClick={() => input.current?.click()}><Icon name="clip" size={16} />Из устройства</button>
      <button type="button" disabled={disabled || busy || remaining <= 0} onClick={() => { setError(''); setPicker(true); }}><Icon name="folder" size={16} />Из Битрикса</button>
      {busy && <span role="status" className="muted">Загрузка…</span>}
    </div>
    <span className="attachment-limit muted">До 10 файлов в сообщении · до 10 МБ каждый</span>
    {error && <p className="error" role="alert">{error}</p>}
    {picker && <DiskPicker endpoint="/openlines/disk" onClose={() => setPicker(false)} onPick={(f) => {
      setPicker(false);
      void run(async () => [await apiPost<StoredFileDto>('/openlines/files/disk', { fileId: f.id })]);
    }} />}
  </div>;
}
