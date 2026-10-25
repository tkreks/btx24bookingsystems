import { Injectable, NotFoundException } from '@nestjs/common';
import type { DealOverviewDto, DealTimelineItemDto, DealTimelineKind, NewDealResultDto } from '@btx24/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ActionLogService } from '../audit/action-log.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';

type Row = Record<string, unknown>;
/** Сколько последних записей каждого источника брать в таймлайн. */
const LIMIT = 50;
/** Служебные записи журнала — не действия по сделке. */
const SKIP_ACTIONS = ['request', 'app.enter', 'app.login', 'app.error', 'bitrix.error'];

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const num = (v: unknown): number | null => (Number(v) > 0 ? Number(v) : null);
const iso = (v: unknown): string | null => {
  const t = Date.parse(str(v));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
/** BB-коды и HTML комментариев Битрикс24 → обычный текст. */
export const plainText = (v: unknown): string =>
  str(v)
    .replace(/\[br\s*\/?\]|<br\s*\/?>/gi, '\n')
    .replace(/\[\/?[a-z*]+(?:=[^\]]*)?\]|<[^>]+>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** Дело CRM → вид записи таймлайна (TYPE_ID: 1 встреча, 2 звонок, 3 задача, 4 письмо; дальше — по провайдеру). */
export function activityKind(a: Row): DealTimelineKind {
  const provider = str(a.PROVIDER_ID);
  if (provider === 'IMOPENLINES_SESSION') return 'chat';
  if (provider === 'VOXIMPLANT_CALL' || str(a.TYPE_ID) === '2') return 'call';
  if (provider === 'TASKS_TASK' || provider === 'TASKS' || str(a.TYPE_ID) === '3') return 'task';
  if (provider === 'CRM_EMAIL' || str(a.TYPE_ID) === '4') return 'email';
  if (str(a.TYPE_ID) === '1') return 'meeting';
  return 'activity';
}

const ACTIVITY_TITLE: Record<DealTimelineKind, string> = {
  call: 'Звонок',
  chat: 'Чат открытой линии',
  task: 'Задача',
  email: 'Письмо',
  meeting: 'Встреча',
  activity: 'Дело',
  created: '',
  stage: '',
  comment: '',
  app: '',
};

/**
 * Встройка сделки: карточка и таймлайн действий (правами сотрудника в CRM), новая сделка с тем же
 * клиентом. Журнал приложения — записи по самой сделке и по её броням (`details.dealId`).
 */
@Injectable()
export class DealHubService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly actions: ActionLogService,
  ) {}

  async overview(user: B24UserContext, dealId: number): Promise<DealOverviewDto> {
    const deal = (await user.client.call<Row>('crm.deal.get', { id: dealId })).result;
    if (!deal?.ID) throw new NotFoundException({ code: 'DEAL_NOT_FOUND', message: `Сделка #${dealId} не найдена` });
    const categoryId = Number(deal.CATEGORY_ID ?? 0) || 0;
    const contactId = num(deal.CONTACT_ID);
    const res = await user.client.batch({
      stages: { method: 'crm.status.list', params: { filter: { ENTITY_ID: categoryId ? `DEAL_STAGE_${categoryId}` : 'DEAL_STAGE' } } },
      history: { method: 'crm.stagehistory.list', params: { entityTypeId: 2, order: { ID: 'DESC' }, filter: { OWNER_ID: dealId }, select: ['ID', 'TYPE_ID', 'STAGE_ID', 'CREATED_TIME'] } },
      activities: {
        method: 'crm.activity.list',
        params: {
          order: { ID: 'DESC' },
          filter: { OWNER_TYPE_ID: 2, OWNER_ID: dealId },
          select: ['ID', 'TYPE_ID', 'PROVIDER_ID', 'SUBJECT', 'DIRECTION', 'CREATED', 'RESPONSIBLE_ID', 'AUTHOR_ID', 'COMPLETED'],
        },
      },
      comments: { method: 'crm.timeline.comment.list', params: { order: { ID: 'DESC' }, filter: { ENTITY_ID: dealId, ENTITY_TYPE: 'deal' }, select: ['ID', 'CREATED', 'AUTHOR_ID', 'COMMENT'] } },
      ...(contactId ? { contact: { method: 'crm.contact.get', params: { id: contactId } } } : {}),
    });
    const list = (key: string): Row[] => {
      const r = res.result[key] as Row[] | { items?: Row[] } | undefined;
      return (Array.isArray(r) ? r : (r?.items ?? [])).slice(0, LIMIT);
    };
    const stages = new Map(list('stages').map((s) => [str(s.STATUS_ID), { name: str(s.NAME), semantics: str(s.SEMANTICS) }]));
    const stageName = (id: string) => stages.get(id)?.name || id;
    const app = await this.prisma.actionLog.findMany({
      where: {
        portalId: user.portal.id,
        action: { notIn: SKIP_ACTIONS },
        OR: [{ entityType: 'deal', entityId: String(dealId) }, { entityType: 'booking', details: { path: '$.dealId', equals: dealId } }],
      },
      orderBy: { at: 'desc' },
      take: LIMIT,
    });

    const activities = list('activities');
    const comments = list('comments');
    const userIds = [
      num(deal.ASSIGNED_BY_ID),
      ...activities.map((a) => num(a.RESPONSIBLE_ID) ?? num(a.AUTHOR_ID)),
      ...comments.map((c) => num(c.AUTHOR_ID)),
    ].filter((x): x is number => !!x);
    const names = await this.userNames(user, userIds);
    const actor = (id: number | null) => (id ? { id, name: names.get(id) ?? `Сотрудник #${id}` } : null);

    const timeline: DealTimelineItemDto[] = [];
    for (const h of list('history')) {
      const at = iso(h.CREATED_TIME);
      if (!at) continue;
      // TYPE_ID 1 — создание, 2 — смена стадии, 3 — смена воронки.
      const created = str(h.TYPE_ID) === '1';
      timeline.push({ id: `stage:${str(h.ID)}`, at, kind: created ? 'created' : 'stage', actor: null, title: created ? 'Сделка создана' : `Стадия: ${stageName(str(h.STAGE_ID))}`, text: created ? `Стадия: ${stageName(str(h.STAGE_ID))}` : null });
    }
    for (const a of activities) {
      const at = iso(a.CREATED);
      if (!at) continue;
      const kind = activityKind(a);
      const dir = str(a.DIRECTION);
      timeline.push({
        id: `activity:${str(a.ID)}`,
        at,
        kind,
        actor: actor(num(a.RESPONSIBLE_ID) ?? num(a.AUTHOR_ID)),
        title: ACTIVITY_TITLE[kind],
        text: plainText(a.SUBJECT) || null,
        direction: dir === '1' ? 'in' : dir === '2' ? 'out' : null,
      });
    }
    for (const c of comments) {
      const at = iso(c.CREATED);
      if (!at) continue;
      timeline.push({ id: `comment:${str(c.ID)}`, at, kind: 'comment', actor: actor(num(c.AUTHOR_ID)), title: 'Комментарий', text: plainText(c.COMMENT) || null });
    }
    for (const r of app) {
      timeline.push({
        id: `app:${r.id}`,
        at: r.at.toISOString(),
        kind: 'app',
        actor: r.actorKind === 'user' ? { id: r.userId, name: r.actorName ?? (r.userId ? `Сотрудник #${r.userId}` : 'Сотрудник') } : null,
        title: 'Приложение',
        text: r.summary,
      });
    }
    timeline.sort((a, b) => b.at.localeCompare(a.at));

    const stageId = str(deal.STAGE_ID);
    const sem = str(deal.STAGE_SEMANTIC_ID);
    const contact = res.result.contact as Row | undefined;
    const assignedId = num(deal.ASSIGNED_BY_ID);
    return {
      deal: {
        id: dealId,
        title: str(deal.TITLE) || `Сделка #${dealId}`,
        stage: stageId ? { id: stageId, name: stageName(stageId), semantics: sem === 'P' || sem === 'S' || sem === 'F' ? sem : null } : null,
        opportunity: deal.OPPORTUNITY === undefined || deal.OPPORTUNITY === null || deal.OPPORTUNITY === '' ? null : Number(deal.OPPORTUNITY),
        currency: str(deal.CURRENCY_ID) || null,
        assigned: assignedId ? { id: assignedId, name: names.get(assignedId) ?? `Сотрудник #${assignedId}` } : null,
        createdAt: iso(deal.DATE_CREATE),
      },
      contact: contactId
        ? {
            id: contactId,
            name: contact ? [contact.NAME, contact.SECOND_NAME, contact.LAST_NAME].map(str).filter(Boolean).join(' ') || null : null,
            phones: ((contact?.PHONE as { VALUE?: string }[] | undefined) ?? []).map((p) => str(p.VALUE)).filter(Boolean),
          }
        : null,
      timeline,
    };
  }

  /** Новая сделка с клиентом исходной (контакты, компания, воронка); ответственный — сотрудник. */
  async newDeal(user: B24UserContext, dealId: number): Promise<NewDealResultDto> {
    const deal = (await user.client.call<Row>('crm.deal.get', { id: dealId })).result;
    if (!deal?.ID) throw new NotFoundException({ code: 'DEAL_NOT_FOUND', message: `Сделка #${dealId} не найдена` });
    const items = (await user.client.call<{ CONTACT_ID?: string | number }[]>('crm.deal.contact.items.get', { id: dealId })).result ?? [];
    const contactIds = [...new Set([...items.map((c) => num(c.CONTACT_ID)), num(deal.CONTACT_ID)].filter((x): x is number => !!x))];
    const fields: Row = { CATEGORY_ID: Number(deal.CATEGORY_ID ?? 0) || 0, ASSIGNED_BY_ID: user.userId };
    if (contactIds.length) fields.CONTACT_IDS = contactIds;
    if (num(deal.COMPANY_ID)) fields.COMPANY_ID = num(deal.COMPANY_ID);
    const id = Number((await user.client.call<number | string>('crm.deal.add', { fields })).result);
    if (!(id > 0)) throw new Error('crm.deal.add не вернул ID сделки');
    await this.actions.user(user, {
      action: 'deal.create',
      summary: `Создал сделку #${id} с клиентом сделки #${dealId} (по сделке #${dealId} уже есть бронь)`,
      entityType: 'deal',
      entityId: String(id),
      details: { sourceDealId: dealId, contactIds },
      via: 'deal_tab',
    });
    return { id };
  }

  private async userNames(user: B24UserContext, ids: number[]): Promise<Map<number, string>> {
    const unique = [...new Set(ids)];
    const out = new Map<number, string>();
    if (!unique.length) return out;
    const rows = await user.client.listAll<{ ID: string; NAME?: string; LAST_NAME?: string }>('user.get', { FILTER: { ID: unique } }).catch(() => []);
    for (const r of rows) out.set(Number(r.ID), [r.NAME, r.LAST_NAME].filter(Boolean).join(' ').trim() || `Сотрудник #${r.ID}`);
    return out;
  }
}
