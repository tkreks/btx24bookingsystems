import { BadRequestException, Injectable } from '@nestjs/common';
import { DEAL_FIELD_ROLES, type DealFieldMapDto, type DealFieldRole } from '@btx24/shared';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import type { Bitrix24RestClient } from '../bitrix24/rest/rest-client.js';

interface FieldMeta {
  title?: string;
  listLabel?: string;
  formLabel?: string;
  filterLabel?: string;
}

const ROLES = Object.keys(DEAL_FIELD_ROLES) as DealFieldRole[];
const CODE = /^UF_CRM_[A-Z0-9_]{1,60}$/;

/** Системные поля сделки портала (роль → код поля): хранение, проверка и автоопределение. */
@Injectable()
export class DealFieldMapService {
  constructor(private readonly prisma: PrismaService) {}

  private readonly enumCache = new Map<string, { items: { ID: string; XML_ID?: string; VALUE?: string }[]; expiresAt: number }>();

  /**
   * Значение поля-списка сделки для записи через REST — номер варианта (ID). БП хранит варианты
   * по внутреннему коду (XML_ID, «3af19224…»), а `crm.deal.update` принимает только номер: код и
   * название варианта переводим в номер. Не нашли — null (не записываем мусор).
   */
  async enumId(portalId: string, client: Bitrix24RestClient, fieldCode: string, value: string): Promise<string | null> {
    const v = value.trim();
    if (!v) return null;
    const key = `${portalId}:${fieldCode}`;
    let hit = this.enumCache.get(key);
    if (!hit || hit.expiresAt < Date.now()) {
      const r = await client.call<{ LIST?: { ID: string; XML_ID?: string; VALUE?: string }[] }[]>('crm.deal.userfield.list', { filter: { FIELD_NAME: fieldCode } });
      hit = { items: (Array.isArray(r.result) ? r.result[0]?.LIST : undefined) ?? [], expiresAt: Date.now() + 10 * 60_000 };
      this.enumCache.set(key, hit);
    }
    // Не список (строка, число) — пишем как есть.
    if (!hit.items.length) return v;
    const item = hit.items.find((i) => String(i.ID) === v) ?? hit.items.find((i) => i.XML_ID === v) ?? hit.items.find((i) => i.VALUE === v);
    return item ? String(item.ID) : null;
  }

  async get(portalId: string): Promise<DealFieldMapDto> {
    const s = await this.prisma.portalSettings.findUnique({ where: { portalId } });
    return clean(s?.dealFieldMap);
  }

  async save(portalId: string, userId: number, body: unknown): Promise<DealFieldMapDto> {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new BadRequestException({ code: 'INVALID_MAP', message: 'Ожидается объект «роль → код поля»' });
    for (const [k, v] of Object.entries(body))
      if (!ROLES.includes(k as DealFieldRole) || (v !== '' && (typeof v !== 'string' || !CODE.test(v))))
        throw new BadRequestException({ code: 'INVALID_MAP', message: `Неверное поле: ${k}` });
    const map = clean(body) as Prisma.InputJsonValue;
    await this.prisma.portalSettings.upsert({
      where: { portalId },
      create: { portalId, dealFieldMap: map, updatedByUserId: userId },
      update: { dealFieldMap: map, updatedByUserId: userId },
    });
    return this.get(portalId);
  }

  /** Найти поля по названиям («ID Бронирования», «Дата начала визита» …) — правами администратора. */
  async detect(user: B24UserContext): Promise<DealFieldMapDto> {
    const fields = (await user.client.call<Record<string, FieldMeta>>('crm.deal.fields')).result ?? {};
    return detectFieldMap(fields);
  }
}

export function detectFieldMap(fields: Record<string, FieldMeta>): DealFieldMapDto {
  const norm = (s: string | undefined) => String(s ?? '').trim().toLocaleLowerCase('ru').replace(/\s+/g, ' ');
  const out: DealFieldMapDto = {};
  for (const role of ROLES) {
    const want = norm(DEAL_FIELD_ROLES[role]);
    const hit = Object.entries(fields).find(
      ([code, f]) => code.startsWith('UF_CRM_') && [f.listLabel, f.formLabel, f.title, f.filterLabel].some((l) => norm(l) === want),
    );
    if (hit) out[role] = hit[0];
  }
  return out;
}

function clean(v: unknown): DealFieldMapDto {
  const out: DealFieldMapDto = {};
  if (v && typeof v === 'object')
    for (const [k, code] of Object.entries(v as Record<string, unknown>))
      if (ROLES.includes(k as DealFieldRole) && typeof code === 'string' && CODE.test(code)) out[k as DealFieldRole] = code;
  return out;
}
