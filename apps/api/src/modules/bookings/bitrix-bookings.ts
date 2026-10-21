import { Bitrix24Error } from '../bitrix24/rest/errors.js';
import type { Bitrix24RestClient } from '../bitrix24/rest/rest-client.js';

/** Чтение модуля бронирования Битрикс24 — общее для календаря и сверки. */

/** booking.v1.booking.list отдаёт не больше 50 записей и не умеет страницы. */
const LIST_LIMIT = 50;
/** Мельче не делим: столько броней на одном отрезке — уже аномалия, отдаём что есть. */
const MIN_SPLIT_SECONDS = 15 * 60;

export interface RawBooking {
  id: number;
  name?: string | null;
  description?: string | null;
  resourceIds?: number[];
  datePeriod?: { from?: { timestamp?: number }; to?: { timestamp?: number } };
}

/**
 * Брони, пересекающие [from, to) (секунды). Если пришло ровно 50 — список мог обрезаться: делим
 * отрезок пополам и собираем заново.
 */
export async function listBookings(client: Bitrix24RestClient, from: number, to: number): Promise<RawBooking[]> {
  const res = await client.call<{ booking?: RawBooking[] }>('booking.v1.booking.list', {
    filter: { within: { dateFrom: from, dateTo: to } },
  });
  const list = res.result?.booking ?? [];
  if (list.length < LIST_LIMIT || to - from <= MIN_SPLIT_SECONDS) return list;
  const mid = from + Math.floor((to - from) / 2);
  const [left, right] = await Promise.all([listBookings(client, from, mid), listBookings(client, mid, to)]);
  const byId = new Map<number, RawBooking>();
  for (const b of [...left, ...right]) byId.set(Number(b.id), b);
  return [...byId.values()];
}

/** Одна бронь; null — её нет (удалена). */
export async function getBooking(client: Bitrix24RestClient, id: number): Promise<RawBooking | null> {
  try {
    const res = await client.call<{ booking?: RawBooking }>('booking.v1.booking.get', { id });
    return res.result?.booking ?? null;
  } catch (err) {
    // 1021 — «Booking not found».
    if (err instanceof Bitrix24Error && String(err.code) === '1021') return null;
    throw err;
  }
}

/** bookingId → dealId по связям externalData (crm / DEAL). */
export async function dealLinks(client: Bitrix24RestClient, bookingIds: number[]): Promise<Map<number, number>> {
  const links = new Map<number, number>();
  if (!bookingIds.length) return links;
  const commands = Object.fromEntries(
    bookingIds.map((id) => [`b${id}`, { method: 'booking.v1.booking.externalData.list', params: { bookingId: id } }]),
  );
  const res = await client.batch(commands);
  for (const id of bookingIds) {
    const raw = res.result[`b${id}`] as
      { externalData?: { moduleId?: string; entityTypeId?: string; value?: string }[] } | undefined;
    const deal = (raw?.externalData ?? []).find(
      (x) => x.moduleId === 'crm' && String(x.entityTypeId).toUpperCase() === 'DEAL',
    );
    if (deal?.value && /^\d+$/.test(deal.value)) links.set(id, Number(deal.value));
  }
  return links;
}

export async function listResources(client: Bitrix24RestClient): Promise<{ id: number; name: string }[]> {
  const list = await client.listAll<{ id: number; name?: string }>(
    'booking.v1.resource.list',
    {},
    { pick: (r) => ((r as { resource?: unknown[] })?.resource ?? []) as { id: number; name?: string }[] },
  );
  return list.map((r) => ({ id: Number(r.id), name: r.name || `Ресурс ${r.id}` }));
}
