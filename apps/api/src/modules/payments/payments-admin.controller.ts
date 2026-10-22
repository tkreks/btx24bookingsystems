import { Controller, Get, UseGuards } from '@nestjs/common';
import type { InvoiceMetaDto } from '@btx24/shared';
import { AppAdminGuard } from '../access/app-admin.guard.js';
import { B24AuthGuard, B24User } from '../bitrix24/auth/b24-auth.guard.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';

type Field = { title?: string; type?: string; items?: { ID: string | number; VALUE: string }[] };

/** Справочник смарт-счетов для настройки счёта группы (⚙ → группа → «Оплаты»). */
@Controller('admin')
@UseGuards(B24AuthGuard, AppAdminGuard)
export class PaymentsAdminController {
  @Get('invoice-meta')
  async meta(@B24User() user: B24UserContext): Promise<InvoiceMetaDto> {
    const cats = (await user.client.call<{ categories?: { id: number; name: string }[] }>('crm.category.list', { entityTypeId: 31 })).result?.categories ?? [];
    const categories: InvoiceMetaDto['categories'] = [];
    for (const c of cats) {
      const st = await user.client.call<{ STATUS_ID: string; NAME: string; SORT?: string }[]>('crm.status.list', {
        filter: { ENTITY_ID: `SMART_INVOICE_STAGE_${c.id}` },
        order: { SORT: 'ASC' },
      });
      categories.push({ id: Number(c.id), name: c.name, stages: (Array.isArray(st.result) ? st.result : []).map((s) => ({ id: s.STATUS_ID, name: s.NAME })) });
    }
    const raw = (await user.client.call<{ fields?: Record<string, Field> }>('crm.item.fields', { entityTypeId: 31 })).result?.fields ?? {};
    const fields = Object.entries(raw)
      .filter(([code, f]) => code.startsWith('ufCrm') && ['string', 'url', 'enumeration'].includes(String(f.type)))
      .map(([code, f]) => ({
        code,
        title: f.title ?? code,
        type: String(f.type),
        items: (f.items ?? []).map((i) => ({ id: Number(i.ID), value: i.VALUE })),
      }));
    return { categories, fields };
  }
}
