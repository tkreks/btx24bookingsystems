import type { CSSProperties } from 'react';

/** Пункт легенды: подпись и образец цвета (те же цвета, что у обозначаемых элементов). */
export interface LegendItem {
  label: string;
  swatch: CSSProperties;
  title?: string;
}

/** Легенда цветов рядом с заголовком блока: что значит каждый цвет. */
export function ColorLegend({ items, label = 'Обозначения цветов', className = '' }: { items: LegendItem[]; label?: string; className?: string }) {
  return (
    <span className={`color-legend${className ? ` ${className}` : ''}`} role="list" aria-label={label}>
      {items.map((i) => (
        <span key={i.label} className="color-legend-item" role="listitem" title={i.title}>
          <i aria-hidden="true" style={i.swatch} />
          {i.label}
        </span>
      ))}
    </span>
  );
}
