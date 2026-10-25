import { useEffect, useRef, useState } from 'react';
import type { StoredFileDto } from '@btx24/shared';
import { apiPost, apiUpload } from '../api.js';
import { DiskPicker } from '../settings/DiskPicker.js';
import { Icon } from './icons.js';

/** Значок Битрикс24 (облако в фирменном цвете) — источник «файл с Диска портала». */
export function Bitrix24Icon({ size = 16 }: { size?: number }) {
  return (
    <svg className="b24-glyph" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="12" fill="#2fc6f6" />
      <text x="12" y="16" textAnchor="middle" fontSize="10.5" fontWeight="700" fill="#fff" fontFamily="Arial, sans-serif">24</text>
    </svg>
  );
}

/**
 * Одинаковые источники вложений для чата, шаблонов оплаты, рассылки и подтверждений. `compact` — только
 * значки (скрепка — с устройства, Битрикс24 — с Диска) без подписей и строки о лимитах (чат).
 */
export function AttachmentButtons({ remaining, onAdd, disabled = false, onBusyChange, compact = false }: { remaining: number; onAdd: (files: StoredFileDto[]) => void; disabled?: boolean; onBusyChange?: (busy: boolean) => void; compact?: boolean }) {
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
  return <div className={`attachment-controls${compact ? ' compact' : ''}`}>
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
      <button type="button" disabled={disabled || busy || remaining <= 0} onClick={() => input.current?.click()} title="Файл с устройства (до 10 файлов, до 10 МБ каждый)" aria-label="Прикрепить файл с устройства"><Icon name="clip" size={16} />{!compact && 'Из устройства'}</button>
      <button type="button" disabled={disabled || busy || remaining <= 0} onClick={() => { setError(''); setPicker(true); }} title="Файл с Диска Битрикс24" aria-label="Прикрепить файл из Битрикс24">{compact ? <Bitrix24Icon size={17} /> : <><Icon name="folder" size={16} />Из Битрикса</>}</button>
      {busy && <span role="status" className="muted">{compact ? <span className="spinner" aria-label="Загрузка" /> : 'Загрузка…'}</span>}
    </div>
    {!compact && <span className="attachment-limit muted">До 10 файлов в сообщении · до 10 МБ каждый</span>}
    {error && <p className="error" role="alert">{error}</p>}
    {picker && <DiskPicker endpoint="/openlines/disk" onClose={() => setPicker(false)} onPick={(f) => {
      setPicker(false);
      void run(async () => [await apiPost<StoredFileDto>('/openlines/files/disk', { fileId: f.id })]);
    }} />}
  </div>;
}
