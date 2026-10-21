import { GROUP_FEATURES, ROLES } from '@btx24/shared';
import { z } from 'zod';

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');
const member = z.object({ kind: z.enum(['USER', 'DEPARTMENT']), bitrixId: z.number().int().positive() });

const view = z.enum(['', 'calendar', 'list', 'availability']);
const diskFile = z.object({ id: z.number().int().positive(), name: z.string().max(255) }).strict();
const messageStep = z
  .object({ text: z.string().max(4000), files: z.array(diskFile).max(10) })
  .strict()
  .refine((st) => st.text.trim().length > 0 || st.files.length > 0, { message: 'Пустое сообщение' });
/** Тип брони: ключевые слова в товарах, значение поля «Тип бронирования», программа, подтверждение. */
const bookingTypeRule = z
  .object({
    id: z.string().min(1).max(40),
    title: z.string().trim().min(1).max(100),
    keywords: z.array(z.string().trim().min(1).max(100)).min(1).max(50),
    dealTypeValue: z.string().max(50),
    program: z.string().max(200),
    confirmation: z.array(messageStep).max(20),
  })
  .strict();

const payStep = z.object({ stageId: z.string().max(100), moveStage: z.boolean(), templateId: z.string().max(50) }).strict();

/** `WorkGroup.options` — настройки направления, перенесённые из прототипа. */
export const groupOptionsSchema = z
  .object({
    dealFields: z
      .array(
        z
          .object({
            name: z.string().regex(/^[A-Z0-9_]+$/i).max(100),
            title: z.string().max(200).optional(),
            required: z.boolean(),
            inlineNext: z.boolean(),
            showCreate: z.boolean(),
            showView: z.boolean(),
            showList: z.boolean(),
          })
          .strict(),
      )
      .max(80),
    productSectionIds: z.array(z.string().max(32)).max(500),
    resourceDefaults: z.record(z.string().regex(/^\d+$/), z.array(z.object({ productId: z.number().int().positive(), quantity: z.number().positive() }).strict()).max(50)),
    views: z.object({ desktop: view, mobile: view }).strict(),
    bookingTypes: z.array(bookingTypeRule).max(30).optional(),
    payments: z
      .object({
        prepayment: payStep,
        surcharge: payStep,
        timeoutMinutes: z.number().int().min(1).max(10080),
        successStageId: z.string().max(100),
        failStageId: z.string().max(100),
        successTemplateId: z.string().max(50),
        failTemplateId: z.string().max(50),
        prepaymentAmount: z.number().min(0).max(10_000_000).optional(),
        clientMessage: z.string().max(4000).optional(),
        failMessage: z.string().max(4000).optional(),
      })
      .strict(),
  })
  .strict();

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
    options: groupOptionsSchema.nullable().optional(),
  })
  .strict();

export const appSettingsSchema = z
  .object({
    dialogMetadataEnabled: z.boolean(),
    dialogTextsEnabled: z.boolean(),
    removeWazzupEmail: z.boolean(),
    admins: z.array(member).max(200),
  })
  .strict()
  .refine((s) => !s.dialogTextsEnabled || s.dialogMetadataEnabled, { message: 'Сбор текстов требует включённого сбора метаданных', path: ['dialogTextsEnabled'] });
