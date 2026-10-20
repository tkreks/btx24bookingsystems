import { GROUP_FEATURES, ROLES } from '@btx24/shared';
import { z } from 'zod';

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');
const member = z.object({ kind: z.enum(['USER', 'DEPARTMENT']), bitrixId: z.number().int().positive() });

/** Тело PUT/POST /api/admin/groups — полная замена настроек группы. */
export const groupSettingsSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    dealCategoryId: z.number().int().nonnegative().nullable(),
    resourceIds: z.array(z.number().int().positive()).max(500),
    bookingMode: z.enum(['duration', 'interval']),
    durationMinutes: z.number().int().min(1).max(10080),
    checkInTime: time,
    checkOutTime: time,
    defaultNights: z.number().int().min(0).max(365),
    techWindowMinutes: z.number().int().min(0).max(1440),
    features: z.array(z.enum(GROUP_FEATURES)).max(GROUP_FEATURES.length),
    members: z.array(member.extend({ role: z.enum(ROLES) })).max(1000),
  })
  .strict();

export const appSettingsSchema = z
  .object({
    dialogMetadataEnabled: z.boolean(),
    dialogTextsEnabled: z.boolean(),
    admins: z.array(member).max(200),
  })
  .strict()
  .refine((s) => !s.dialogTextsEnabled || s.dialogMetadataEnabled, { message: 'Сбор текстов требует включённого сбора метаданных', path: ['dialogTextsEnabled'] });
