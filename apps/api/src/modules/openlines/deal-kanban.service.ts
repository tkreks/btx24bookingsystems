import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { MAX_KANBAN_DEALS, type DealKanbanDto, type KanbanDealDto, type KanbanFunnelDto, type KanbanStageDto } from '@btx24/shared';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { CrmMirrorReader } from '../crm-mirror/crm-mirror.reader.js';
import type { CrmRow } from '../crm-mirror/crm-rows.js';

/** Стадии и воронки меняются редко — кэш на портал. */
const DIRECTORY_TTL_MS = 10 * 60_000;
const DEAL_SELECT = ['ID', 'TITLE', 'CATEGORY_ID', 'STAGE_ID', 'CONTACT_ID', 'ASSIGNED_BY_ID', 'DATE_CREATE', 'OPPORTUNITY', 'CURRENCY_ID'];

type StageRow = { STATUS_ID: string; NAME: string; SORT?: string; COLOR?: string | null; SEMANTICS?: string | null; EXTRA?: { SEMANTICS?: string; COLOR?: string } };

/**
 * Канбан сделок по числу показателя (ADR 0013 — сделки из копии CRM с проверкой прав сотрудника;
 * нет в копии — у портала его токеном). Колонки — стадии воронки по порядку (`crm.status.list`, SORT),
 * только просмотр.
 */
@Injectable()
export class DealKanbanService {
  private readonly stages = new Map<string, { at: number; value: Promise<KanbanStageDto[]> }>();
  private readonly funnelNames = new Map<string, { at: number; value: Promise<Map<number, string>> }>();

  constructor(@Optional() private readonly mirror?: CrmMirrorReader) {}

  async kanban(user: B24UserContext, idsParam: unknown): Promise<DealKanbanDto> {
    const ids = [...new Set(String(idsParam ?? '').split(',').map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))];
    if (ids.length > MAX_KANBAN_DEALS) throw new BadRequestException({ code: 'TOO_MANY_DEALS', message: `Не больше ${MAX_KANBAN_DEALS} сделок` });
    if (!ids.length) return { funnels: [], deals: [], hidden: 0 };
    const rows = await this.rows(user, ids);
    const contactIds = rows.map((r) => Number(r.CONTACT_ID)).filter((n) => n > 0);
    const assignedIds = rows.map((r) => Number(r.ASSIGNED_BY_ID)).filter((n) => n > 0);
    const [contacts, employees, names] = await Promise.all([this.contacts(user, contactIds), this.employees(user, assignedIds), this.cached(this.funnelNames, user.portal.id, () => this.loadFunnelNames(user))]);
    const deals: KanbanDealDto[] = rows.map((r) => {
      const contactId = Number(r.CONTACT_ID) || 0;
      const assignedId = Number(r.ASSIGNED_BY_ID) || 0;
      const sum = Number(r.OPPORTUNITY);
      return {
        id: Number(r.ID),
        title: String(r.TITLE ?? '') || `Сделка #${r.ID}`,
        categoryId: Number(r.CATEGORY_ID) || 0,
        stageId: String(r.STAGE_ID ?? ''),
        opportunity: Number.isFinite(sum) && r.OPPORTUNITY !== null && r.OPPORTUNITY !== '' ? sum : null,
        currency: r.CURRENCY_ID ? String(r.CURRENCY_ID) : null,
        createdAt: r.DATE_CREATE ? new Date(String(r.DATE_CREATE)).toISOString() : null,
        contact: contactId ? { id: contactId, name: contacts.get(contactId) ?? null } : null,
        assigned: assignedId ? { id: assignedId, name: employees.get(assignedId)?.name ?? null, photo: employees.get(assignedId)?.photo ?? null } : null,
      };
    });
    const categories = [...new Set(deals.map((d) => d.categoryId))].sort((a, b) => a - b);
    const funnels: KanbanFunnelDto[] = await Promise.all(
      categories.map(async (id) => ({ id, name: names.get(id) ?? (id === 0 ? 'Общая' : `Воронка ${id}`), stages: await this.cached(this.stages, `${user.portal.id}:${id}`, () => this.loadStages(user, id)) })),
    );
    return { funnels, deals, hidden: ids.length - deals.length };
  }

  /** Видимые сотруднику сделки: из копии, недостающие — у портала его токеном. */
  private async rows(user: B24UserContext, ids: number[]): Promise<CrmRow[]> {
    let rows: CrmRow[] = [];
    let missing = ids;
    if (this.mirror && (await this.mirror.ready(user.portal.id, 'deal'))) ({ rows, missing } = await this.mirror.dealsByIds(user, ids));
    for (let i = 0; i < missing.length; i += 50)
      rows.push(...(await user.client.listAll<CrmRow>('crm.deal.list', { filter: { '@ID': missing.slice(i, i + 50) }, select: DEAL_SELECT })));
    return rows;
  }

  private async contacts(user: B24UserContext, ids: number[]): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    let missing = [...new Set(ids)];
    if (this.mirror && missing.length) {
      const r = await this.mirror.contacts(user, missing);
      for (const [id, c] of r.found) out.set(id, c.name);
      missing = r.missing;
    }
    for (let i = 0; i < missing.length; i += 50)
      for (const c of await user.client.listAll<{ ID: string; NAME?: string; LAST_NAME?: string }>('crm.contact.list', { filter: { '@ID': missing.slice(i, i + 50) }, select: ['ID', 'NAME', 'LAST_NAME'] }))
        out.set(Number(c.ID), [c.NAME, c.LAST_NAME].filter(Boolean).join(' ').trim() || `Контакт #${c.ID}`);
    return out;
  }

  private async employees(user: B24UserContext, ids: number[]): Promise<Map<number, { name: string; photo: string | null }>> {
    if (this.mirror && ids.length) return this.mirror.employees(user.portal.id, ids);
    return new Map();
  }

  private cached<T>(map: Map<string, { at: number; value: Promise<T> }>, key: string, load: () => Promise<T>): Promise<T> {
    const hit = map.get(key);
    if (hit && Date.now() - hit.at < DIRECTORY_TTL_MS) return hit.value;
    const value = load();
    map.set(key, { at: Date.now(), value });
    value.catch(() => map.delete(key));
    return value;
  }

  private async loadFunnelNames(user: B24UserContext): Promise<Map<number, string>> {
    const res = await user.client.call<{ categories?: { id: number; name: string }[] }>('crm.category.list', { entityTypeId: 2 });
    return new Map((res.result?.categories ?? []).map((c) => [Number(c.id), c.name]));
  }

  private async loadStages(user: B24UserContext, categoryId: number): Promise<KanbanStageDto[]> {
    const rows = await user.client.listAll<StageRow>('crm.status.list', { filter: { ENTITY_ID: categoryId === 0 ? 'DEAL_STAGE' : `DEAL_STAGE_${categoryId}` }, order: { SORT: 'ASC' } });
    return rows
      .sort((a, b) => Number(a.SORT ?? 0) - Number(b.SORT ?? 0))
      .map((r) => ({ id: r.STATUS_ID, name: r.NAME, color: r.EXTRA?.COLOR || r.COLOR || null, semantics: semanticsOf(r) }));
  }
}

function semanticsOf(r: StageRow): KanbanStageDto['semantics'] {
  const s = String(r.EXTRA?.SEMANTICS ?? r.SEMANTICS ?? '').toLowerCase();
  if (s === 'success' || s === 's') return 'success';
  if (s === 'failure' || s === 'f') return 'failure';
  return 'process';
}
