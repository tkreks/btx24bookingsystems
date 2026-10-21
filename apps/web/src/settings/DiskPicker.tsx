import { useEffect, useState } from 'react';
import type { DiskFileRef, DiskItemDto } from '@btx24/shared';
import { apiGet } from '../api.js';
import { fileSize } from '../openlines/format.js';

type Place = { label: string; query: string };

/** Выбор файла с Диска Битрикс24: хранилища → папки → файл. */
export function DiskPicker({ onPick, onClose }: { onPick: (f: DiskFileRef) => void; onClose: () => void }) {
  const [path, setPath] = useState<Place[]>([{ label: 'Диск', query: '' }]);
  const [items, setItems] = useState<{ query: string; list: DiskItemDto[] } | null>(null);
  const [error, setError] = useState('');
  const current = path[path.length - 1];

  useEffect(() => {
    let active = true;
    apiGet<DiskItemDto[]>(`/admin/disk${current.query}`).then(
      (list) => {
        if (!active) return;
        setItems({ query: current.query, list });
        setError('');
      },
      (e) => active && setError(e instanceof Error ? e.message : 'Диск недоступен'),
    );
    return () => {
      active = false;
    };
  }, [current.query]);

  const list = items?.query === current.query ? items.list : null;
  const open = (x: DiskItemDto) => {
    if (x.kind === 'file') return onPick({ id: x.id, name: x.name });
    setPath([...path, { label: x.name, query: x.kind === 'storage' ? `?storageId=${x.id}` : `?folderId=${x.id}` }]);
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet disk-picker" role="dialog" aria-modal="true" aria-label="Файл с Диска" onClick={(e) => e.stopPropagation()}>
        <header>
          <h3>Файл с Диска</h3>
          <button aria-label="Закрыть" onClick={onClose}>
            ×
          </button>
        </header>
        <nav className="disk-path" aria-label="Путь">
          {path.map((p, i) => (
            <button key={i} className="link" disabled={i === path.length - 1} onClick={() => setPath(path.slice(0, i + 1))}>
              {p.label}
            </button>
          ))}
        </nav>
        {error && (
          <div className="notice error" role="alert">
            {error}
          </div>
        )}
        {!list && !error && <p className="muted">Загрузка…</p>}
        {list && !list.length && <p className="muted">Пусто.</p>}
        <ul className="disk-list">
          {list?.map((x) => (
            <li key={`${x.kind}${x.id}`}>
              <button onClick={() => open(x)}>
                <span aria-hidden="true">{x.kind === 'file' ? '📄' : x.kind === 'folder' ? '📁' : '🗄'}</span> {x.name}
                {x.kind === 'file' && x.size !== null && <span className="muted"> · {fileSize(x.size)}</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
