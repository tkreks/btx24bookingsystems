import { useId, useRef, useState } from 'react';
export interface SearchOption { value: string; label: string; detail?: string; disabled?: boolean }
export function SearchSelect({ label, value, options, onChange, disabled = false, canClear = true, placeholder = 'Название или код поля…' }: {
  label: string; value: string; options: SearchOption[]; onChange: (value: string) => void; disabled?: boolean; canClear?: boolean; placeholder?: string;
}) {
  const id = useId(); const input = useRef<HTMLInputElement>(null);
  const selected = options.find(o => o.value === value);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false); const [active, setActive] = useState(-1);
  const needle = query.trim().toLocaleLowerCase('ru');
  const matches = options.filter(o => `${o.label} ${o.value} ${o.detail ?? ''}`.toLocaleLowerCase('ru').includes(needle)).sort((a,b) => Number(a.disabled) - Number(b.disabled));
  const shown = matches.slice(0, 8);
  const choose = (option: SearchOption) => { if (option.disabled) return; onChange(option.value); setOpen(false); setActive(-1); };
  return <div className="search-select" onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) { setOpen(false); setActive(-1); } }}>
    <div className="search-select-input"><input ref={input} role="combobox" aria-label={label} aria-expanded={open} aria-controls={id} aria-autocomplete="list" aria-activedescendant={open && active >= 0 ? `${id}-${active}` : undefined}
      disabled={disabled} placeholder={placeholder} value={open ? query : selected?.label ?? value} onFocus={() => { setQuery(''); setOpen(true); setActive(-1); }}
      onChange={e => { setQuery(e.target.value); setOpen(true); setActive(-1); }} onKeyDown={e => {
        if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setOpen(true); setActive(i => Math.max(0, Math.min(shown.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))); }
        if (e.key === 'Enter') { e.preventDefault(); const option = shown[active >= 0 ? active : 0]; if (open && option) choose(option); }
      }} />
      {value && canClear && !disabled && <button type="button" className="search-select-clear" title="Вернуть автоматический выбор после сохранения" aria-label={`Сбросить явное сопоставление: ${label}`} onClick={() => { onChange(''); setQuery(''); setOpen(false); }}>×</button>}
    </div>
    {open && !disabled && <div className="search-select-menu" role="listbox" id={id} aria-label={label}>
      {shown.map((option, index) => <button type="button" role="option" id={`${id}-${index}`} aria-selected={option.value === value} aria-disabled={option.disabled || undefined} key={option.value} className={`${index === active ? 'focused' : ''} ${option.disabled ? 'incompatible' : ''}`} onMouseDown={e => e.preventDefault()} onClick={() => choose(option)}>
        <span>{option.label}</span><small>{option.detail ?? option.value}</small>
      </button>)}
      {!shown.length && <div className="search-select-empty">Ничего не найдено</div>}
      {matches.length > 8 && <div className="search-select-empty">Показано 8 из {matches.length}. Уточните запрос.</div>}
    </div>}
  </div>;
}
