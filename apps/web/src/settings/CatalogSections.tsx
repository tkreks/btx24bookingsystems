import type { CatalogDto } from '@btx24/shared';

type Sections = CatalogDto['sections'];
/** «root» — товары без раздела (так в прототипе). */
export const ROOT_SECTION = 'root';

export function sectionSummary(ids: string[], sections: Sections): string {
  if (!ids.length) return 'Все разделы каталога';
  const names = ids
    .slice(0, 4)
    .map((id) => (id === ROOT_SECTION ? 'Без категории' : (sections.find((s) => s.id === id)?.name ?? `#${id}`)));
  return ids.length > 4 ? `${names.join(', ')}, +${ids.length - 4}` : names.join(', ');
}

/**
 * Дерево разделов с флажками; раздел раскрывается кликом по названию. У выбранного раздела — 👁:
 * открыт — раздел быстрым тегом в мастере брони, закрыт — тега нет (товары раздела доступны поиском).
 */
export function CatalogSections({
  sections,
  selected,
  onChange,
  hidden = [],
  onHidden,
}: {
  sections: Sections;
  selected: string[];
  onChange: (ids: string[]) => void;
  hidden?: string[];
  onHidden?: (ids: string[]) => void;
}) {
  const eye = (id: string, name: string) =>
    onHidden && selected.includes(id) && id !== ROOT_SECTION ? (
      <button
        type="button"
        className={`eye-toggle${hidden.includes(id) ? ' off' : ''}`}
        aria-pressed={!hidden.includes(id)}
        title={hidden.includes(id) ? 'Скрыт из быстрых тегов мастера — показать' : 'Виден тегом в мастере брони — скрыть'}
        aria-label={`${hidden.includes(id) ? 'Показать' : 'Скрыть'} раздел «${name}» в быстрых тегах`}
        onClick={(e) => {
          e.preventDefault();
          onHidden(hidden.includes(id) ? hidden.filter((x) => x !== id) : [...hidden, id]);
        }}
      >
        {hidden.includes(id) ? '🙈' : '👁'}
      </button>
    ) : null;
  const known = new Set(sections.map((s) => s.id));
  const children = (parent: string | null) =>
    sections.filter((s) => (s.parentId && known.has(s.parentId) ? s.parentId : null) === parent);
  const toggle = (id: string, on: boolean) =>
    onChange(on ? [...new Set([...selected, id])] : selected.filter((x) => x !== id));
  const box = (id: string, name: string) => (
    <label className="check">
      <input type="checkbox" checked={selected.includes(id)} onChange={(e) => toggle(id, e.target.checked)} />
      {name} <span className="muted">#{id}</span>
      {eye(id, name)}
    </label>
  );
  const node = (s: Sections[number]) => {
    const kids = children(s.id);
    if (!kids.length) return <li key={s.id}>{box(s.id, s.name)}</li>;
    return (
      <li key={s.id}>
        <details open>
          <summary>
            <input
              type="checkbox"
              aria-label={s.name}
              checked={selected.includes(s.id)}
              onChange={(e) => toggle(s.id, e.target.checked)}
            />{' '}
            {s.name} <span className="muted">#{s.id}</span>
            {eye(s.id, s.name)}
          </summary>
          <ul>{kids.map(node)}</ul>
        </details>
      </li>
    );
  };
  return (
    <div className="catalog-tree">
      <p className="muted">
        Отметьте разделы, доступные в этой группе. Ничего не отмечено — доступны все. 👁 у отмеченного раздела — быстрый тег в мастере
        брони (открывает товары раздела); 🙈 — тега нет.
      </p>
      <ul>
        <li>{box(ROOT_SECTION, 'Без категории')}</li>
        {children(null).map(node)}
      </ul>
      {!sections.length && <p className="notice">Разделы каталога не найдены — останутся доступны все.</p>}
    </div>
  );
}
