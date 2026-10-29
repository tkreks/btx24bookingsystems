import { useEffect, useState } from 'react';
import { CRM_FIELD_TYPES, systemFieldCompatible, type SystemFieldsDto } from '@btx24/shared';
import { apiGet, apiPost, apiPut } from '../api.js';
import { SearchSelect } from './SearchSelect.js';
const typeLabel = (type: string, multiple: boolean) => `${CRM_FIELD_TYPES[type] ?? type}${multiple ? ' · несколько' : ''}`;
const errorText = (e: unknown) => e instanceof Error ? e.message : 'Не удалось выполнить действие';
export function FieldsSection({ onDirty, onBusy, onChanged, readOnly = false, users = [] }: {
  onDirty: (value: boolean) => void; onBusy: (value: boolean) => void; onChanged: () => void; readOnly?: boolean; users?: { id: number; name: string }[];
}) {
  const [data, setData] = useState<SystemFieldsDto | null>(null);
  const [draft, setDraft] = useState<SystemFieldsDto['mappings']>({ deal: {}, contact: {} });
  const [systemIds, setSystemIds] = useState<number[]>([]);
  const [mapping, setMapping] = useState(false); const [catalog, setCatalog] = useState(false);
  const [query, setQuery] = useState(''); const [entity, setEntity] = useState('all');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [note, setNote] = useState('');
  const apply = (value: SystemFieldsDto) => { setData(value); setDraft(value.mappings); setSystemIds(value.systemUserIds ?? []); };
  useEffect(() => { let active = true; apiGet<SystemFieldsDto>('/admin/fields').then(v => { if (active) { setData(v); setDraft(v.mappings); setSystemIds(v.systemUserIds ?? []); } }, e => { if (active) setError(errorText(e)); }); return () => { active = false; }; }, []);
  const changed = (next: typeof draft, ids = systemIds) => { setDraft(next); onDirty(JSON.stringify(next) !== JSON.stringify(data?.mappings) || JSON.stringify(ids) !== JSON.stringify(data?.systemUserIds ?? [])); setNote(''); };
  const dirty = !!data && (JSON.stringify(draft) !== JSON.stringify(data.mappings) || JSON.stringify(systemIds) !== JSON.stringify(data.systemUserIds ?? []));
  const run = async (operation: () => Promise<SystemFieldsDto>, message: string) => {
    setBusy(true); onBusy(true); setError(''); setNote('');
    try { apply(await operation()); onDirty(false); onChanged(); setNote(message); } catch (e) { setError(errorText(e)); } finally { setBusy(false); onBusy(false); }
  };
  const needle = query.trim().toLocaleLowerCase('ru');
  const definitions = (data?.definitions ?? []).filter(f => {
    const code = (draft[f.entity] as Record<string, string>)[f.key] ?? (data?.resolved[f.entity] as Record<string, string>)?.[f.key];
    const field = data?.fields[f.entity].find(c => c.code === code);
    return (entity === 'all' || f.entity === entity) && `${f.label} ${f.group} ${code ?? ''} ${field?.label ?? ''}`.toLocaleLowerCase('ru').includes(needle);
  });
  const catalogRows = (['deal','contact'] as const).flatMap(e => (data?.fields[e] ?? []).map(field => ({ ...field, entity: e }))).filter(f => (entity === 'all' || f.entity === entity) && `${f.label} ${f.code} ${typeLabel(f.type,f.multiple)}`.toLocaleLowerCase('ru').includes(needle));
  return <section className="settings-card fields-section compact-fields">
    <div className="fields-heading"><div><h3>Поля</h3><p className="muted">Сопоставление связывает поля. Значения и типы в Битрикс24 не меняются.</p></div><button type="button" disabled={busy} aria-pressed={mapping} onClick={() => { setMapping(!mapping); setCatalog(false); }}>{mapping ? 'Завершить сопоставление' : 'Сопоставления'}</button></div>
    {error && <div className="notice error" role="alert">{error}</div>}{note && <div className="notice" role="status">{note}</div>}
    {!data && !error && <p>Загрузка…</p>}
    {data && <>
      <div className="fields-tools"><div className="fields-switch"><button type="button" className={!catalog ? 'active' : ''} onClick={() => setCatalog(false)}>Поля приложения ({data.definitions.length})</button><button type="button" className={catalog ? 'active' : ''} onClick={() => setCatalog(true)}>Все поля Битрикс24 ({data.fields.deal.length + data.fields.contact.length})</button></div>
        <input type="search" aria-label="Поиск по полям" placeholder="Найти поле по названию или коду" value={query} onChange={e => setQuery(e.target.value)} />
        <select aria-label="Сущность полей" value={entity} onChange={e => setEntity(e.target.value)}><option value="all">Все сущности</option><option value="deal">Сделка</option><option value="contact">Контакт</option></select>
      </div>
      {catalog ? <><p className="muted">Найдено: {catalogRows.length}. Здесь все доступные поля портала, включая стандартные и несовместимые с ролями приложения.</p><div className="fields-table catalog-fields">{catalogRows.map(f => <div className="compact-field-row" key={`${f.entity}:${f.code}`}><div><strong>{f.label}</strong><small>{f.code}</small></div><span>{f.entity === 'deal' ? 'Сделка' : 'Контакт'}</span><span className="muted">{typeLabel(f.type,f.multiple)}{f.readOnly ? ' · чтение' : ''}</span></div>)}</div></> : <>
        <div className="fields-count muted">Показано {definitions.length} из {data.definitions.length} · Контакты: только чтение</div>
        {[...new Set(definitions.map(f => f.group))].map(group => <details className="fields-group" key={group} open><summary>{group}<span>{definitions.filter(f => f.group === group).length}</span></summary><div className="fields-table">
          {definitions.filter(f => f.group === group).map(system => {
            const explicit: Record<string,string|undefined> = draft[system.entity]; const saved: Record<string,string|undefined> = data.mappings[system.entity]; const resolved: Record<string,string|undefined> = data.resolved[system.entity];
            const code = explicit[system.key] ?? resolved[system.key] ?? '';
            const field = data.fields[system.entity].find(f => f.code === code);
            const edited = explicit[system.key] !== saved[system.key];
            const status = edited ? 'Не сохранено' : saved[system.key] ? 'Сопоставлено' : field ? 'Найдено' : 'Нет поля';
            const options = data.fields[system.entity].map(f => { const compatible = systemFieldCompatible(system,f); return { value:f.code,label:f.label,detail:`${f.code} · ${typeLabel(f.type,f.multiple)}${compatible ? '' : f.readOnly ? ' · только чтение' : !f.code.startsWith('UF_CRM_') ? ' · стандартное поле' : ' · несовместимый тип/кратность'}`,disabled:!compatible }; });
            return <div className="compact-field-row" key={system.key}><div className="field-role"><strong>{system.label}</strong><small>{system.types.map(t => CRM_FIELD_TYPES[t] ?? t).join(' / ')}{system.multiple ? ' · несколько' : ''}</small></div>
              <div className="field-binding">{mapping ? <SearchSelect label={`Сопоставление: ${system.label}`} value={code} canClear={!!explicit[system.key]} options={options} disabled={busy || readOnly} onChange={value => { const next={...draft,[system.entity]:{...draft[system.entity]}}; const values:Record<string,string>=next[system.entity]; if(value)values[system.key]=value;else delete values[system.key]; changed(next); }} /> : <><span>{field?.label ?? (code ? 'Недоступное поле' : 'Не сопоставлено')}</span>{code && <small>{code}</small>}</>}
                {field && !systemFieldCompatible(system,field) && <small className="field-warning">Прежняя связь · несовместимый тип</small>}
              </div><div className="field-state"><span className={`field-state-badge ${field ? 'linked' : 'missing'}`}>{status}</span>{mapping && !field && !code && <button type="button" className="link" aria-label={`Создать поле: ${system.label}`} disabled={busy || readOnly || dirty} onClick={() => void run(() => apiPost<SystemFieldsDto>(`/admin/fields/${system.entity}/${system.key}/create`,{}),'Поле создано или найдено и сопоставлено. Карточки не изменены.')}>Создать поле</button>}</div>
            </div>;
          })}
        </div></details>)}
        {!definitions.length && <p className="muted">Поля не найдены. Измените запрос.</p>}
        {mapping && <div className="fields-savebar"><button type="button" disabled={busy || readOnly} onClick={() => changed({deal:{...data.resolved.deal,...draft.deal},contact:{...data.resolved.contact,...draft.contact}})}>Применить найденные</button><button type="button" className="primary" disabled={busy || readOnly || !dirty} onClick={() => void run(() => apiPut<SystemFieldsDto>('/admin/fields',{...draft,systemUserIds:systemIds}),'Сопоставления сохранены. Значения карточек не менялись.')}>Сохранить</button><button type="button" disabled={busy || !dirty} onClick={() => { apply(data);onDirty(false);setNote(''); }}>Отменить</button></div>}
      </>}
      <details className="fields-automation"><summary>Системные учётные записи</summary><p className="muted">Отмечайте аккаунты рассылок и автоматизаций. Имя аккаунта не доказывает, какая программа или человек запустили действие.</p><SearchSelect label="Добавить системную учётную запись" value="" options={users.filter(u => !systemIds.includes(u.id)).map(u => ({value:String(u.id),label:u.name,detail:`Учётная запись #${u.id}`}))} disabled={busy || readOnly} placeholder="Найти сотрудника…" onChange={v => {const ids=[...systemIds,Number(v)];setSystemIds(ids);changed(draft,ids);setMapping(true);setCatalog(false);}} />
        <div className="system-user-tags">{systemIds.map(id => <span key={id}>{users.find(u=>u.id===id)?.name ?? `#${id}`}<button type="button" disabled={busy || readOnly} aria-label={`Убрать системную учётную запись ${id}`} onClick={()=>{const ids=systemIds.filter(i=>i!==id);setSystemIds(ids);changed(draft,ids);setMapping(true);setCatalog(false);}}>×</button></span>)}</div>
      </details>
    </>}
  </section>;
}
