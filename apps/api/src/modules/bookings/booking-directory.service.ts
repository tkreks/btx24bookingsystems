import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type { BookingCatalogDto, CrmContactHit, CrmDealHit, CrmSearchDto, DealProductRowDto, GroupOptionsDto } from '@btx24/shared';
import { AccessService } from '../access/access.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { phoneVariants } from '../openlines/chats.service.js';

const CATALOG_TTL_MS = 10 * 60_000;
const HITS = 20;

type Section = { ID: string; NAME: string; SECTION_ID?: string | null };
type Product = { ID: string; NAME: string; PRICE?: string | null; CURRENCY_ID?: string | null; SECTION_ID?: string | null };
type Contact = { ID: string; NAME?: string | null; LAST_NAME?: string | null; SECOND_NAME?: string | null; PHONE?: { VALUE?: string }[]; EMAIL?: { VALUE?: string }[] };
type Deal = { ID: string; TITLE?: string | null; CATEGORY_ID?: string | null; CLOSED?: string | null; OPPORTUNITY?: string | null; CURRENCY_ID?: string | null; CONTACT_ID?: string | null; DATE_CREATE?: string | null; LAST_ACTIVITY_TIME?: string | null };

const CONTACT_SELECT = ['ID', 'NAME', 'LAST_NAME', 'SECOND_NAME', 'PHONE', 'EMAIL'];
const DEAL_SELECT = ['ID', 'TITLE', 'CATEGORY_ID', 'CLOSED', 'OPPORTUNITY', 'CURRENCY_ID', 'CONTACT_ID', 'DATE_CREATE', 'LAST_ACTIVITY_TIME'];

export const fullName = (c: Pick<Contact, 'NAME' | 'LAST_NAME' | 'SECOND_NAME'>) =>
  [c.LAST_NAME, c.NAME, c.SECOND_NAME].filter((x) => x && String(x).trim()).join(' ').trim();

/** Разделы группы вместе с вложенными (как в прототипе: раздел включает подразделы). */
export function sectionsWithChildren(selected: string[], sections: { id: string; parentId: string | null }[]): Set<string> {
  const out = new Set(selected);
  for (let grew = true; grew; ) {
    grew = false;
    for (const s of sections)
      if (s.parentId && out.has(s.parentId) && !out.has(s.id)) {
        out.add(s.id);
        grew = true;
      }
  }
  return out;
}

/**
 * Справочники формы брони: товары группы, товары сделки, поиск клиента и сделки. Всё — токеном
 * сотрудника (его права в CRM); пускаем тех, кто может создавать брони.
 */
@Injectable()
export class BookingDirectoryService {
  /** portalId → разделы и товары каталога (меняются редко). */
  private readonly catalogCache = new Map<string, { sections: Section[]; products: Product[]; expiresAt: number }>();

  constructor(private readonly access: AccessService) {}

  private async canCreate(user: B24UserContext, groupId?: string) {
    const a = await this.access.resolve(user);
    const g = this.access.pick(a, groupId, 'booking.create');
    if (!g) throw new ForbiddenException({ code: 'NO_BOOKING_CREATE', message: 'Нет права создавать брони' });
    return g;
  }

  async catalog(user: B24UserContext, groupId: string): Promise<BookingCatalogDto> {
    const g = await this.canCreate(user, groupId);
    const options = (g.group.options ?? null) as GroupOptionsDto | null;
    let cached = this.catalogCache.get(user.portal.id);
    if (!cached || cached.expiresAt < Date.now()) {
      const [sections, products] = await Promise.all([
        user.client.listAll<Section>('crm.productsection.list', { select: ['ID', 'NAME', 'SECTION_ID'] }),
        user.client.listAll<Product>('crm.product.list', { select: ['ID', 'NAME', 'PRICE', 'CURRENCY_ID', 'SECTION_ID'], filter: { ACTIVE: 'Y' }, order: { NAME: 'ASC' } }),
      ]);
      cached = { sections, products, expiresAt: Date.now() + CATALOG_TTL_MS };
      this.catalogCache.set(user.portal.id, cached);
    }
    const chosen = options?.productSectionIds ?? [];
    const allowed = chosen.length
      ? sectionsWithChildren(chosen, cached.sections.map((s) => ({ id: String(s.ID), parentId: s.SECTION_ID ? String(s.SECTION_ID) : null })))
      : null;
    const names = new Map(cached.sections.map((s) => [String(s.ID), s.NAME]));
    const tree = cached.sections.map((s) => ({ id: String(s.ID), parentId: s.SECTION_ID ? String(s.SECTION_ID) : null }));
    return {
      products: cached.products
        .filter((p) => !allowed || (p.SECTION_ID && allowed.has(String(p.SECTION_ID))))
        .map((p) => ({
          id: Number(p.ID),
          name: p.NAME,
          price: p.PRICE === null || p.PRICE === undefined || p.PRICE === '' ? null : Number(p.PRICE),
          currency: p.CURRENCY_ID ?? null,
          section: p.SECTION_ID ? (names.get(String(p.SECTION_ID)) ?? null) : null,
          sectionId: p.SECTION_ID ? String(p.SECTION_ID) : null,
        })),
      defaults: options?.resourceDefaults ?? {},
      restricted: !!allowed,
      // Быстрые теги — выбранные разделы, кроме скрытых (👁); «root» (без раздела) тегом не бывает.
      sections: chosen
        .filter((id) => id !== 'root' && names.has(id) && !(options?.productSectionsHidden ?? []).includes(id))
        .map((id) => ({ id, name: names.get(id)!, sectionIds: [...sectionsWithChildren([id], tree)] })),
    };
  }

