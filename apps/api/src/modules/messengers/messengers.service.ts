import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { isScreenLoginKind, MESSENGER_KINDS, normalizeMessengerPhone, type CreateMessengerDto, type MessengerDto, type MessengerState } from '@btx24/shared';
import type { Messenger } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { MessengerServiceClient, type ServiceInstance } from './messenger-service.client.js';
import { vncTickets } from './vnc-tickets.js';

const STATES = new Set<string>(['stopped', 'starting', 'pairing', 'qr', 'authenticated', 'ready', 'disconnected', 'logged_out', 'failed']);

/**
 * Мессенджеры портала (ADR 0014): запись в базе приложения (что подключено, кем, последнее состояние)
 * + браузер в сервисе messenger. Сервис перезапустился или потерял экземпляр — `list` поднимает его
 * снова (сессия входа хранится в томе сервиса).
 */
@Injectable()
export class MessengersService {
  private readonly logger = new Logger(MessengersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly service: MessengerServiceClient,
  ) {}

  async list(portalId: string): Promise<MessengerDto[]> {
    const rows = await this.prisma.messenger.findMany({ where: { portalId }, orderBy: { createdAt: 'asc' } });
    if (!rows.length) return [];
    const live = await this.service.list().catch(() => null);
    if (!live) return rows.map((r) => toDto(r, null, 'unavailable'));
    const byId = new Map(live.map((i) => [i.id, i]));
    const out: MessengerDto[] = [];
    for (const r of rows) {
      let inst = byId.get(r.id) ?? null;
      if (!inst) inst = await this.service.ensure(r.id, { kind: r.kind, phone: r.phone, auth: authOf(r) }).catch(() => null);
      out.push(toDto(await this.remember(r, inst), inst));
    }
    return out;
  }

  async create(portalId: string, userId: number, body: CreateMessengerDto): Promise<MessengerDto> {
    const kind = MESSENGER_KINDS.find((k) => k.kind === body?.kind);
    if (!kind) throw new BadRequestException({ code: 'INVALID_KIND', message: 'Выберите мессенджер' });
    if (!kind.available) throw new BadRequestException({ code: 'KIND_NOT_READY', message: `${kind.label} пока не подключается — начнём с WhatsApp` });
    const phone = normalizeMessengerPhone(body.phone);
    if (!phone) throw new BadRequestException({ code: 'INVALID_PHONE', message: 'Номер телефона: 10–15 цифр с кодом страны' });
    const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 255) : null;
    if (await this.prisma.messenger.findUnique({ where: { portalId_kind_phone: { portalId, kind: kind.kind, phone } } }))
      throw new ConflictException({ code: 'MESSENGER_EXISTS', message: `${kind.label} с номером +${phone} уже добавлен` });
    // Telegram и MAX: вход только на экране браузера (QR или номер и код там же).
    const auth = isScreenLoginKind(kind.kind) || body.auth === 'qr' ? 'qr' : 'code';
    const row = await this.prisma.messenger.create({ data: { portalId, kind: kind.kind, phone, auth, title, createdByUserId: userId } });
    const inst = await this.service.ensure(row.id, { kind: row.kind, phone, auth }).catch((err: unknown) => {
      this.logger.warn(`messenger ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
    return toDto(await this.remember(row, inst), inst, inst ? undefined : 'unavailable');
  }

  /** Перезапустить браузер; `auth` — сменить способ входа (код ↔ QR). */
  async restart(portalId: string, id: string, auth?: 'code' | 'qr'): Promise<MessengerDto> {
    let row = await this.own(portalId, id);
    if (auth && auth !== authOf(row)) row = await this.prisma.messenger.update({ where: { id }, data: { auth } });
    // Смена способа входа — новый экземпляр (старая незавершённая попытка входа не нужна).
    const inst = auth ? await this.service.remove(id).then(() => this.service.ensure(id, { kind: row.kind, phone: row.phone, auth: authOf(row) })) : await this.service.restart(id);
    return toDto(await this.remember(row, inst), inst);
  }

  async stop(portalId: string, id: string): Promise<MessengerDto> {
    const row = await this.own(portalId, id);
    const inst = await this.service.stop(id);
    return toDto(await this.remember(row, inst), inst);
  }

  /** Выйти из аккаунта и удалить: в телефоне исчезнет связанное устройство. */
  async remove(portalId: string, id: string): Promise<void> {
    await this.own(portalId, id);
    await this.service.remove(id);
    await this.prisma.messenger.delete({ where: { id } });
  }

  async vncTicket(portalId: string, userId: number, id: string): Promise<string> {
    await this.own(portalId, id);
    return vncTickets.issue({ messengerId: id, portalId, userId });
  }

  async screenshot(portalId: string, id: string): Promise<Buffer | null> {
    await this.own(portalId, id);
    return this.service.screenshot(id);
  }

  /** Мессенджер этого портала — иначе 404 (чужой ID не выдаёт, что он существует). */
  private async own(portalId: string, id: string): Promise<Messenger> {
    const row = await this.prisma.messenger.findFirst({ where: { id, portalId } });
    if (!row) throw new NotFoundException({ code: 'MESSENGER_NOT_FOUND', message: 'Мессенджер не найден' });
    return row;
  }

  /** Сохранить изменившееся состояние (чтобы список был виден и без сервиса). */
  private async remember(row: Messenger, inst: ServiceInstance | null): Promise<Messenger> {
    if (!inst || !STATES.has(inst.state)) return row;
    const data = {
      state: inst.state,
      account: inst.account ?? row.account,
      lastError: inst.error?.slice(0, 500) ?? null,
      ...(inst.state === 'ready' && row.state !== 'ready' ? { connectedAt: new Date() } : {}),
    };
    if (data.state === row.state && data.account === row.account && data.lastError === row.lastError) return row;
    return this.prisma.messenger.update({ where: { id: row.id }, data });
  }
}

const authOf = (r: Messenger): 'code' | 'qr' => (r.auth === 'qr' ? 'qr' : 'code');

export function toDto(r: Messenger, inst: ServiceInstance | null, override?: MessengerState): MessengerDto {
  return {
    id: r.id,
    kind: r.kind as MessengerDto['kind'],
    phone: r.phone,
    auth: authOf(r),
    title: r.title,
    state: override ?? ((inst?.state ?? r.state) as MessengerState),
    code: inst?.code ?? null,
    qr: inst?.qr ?? null,
    account: inst?.account ?? r.account,
    error: inst ? inst.error : r.lastError,
    connectedAt: r.connectedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    line: r.lineMode === 'own' && r.lineId ? { mode: 'own', lineId: r.lineId, name: r.lineName } : null,
    groupIds: Array.isArray(r.groupIds) ? (r.groupIds as unknown[]).filter((x): x is string => typeof x === 'string') : [],
  };
}
