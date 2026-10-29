import { SYSTEM_FIELDS, type ContactFieldMapDto } from '@btx24/shared';
import type { PrismaService } from '../../prisma/prisma.service.js';

export function cleanContactFieldMap(value: unknown): ContactFieldMapDto {
  const out: ContactFieldMapDto = {};
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const kind of ['telegram', 'whatsapp', 'max', 'whatsappLid', 'telegramLogin', 'maxLogin'] as const) {
      const code = (value as Record<string, unknown>)[kind];
      if (typeof code === 'string' && /^UF_CRM_[A-Z0-9_]{1,60}$/.test(code)) out[kind] = code;
    }
  }
  return out;
}
export async function contactFieldMap(prisma: PrismaService, portalId: string): Promise<ContactFieldMapDto> {
  const row = await prisma.portalSettings.findUnique({ where: { portalId } });
  return cleanContactFieldMap(row?.contactFieldMap);
}
export function mappedContactField(kind: string, map: ContactFieldMapDto): string | null {
  const definition = SYSTEM_FIELDS.find(f => f.entity === 'contact' && f.key === kind);
  return definition ? map[definition.key as keyof ContactFieldMapDto] ?? definition.defaultCode ?? null : null;
}