  /** Товары сделки — чтобы форма показала их и не потеряла при полной замене строк. */
  async dealProducts(user: B24UserContext, dealId: number): Promise<DealProductRowDto[]> {
    await this.canCreate(user);
    type Row = { PRODUCT_ID?: string; PRODUCT_NAME?: string; PRICE?: string; QUANTITY?: string; DISCOUNT_TYPE_ID?: string; DISCOUNT_RATE?: string; DISCOUNT_SUM?: string };
    const rows = (await user.client.call<Row[]>('crm.deal.productrows.get', { id: dealId })).result ?? [];
    return rows
      .filter((r) => Number(r.PRODUCT_ID) > 0)
      .map((r) => {
        // В Битрикс24 PRICE — уже со скидкой; цена без скидки = PRICE + скидка на единицу.
        const final = Number(r.PRICE ?? 0);
        const perUnit = Number(r.DISCOUNT_SUM ?? 0);
        const percent = String(r.DISCOUNT_TYPE_ID) !== '1';
        return {
          productId: Number(r.PRODUCT_ID),
          name: r.PRODUCT_NAME ?? `Товар #${r.PRODUCT_ID}`,
          price: Math.round((final + perUnit) * 100) / 100,
          quantity: Number(r.QUANTITY ?? 1),
          discountType: percent ? ('percent' as const) : ('sum' as const),
          discount: percent ? Number(r.DISCOUNT_RATE ?? 0) : perUnit,
        };
      });
  }

  /**
   * 20 открытых сделок с последней активностью (`LAST_ACTIVITY_TIME`: чаты, звонки, дела) в воронках
   * групп, где сотрудник может создавать брони — первый шаг мастера брони.
   */
  async recentDeals(user: B24UserContext): Promise<CrmDealHit[]> {
    const a = await this.access.resolve(user);
    const groups = a.groups.filter((g) => g.permissions.includes('booking.create'));
    if (!groups.length) throw new ForbiddenException({ code: 'NO_BOOKING_CREATE', message: 'Нет права создавать брони' });
    const funnels = [...new Set(groups.map((g) => g.group.dealCategoryId).filter((x): x is number => x !== null))];
    const res = await user.client.call<Deal[]>('crm.deal.list', {
      filter: { CLOSED: 'N', ...(funnels.length ? { '@CATEGORY_ID': funnels } : {}) },
      order: { LAST_ACTIVITY_TIME: 'DESC' },
      select: DEAL_SELECT,
    });
    const hits = await this.toHits(user, (res.result ?? []).slice(0, HITS));
    // toHits сортирует по номеру — здесь важен порядок активности.
    return hits.sort((x, y) => Date.parse(y.lastActivityAt ?? '0') - Date.parse(x.lastActivityAt ?? '0'));
  }

  /**
   * Поиск от 2 символов. Контакт: ID (число), телефон (от 10 цифр), e-mail («@»), иначе ФИО.
   * Сделка: ID, название; плюс сделки контактов, найденных по имени. Открытые сделки — первыми.
   */
  async search(user: B24UserContext, query: { kind?: unknown; q?: unknown; contactId?: unknown }): Promise<CrmSearchDto> {
    await this.canCreate(user);
    const contactId = Number(query.contactId);
    if (Number.isSafeInteger(contactId) && contactId > 0) return { contacts: [], deals: await this.dealsOf(user, [contactId]) };
    const q = typeof query.q === 'string' ? query.q.trim() : '';
    if (q.length < 2) throw new BadRequestException({ code: 'SHORT_QUERY', message: 'Введите хотя бы 2 символа' });
    if (query.kind === 'deal') return { contacts: [], deals: await this.findDeals(user, q) };
    return { contacts: await this.findContacts(user, q), deals: [] };
  }

