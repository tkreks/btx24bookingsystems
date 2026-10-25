import { useEffect, useState, type ReactNode } from 'react';
import type { DiskFileRef, DiskItemDto, DiskBrowseDto, DiskStartDto } from '@btx24/shared';
import { apiGet } from '../api.js';
import { fileSize } from '../openlines/format.js';
import { MinimizeButton } from '../Minimize.js';

type Place = { label: string; query: string };

const ROOT: Place[] = [{ label: 'Диск', query: '' }];

/**
 * Выбор файла с Диска Битрикс24: хранилища → папки → файл. Вложения сотрудников (`/openlines/disk`)
 * открываются в папке шаблонов общего диска, без доступа к ней — на «Моём диске»; оба переключаются.
 */
export function DiskPicker({ onPick, onClose, endpoint = '/admin/disk' }: { onPick: (f: DiskFileRef) => void; onClose: () => void; endpoint?: string }) {
  const places = endpoint === '/openlines/disk';
  const [start, setStart] = useState<DiskStartDto | null>(null);
  const [path, setPath] = useState<Place[] | null>(places ? null : ROOT);
  useEffect(() => {
    if (!places) return;
    let active = true;
    void apiGet<DiskStartDto>('/openlines/disk/start').then(
      (v) => {
        if (!active) return;
        setStart(v);
        setPath((v.initial === 'user' ? v.user : v.shared) ?? v.shared ?? v.user ?? ROOT);
      },
      () => active && setPath(ROOT),
    );
    return () => {
      active = false;
    };
  }, [places]);
  return path ? <Browser path={path} setPath={setPath} start={start} endpoint={endpoint} onPick={onPick} onClose={onClose} /> : <Frame onClose={onClose}><p className="muted">Загрузка…</p></Frame>;
}

function Frame({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet disk-picker" role="dialog" aria-modal="true" aria-label="Файл с Диска" onClick={(e) => e.stopPropagation()}>
        <header>
          <h3>Файл с Диска</h3>
          <MinimizeButton label="Файлы Диска" />
          <button aria-label="Закрыть" onClick={onClose}>
            ×
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

function Browser({ path, setPath, start, endpoint, onPick, onClose }: { path: Place[]; setPath: (p: Place[]) => void; start: DiskStartDto | null; endpoint: string; onPick: (f: DiskFileRef) => void; onClose: () => void }) {
  const [items, setItems] = useState<{ query: string; list: DiskItemDto[]; next: number | null } | null>(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const current = path[path.length - 1];
  const query = endpoint === '/openlines/disk' && search.trim() ? `${current.query}${current.query ? '&' : '?'}q=${encodeURIComponent(search.trim())}` : current.query;

  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      void apiGet<DiskBrowseDto | DiskItemDto[]>(`${endpoint}${query}`).then(
      (result) => {
        if (!active) return;
        setItems({ query, list: Array.isArray(result) ? result : result.items, next: Array.isArray(result) ? null : result.nextOffset });
        setError('');
      },
      (e) => active && setError(e instanceof Error ? e.message : 'Диск недоступен'),
      );
    }, query.includes('q=') ? 250 : 0);
    return () => {
      clearTimeout(timer);
      active = false;
    };
  }, [query, endpoint]);

  const list = items?.query === query ? items.list : null;
  const open = (x: DiskItemDto) => {
    if (x.kind === 'file') return onPick({ id: x.id, name: x.name });
    setSearch('');
    setPath([...path, { label: x.name, query: x.kind === 'storage' ? `?storageId=${x.id}` : `?folderId=${x.id}` }]);
  };

  const more = async () => {
    if (!items || items.query !== query || items.next === null || busy) return;
    setBusy(true); setError('');
    try {
      const page = await apiGet<DiskBrowseDto>(`${endpoint}${query}${query ? '&' : '?'}offset=${items.next}`);
      setItems((prev) => prev?.query === query ? { query, list: [...prev.list, ...page.items], next: page.nextOffset } : prev);
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось загрузить файлы'); }
    finally { setBusy(false); }
  };


  const disk = start?.shared && path[0].query === start.shared[0].query ? 'shared' : start?.user && path[0].query === start.user[0].query ? 'user' : null;
  const switchTo = (p: Place[] | null) => {
    if (!p) return;
    setSearch('');
    setPath(p);
  };
  return (
    <Frame onClose={onClose}>
        {start && (start.shared || start.user) && (
          <div className="disk-places" role="group" aria-label="Диск">
            <button type="button" className={disk === 'shared' ? 'active' : ''} aria-pressed={disk === 'shared'} disabled={!start.shared} title={start.shared ? start.shared.map((p) => p.label).join(' / ') : 'Общий диск недоступен'} onClick={() => switchTo(start.shared)}>
              Общий диск
            </button>
            <button type="button" className={disk === 'user' ? 'active' : ''} aria-pressed={disk === 'user'} disabled={!start.user} onClick={() => switchTo(start.user)}>
              Мой диск
            </button>
          </div>
        )}
        <nav className="disk-path" aria-label="Путь">
          {path.map((p, i) => (
            <button key={i} className="link" disabled={i === path.length - 1} onClick={() => { setSearch(''); setPath(path.slice(0, i + 1)); }}>
              {p.label}
            </button>
          ))}
        </nav>
        {endpoint === '/openlines/disk' && <label className="disk-search">Поиск по названию в текущей папке<input value={search} maxLength={100} onChange={(e) => setSearch(e.target.value)} placeholder="Название файла или хранилища" /></label>}
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
              <button type="button" onClick={() => open(x)}>
                <span aria-hidden="true">{x.kind === 'file' ? '📄' : x.kind === 'folder' ? '📁' : '🗄'}</span> {x.name}
                {x.kind === 'file' && x.size !== null && <span className="muted"> · {fileSize(x.size)}</span>}
              </button>
            </li>
          ))}
        </ul>
        {items?.query === query && items.next !== null && <button type="button" disabled={busy} onClick={() => void more()}>{busy ? 'Загрузка…' : 'Показать ещё'}</button>}
    </Frame>
  );
}
