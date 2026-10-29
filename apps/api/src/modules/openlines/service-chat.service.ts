import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { ServiceChatDto, ServiceChatMessageDto, ServiceChatSource } from '@btx24/shared';
import type { ServiceChatMessage } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';

const PAGE = 200;
const MAX_TEXT = 4000;

type Db = Pick<PrismaService, 'serviceChat' | 'serviceChatMessage'>;

/**
 * Записать сообщение автоматики в служебный чат сделки, если он у сделки есть (менеджер выбрал «Без
 * мессенджера»). true — записано; нет чата — false, вызывающий действует как раньше.
 */
export async function appendServiceMessage(prisma: Db, portalId: string, dealId: number, source: ServiceChatSource, text: string): Promise<boolean> {
  const body = text.trim().slice(0, MAX_TEXT);
  if (!body) return false;
  const chat = await prisma.serviceChat.findUnique({ where: { portalId_dealId: { portalId, dealId } }, select: { id: true } });
  if (!chat) return false;
  await prisma.serviceChatMessage.create({ data: { portalId, dealId, source, text: body } });
  return true;
}

const toDto = (m: ServiceChatMessage): ServiceChatMessageDto => ({
  id: m.id,
  source: m.source as ServiceChatSource,
  text: m.text,
  authorName: m.authorName,
  createdAt: m.createdAt.toISOString(),
});

/**
 * Служебный чат сделки: только в приложении, в Битрикс24 не отправляется. Видит тот, кому Битрикс24
 * открывает сделку (`crm.deal.get` токеном сотрудника); писать — с правом `openlines.send` (проверяет контроллер).
 */
@Injectable()
export class ServiceChatService {
  constructor(private readonly prisma: PrismaService) {}

  async get(user: B24UserContext, dealId: number): Promise<ServiceChatDto> {
    await this.requireDeal(user, dealId);
    const chat = await this.prisma.serviceChat.findUnique({ where: { portalId_dealId: { portalId: user.portal.id, dealId } } });
    if (!chat) return { dealId, chat: null, messages: [] };
    const rows = await this.prisma.serviceChatMessage.findMany({ where: { portalId: user.portal.id, dealId }, orderBy: { createdAt: 'desc' }, take: PAGE });
    return { dealId, chat: { createdAt: chat.createdAt.toISOString(), createdByUserId: chat.createdByUserId }, messages: rows.reverse().map(toDto) };
  }

  /** Создать (повтор безопасен — вернёт уже созданный). */
  async create(user: B24UserContext, dealId: number): Promise<ServiceChatDto> {
    await this.requireDeal(user, dealId);
    await this.prisma.serviceChat.upsert({
      where: { portalId_dealId: { portalId: user.portal.id, dealId } },
      create: { portalId: user.portal.id, dealId, createdByUserId: user.userId },
      update: {},
    });
    return this.get(user, dealId);
  }

  async post(user: B24UserContext, dealId: number, text: unknown): Promise<ServiceChatMessageDto> {
    const body = String(text ?? '').trim();
    if (!body) throw new BadRequestException({ code: 'EMPTY_MESSAGE', message: 'Пустое сообщение' });
    if (body.length > MAX_TEXT) throw new BadRequestException({ code: 'TOO_LONG', message: `Не больше ${MAX_TEXT} символов` });
    await this.requireDeal(user, dealId);
    const chat = await this.prisma.serviceChat.findUnique({ where: { portalId_dealId: { portalId: user.portal.id, dealId } }, select: { id: true } });
    if (!chat) throw new NotFoundException({ code: 'NO_SERVICE_CHAT', message: 'У сделки нет служебного чата' });
    return toDto(await this.prisma.serviceChatMessage.create({ data: { portalId: user.portal.id, dealId, source: 'manager', text: body, authorId: user.userId, authorName: user.userName.slice(0, 255) || null } }));
  }

  private async requireDeal(user: B24UserContext, dealId: number): Promise<void> {
    const deal = (await user.client.call<{ ID?: string }>('crm.deal.get', { id: dealId })).result;
    if (!deal?.ID) throw new NotFoundException({ code: 'DEAL_NOT_FOUND', message: `Сделка #${dealId} не найдена` });
  }
}