  private async findContacts(user: B24UserContext, q: string): Promise<CrmContactHit[]> {
    const list = (filter: Record<string, unknown>) => user.client.listAll<Contact>('crm.contact.list', { filter, select: CONTACT_SELECT, order: { ID: 'DESC' } }, { max: HITS * 2 });
    let rows: Contact[] = [];
    const phones = phoneVariants(q);
    if (/^\d{1,9}$/.test(q)) rows = await list({ ID: Number(q) });
    else if (phones.length || q.includes('@')) {
      const found = await user.client.call<{ CONTACT?: number[] }>('crm.duplicate.findbycomm', {
        entity_type: 'CONTACT',
        type: q.includes('@') ? 'EMAIL' : 'PHONE',
        values: q.includes('@') ? [q.toLowerCase()] : phones,
      });
      const ids = found.result?.CONTACT ?? [];
      rows = ids.length ? await list({ '@ID': ids.slice(0, HITS) }) : [];
    } else {
      // ФИО: ищем по первому слову в фамилии и имени, остальные слова — фильтром здесь.
      const words = q.toLocaleLowerCase('ru').split(/\s+/).filter(Boolean);
      const [byLast, byName] = await Promise.all([list({ '%LAST_NAME': words[0] }), list({ '%NAME': words[0] })]);
      rows = [...new Map([...byLast, ...byName].map((c) => [c.ID, c])).values()].filter((c) => {
        const n = fullName(c).toLocaleLowerCase('ru');
        return words.every((w) => n.includes(w));
      });
    }
    return rows.slice(0, HITS).map((c) => ({
      id: Number(c.ID),
      name: fullName(c) || `Контакт #${c.ID}`,
      phones: (c.PHONE ?? []).map((p) => p.VALUE ?? '').filter(Boolean),
      emails: (c.EMAIL ?? []).map((p) => p.VALUE ?? '').filter(Boolean),
    }));
  }

  private async findDeals(user: B24UserContext, q: string): Promise<CrmDealHit[]> {
    const list = (filter: Record<string, unknown>) => user.client.listAll<Deal>('crm.deal.list', { filter, select: DEAL_SELECT, order: { ID: 'DESC' } }, { max: HITS });
    const byId = /^\d{1,9}$/.test(q) ? await list({ ID: Number(q) }) : [];
    const [byTitle, contacts] = await Promise.all([list({ '%TITLE': q }), /^\d+$/.test(q) ? Promise.resolve([]) : this.findContacts(user, q)]);
    const byClient = contacts.length ? await this.rawDealsOf(user, contacts.map((c) => c.id)) : [];
    const rows = [...new Map([...byId, ...byTitle, ...byClient].map((d) => [d.ID, d])).values()];
    // Ввели номер сделки — она первой, остальные (номер в названии) — следом.
    const hits = await this.toHits(user, rows);
    return [...hits.filter((h) => String(h.id) === q), ...hits.filter((h) => String(h.id) !== q)];
  }

  private async rawDealsOf(user: B24UserContext, contactIds: number[]): Promise<Deal[]> {
    return user.client.listAll<Deal>('crm.deal.list', { filter: { '@CONTACT_ID': contactIds.slice(0, 50) }, select: DEAL_SELECT, order: { ID: 'DESC' } }, { max: 50 });
  }

  /** Сделки контакта — после выбора клиента: последняя открытая — первой. */
  private async dealsOf(user: B24UserContext, contactIds: number[]): Promise<CrmDealHit[]> {
    return this.toHits(user, await this.rawDealsOf(user, contactIds));
  }

  private async toHits(user: B24UserContext, rows: Deal[]): Promise<CrmDealHit[]> {
    const ids = [...new Set(rows.map((d) => Number(d.CONTACT_ID) || 0).filter((x) => x > 0))];
    const contacts = ids.length ? await user.client.listAll<Contact>('crm.contact.list', { filter: { '@ID': ids }, select: ['ID', 'NAME', 'LAST_NAME', 'SECOND_NAME'] }) : [];
    const names = new Map(contacts.map((c) => [Number(c.ID), fullName(c) || null]));
    return rows
      .map((d) => ({
        id: Number(d.ID),
        title: d.TITLE || `Сделка #${d.ID}`,
        categoryId: d.CATEGORY_ID === null || d.CATEGORY_ID === undefined ? null : Number(d.CATEGORY_ID),
        closed: d.CLOSED === 'Y',
        opportunity: d.OPPORTUNITY ? Number(d.OPPORTUNITY) : null,
        currency: d.CURRENCY_ID ?? null,
        contact: Number(d.CONTACT_ID) > 0 ? { id: Number(d.CONTACT_ID), name: names.get(Number(d.CONTACT_ID)) ?? null } : null,
        createdAt: d.DATE_CREATE ? new Date(d.DATE_CREATE).toISOString() : null,
        lastActivityAt: d.LAST_ACTIVITY_TIME ? new Date(d.LAST_ACTIVITY_TIME).toISOString() : null,
      }))
      .sort((a, b) => Number(a.closed) - Number(b.closed) || b.id - a.id)
      .slice(0, HITS);
  }
}
