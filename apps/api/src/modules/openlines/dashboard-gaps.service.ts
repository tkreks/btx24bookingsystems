import { BadRequestException, Controller, ForbiddenException, Get, Injectable, Query, UseGuards } from '@nestjs/common';
import type { DashboardGapsDto } from '@btx24/shared';
import { selectedPeriod } from '../../common/period.js';
import { AccessService } from '../access/access.service.js';
import { B24AuthGuard, B24User } from '../bitrix24/auth/b24-auth.guard.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';

const MAX = 200;
type Deal = { ID: string; TITLE?: string; CONTACT_ID?: string; CATEGORY_ID?: string; DATE_CREATE?: string; OPPORTUNITY?: string; CURRENCY_ID?: string };

@Injectable()
export class DashboardGapsService {
  /** Открытые сделки доступных воронок; недоступный чат — неизвестное состояние, а не «чата нет». */
  async get(user: B24UserContext, kind: unknown, funnels: number[] | null, query: { from?: unknown; to?: unknown } = {}): Promise<DashboardGapsDto> {
    if (kind !== 'chat' && kind !== 'contact') throw new BadRequestException('Выберите проверку: chat или contact');
    if (funnels && !funnels.length) return { kind, items: [], notes: [] };
    const period = selectedPeriod(query, user.portal.timezone);
    const deals = await user.client.listAll<Deal>('crm.deal.list', {
      filter: { STAGE_SEMANTIC_ID: 'P', ...(period ? { '>=DATE_CREATE': period.start.toISOString(), '<DATE_CREATE': period.end.toISOString() } : {}), ...(funnels ? { '@CATEGORY_ID': funnels } : {}) },
      select: ['ID', 'TITLE', 'CONTACT_ID', 'CATEGORY_ID', 'DATE_CREATE', 'OPPORTUNITY', 'CURRENCY_ID'], order: { ID: 'DESC' },
    }, { max: MAX });
    const notes: string[] = deals.length >= MAX ? [`Проверены последние ${MAX} открытых сделок.`] : [];
    let filtered = deals.filter((d) => !funnels || funnels.includes(Number(d.CATEGORY_ID)));
    if (kind === 'contact') filtered = filtered.filter((d) => !(Number(d.CONTACT_ID) > 0));
    else {
      const entities = new Map<string, { type: 'deal' | 'contact'; id: number }>();
      for (const d of filtered) {
        entities.set(`d${d.ID}`, { type: 'deal', id: Number(d.ID) });
        if (Number(d.CONTACT_ID) > 0) entities.set(`c${d.CONTACT_ID}`, { type: 'contact', id: Number(d.CONTACT_ID) });
      }
      const batch = await user.client.batch(Object.fromEntries([...entities].map(([key, e]) => [key, { method: 'imopenlines.crm.chat.get', params: { CRM_ENTITY_TYPE: e.type, CRM_ENTITY: e.id, ACTIVE_ONLY: 'N' } }])));
      const state = (key: string): boolean | null => {
        if (batch.errors?.[key] || !Array.isArray(batch.result[key])) return null;
        return (batch.result[key] as { CHAT_ID?: string }[]).some((c) => Number(c.CHAT_ID) > 0);
      };
      let unknown = 0;
      filtered = filtered.filter((d) => {
        const direct = state(`d${d.ID}`);
        const contact = Number(d.CONTACT_ID) > 0 ? state(`c${d.CONTACT_ID}`) : false;
        if (direct || contact) return false;
        if (direct === null || contact === null) { unknown++; return false; }
        return true;
      });
      if (unknown) notes.push(`У ${unknown} сделок не удалось проверить чат: нет доступа или ошибка Битрикс24.`);
    }
    return { kind, notes, items: filtered.map((d) => ({ dealId: Number(d.ID), title: d.TITLE || `Сделка #${d.ID}`, contactId: Number(d.CONTACT_ID) || null, createdAt: d.DATE_CREATE || null, opportunity: d.OPPORTUNITY == null ? null : Number(d.OPPORTUNITY), currency: d.CURRENCY_ID ?? null })) };
  }
}

@Controller('dashboard')
@UseGuards(B24AuthGuard)
export class DashboardGapsController {
  constructor(private readonly access: AccessService, private readonly gaps: DashboardGapsService) {}
  @Get('deal-gaps')
  async get(@B24User() user: B24UserContext, @Query('kind') kind: unknown, @Query() query: Record<string, unknown> = {}): Promise<DashboardGapsDto> {
    const a = await this.access.resolve(user);
    if (!a.isAppAdmin && !a.groups.length) throw new ForbiddenException('Нет доступа к группам приложения');
    if (kind === 'chat' && !a.isAppAdmin && !a.groups.some((g) => g.permissions.includes('openlines.read'))) throw new ForbiddenException('Нет доступа к открытым линиям');
    const funnels = a.isAppAdmin ? null : [...new Set(a.groups.map((g) => g.group.dealCategoryId).filter((n): n is number => n !== null))];
    return this.gaps.get(user, kind, funnels, query);
  }
}
