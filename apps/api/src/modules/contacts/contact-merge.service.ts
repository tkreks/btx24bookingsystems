import { BadGatewayException, BadRequestException, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { MERGE_MAX_CONTACTS, type MergeContactsResultDto } from '@btx24/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ActionLogService, userActor } from '../audit/action-log.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { ContactMergeGrant } from '../bitrix24/rest/rest-client.js';
import { Bitrix24Error } from '../bitrix24/rest/errors.js';
import { emptyValue, isEmpty, normalized } from './contact-compare.js';
import { ContactDuplicatesService } from './contact-duplicates.service.js';

export const mergeSchema = z
  .object({
    idempotencyKey: z.string().min(8).max(64),
    primaryId: z.number().int().positive(),
    ids: z.array(z.number().int().positive()).min(2).max(MERGE_MAX_CONTACTS),
    choices: z.record(z.string().regex(/^[A-Z0-9_]{1,64}$/), z.number().int().positive()).default({}),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (new Set(v.ids).size !== v.ids.length) ctx.addIssue({ code: 'custom', message: 'Контакты повторяются' });
    if (!v.ids.includes(v.primaryId)) ctx.addIssue({ code: 'custom', message: 'Основной контакт должен быть в группе' });
    if (Object.values(v.choices).some((id) => !v.ids.includes(id))) ctx.addIssue({ code: 'custom', message: 'Значение выбрано у контакта не из группы' });
  });
export type MergeInput = z.infer<typeof mergeSchema>;

const MERGED = 'contact.merged';

interface Change {
  contactId: number;
  field: string;
  label: string;
  before: unknown;
  after: unknown;
}

/**
 * Объединение дублей контактов (ADR 0022): (1) свежие данные токеном сотрудника; (2) для полей с
 * конфликтом — выбранное значение (по умолчанию у основного) записывается в основной и в контакты, где
 * поле заполнено иначе, иначе Битрикс24 вернёт CONFLICT; (3) `crm.entity.mergeBatch` [основной, …].
 * Запись — только через ContactMergeGrant. Повтор с тем же idempotencyKey возвращает прежний результат.
 */
@Injectable()
export class ContactMergeService {
  private readonly inflight = new Map<string, Promise<MergeContactsResultDto>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly duplicates: ContactDuplicatesService,
    private readonly log: ActionLogService,
  ) {}

  async merge(user: B24UserContext, body: unknown): Promise<MergeContactsResultDto> {
    const parsed = mergeSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ code: 'INVALID_MERGE', message: parsed.error.issues[0]?.message ?? 'Неверные данные объединения' });
    const input = parsed.data;
    const key = `${user.portal.id}:${input.idempotencyKey}`;
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.run(user, input).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  /** Уже объединено с этим ключом — результат из журнала действий (в т.ч. после перезапуска api). */
  private async previous(portalId: string, input: MergeInput): Promise<MergeContactsResultDto | null> {
    const rows = await this.prisma.actionLog.findMany({
      where: { portalId, action: MERGED, entityType: 'contact', entityId: String(input.primaryId) },
      orderBy: { at: 'desc' },
      take: 20,
      select: { details: true },
    });
    for (const r of rows) {
      const d = (r.details ?? {}) as { idempotencyKey?: string; result?: MergeContactsResultDto };
      if (d.idempotencyKey === input.idempotencyKey && d.result) return { ...d.result, warnings: [...d.result.warnings, 'Повтор запроса: контакты уже объединены'] };
    }
    return null;
  }

  private async run(user: B24UserContext, input: MergeInput): Promise<MergeContactsResultDto> {
    const prev = await this.previous(user.portal.id, input);
    if (prev) return prev;
    const ids = [input.primaryId, ...input.ids.filter((id) => id !== input.primaryId)];
    const fresh = await this.duplicates.fresh(user, ids);
    const grant = new ContactMergeGrant(input.primaryId, ids);

    // Выравнивание: что и куда записать.
    const updates = new Map<number, Record<string, unknown>>();
    const changes: Change[] = [];
    for (const f of fresh.fields) {
      if (!f.conflict) continue;
      const meta = fresh.meta[f.code] ?? {};
      const from = input.choices[f.code] ?? input.primaryId;
      const chosen = f.raw[from];
      const target = isEmpty(chosen, meta) ? emptyValue(meta) : chosen;
      const want = normalized(chosen, meta);
      for (const id of ids) {
        const have = normalized(f.raw[id], meta);
        if (have === want) continue;
        // Пустое у неосновного не мешает: Битрикс24 возьмёт заполненное. Основной — всегда как выбрано.
        if (id !== input.primaryId && have === null) continue;
        updates.set(id, { ...updates.get(id), [f.code]: target });
        changes.push({ contactId: id, field: f.code, label: f.label, before: f.raw[id] ?? null, after: target });
      }
    }

    const done: number[] = [];
    try {
      for (const id of ids) {
        const fields = updates.get(id);
        if (!fields) continue;
        await user.client.callContactMerge(grant, 'crm.contact.update', { id, fields, params: { REGISTER_SONET_EVENT: 'N' } });
        done.push(id);
      }
    } catch (err) {
      await this.journal(user, input, ids, 'contact.merge_failed', `Объединение контактов ${ids.map((i) => '#' + i).join(', ')} не выполнено: ошибка при выравнивании полей`, { changes, updated: done, error: errText(err) });
      throw err;
    }

    let res: { STATUS?: string; ENTITY_IDS?: unknown[] };
    try {
      res = (await user.client.callContactMerge<{ STATUS?: string; ENTITY_IDS?: unknown[] }>(grant, 'crm.entity.mergeBatch', { params: { entityTypeId: 3, entityIds: ids } })).result ?? {};
    } catch (err) {
      await this.journal(user, input, ids, 'contact.merge_failed', `Объединение контактов ${ids.map((i) => '#' + i).join(', ')} не выполнено`, { changes, updated: done, error: errText(err) });
      if (err instanceof Bitrix24Error && !['ACCESS_DENIED', 'insufficient_scope', 'user_access_error', 'READ_ONLY_MODE', 'CONTACT_WRITE_DISABLED'].includes(err.code))
        throw new BadGatewayException({ code: 'MERGE_FAILED', message: `Битрикс24 не объединил контакты: ${err.message}` });
      throw err;
    }

    const status = String(res.STATUS ?? '').toUpperCase();
    if (status === 'SUCCESS') {
      const removed = (Array.isArray(res.ENTITY_IDS) ? res.ENTITY_IDS.map(Number) : []).filter((id) => ids.includes(id) && id !== input.primaryId);
      const removedIds = removed.length ? removed : ids.slice(1);
      // Копия CRM: удалённые помечаем сразу (событие удаления потом не создаст «контакт удалён»).
      await this.prisma.crmEntity.updateMany({ where: { portalId: user.portal.id, entityTypeId: 3, entityId: { in: removedIds }, deletedAt: null }, data: { deletedAt: new Date() } });
      this.duplicates.invalidate(user.portal.id);
      const result: MergeContactsResultDto = { status: 'merged', primaryId: input.primaryId, removedIds, conflicts: [], warnings: [] };
      await this.journal(user, input, ids, MERGED, `Объединены контакты ${ids.map((i) => '#' + i).join(', ')} → #${input.primaryId}`, { changes, removedIds, result });
      return result;
    }
    if (status === 'CONFLICT') {
      const after = await this.duplicates.fresh(user, ids).catch(() => null);
      const conflicts = after ? after.fields.filter((f) => f.conflict).map((f) => f.code) : [];
      const warnings = [
        'Битрикс24 не смог объединить контакты автоматически — ничего не удалено.',
        conflicts.length
          ? 'Поля всё ещё различаются — выберите значения ещё раз или объедините в Битрикс24.'
          : 'Различаются поля, которые приложение не видит или не меняет (фото, файлы, скрытые поля) — объедините в Битрикс24.',
        ...(done.length ? [`Выбранные значения уже записаны в контакты ${done.map((i) => '#' + i).join(', ')}.`] : []),
      ];
      const result: MergeContactsResultDto = { status: 'conflict', primaryId: input.primaryId, removedIds: [], conflicts, warnings };
      await this.journal(user, input, ids, 'contact.merge_conflict', `Объединение контактов ${ids.map((i) => '#' + i).join(', ')}: конфликт в Битрикс24`, { changes, updated: done, result });
      return result;
    }
    await this.journal(user, input, ids, 'contact.merge_failed', `Объединение контактов ${ids.map((i) => '#' + i).join(', ')} не выполнено`, { changes, updated: done, response: res });
    throw new BadGatewayException({ code: 'MERGE_FAILED', message: 'Битрикс24 не объединил контакты (ERROR) — попробуйте ещё раз или объедините в Битрикс24' });
  }

  private journal(user: B24UserContext, input: MergeInput, ids: number[], action: string, summary: string, extra: Record<string, unknown>) {
    return this.log.log(user.portal.id, userActor(user), {
      action,
      summary,
      entityType: 'contact',
      entityId: input.primaryId,
      via: 'app',
      details: { idempotencyKey: input.idempotencyKey, primaryId: input.primaryId, ids, choices: input.choices, ...extra },
    });
  }
}

const errText = (err: unknown) => (err instanceof Error ? err.message.slice(0, 300) : String(err));
