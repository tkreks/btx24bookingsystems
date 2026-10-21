import { BadRequestException, Injectable } from '@nestjs/common';
import { DEAL_FIELD_ROLES, type DealFieldMapDto, type DealFieldRole } from '@btx24/shared';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';

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
