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

/** Дерево разделов с флажками; раздел раскрывается кликом по названию. */
export function CatalogSections({
  sections,
  selected,
  onChange,
}: {
  sections: Sections;
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const known = new Set(sections.map((s) => s.id));
  const children = (parent: string | null) =>
    sections.filter((s) => (s.parentId && known.has(s.parentId) ? s.parentId : null) === parent);
  const toggle = (id: string, on: boolean) =>
    onChange(on ? [...new Set([...selected, id])] : selected.filter((x) => x !== id));
  const box = (id: string, name: string) => (
    <label className="check">
      <input type="checkbox" checked={selected.includes(id)} onChange={(e) => toggle(id, e.target.checked)} />
      {name} <span className="muted">#{id}</span>
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
          </summary>
          <ul>{kids.map(node)}</ul>
        </details>
      </li>
    );
  };
  return (
    <div className="catalog-tree">
      <p className="muted">Отметьте разделы, доступные в этой группе. Ничего не отмечено — доступны все.</p>
      <ul>
        <li>{box(ROOT_SECTION, 'Без категории')}</li>
        {children(null).map(node)}
      </ul>
      {!sections.length && <p className="notice">Разделы каталога не найдены — останутся доступны все.</p>}
    </div>
  );
}
