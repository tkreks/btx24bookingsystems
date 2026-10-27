import { Injectable, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MessengerScreenFilesDto } from '@btx24/shared';
import type { Env } from '../../config/env.js';

/** Состояние экземпляра, как его отдаёт сервис messenger (`apps/messenger/src/spec.ts`). */
export interface ServiceInstance {
  id: string;
  kind: string;
  phone: string;
  auth: 'code' | 'qr';
  state: string;
  code: string | null;
  qr: string | null;
  account: string | null;
  error: string | null;
  updatedAt: string;
}

/** Вложение в хранилище сервиса. */
export interface WireMedia {
  fileId: string;
  mime: string;
  name: string | null;
  size: number;
}

/** Сообщение, как его отдаёт сервис (`apps/messenger/src/messages.ts`). */
export interface WireMessage {
  id: string;
  chatId: string;
  fromMe: boolean;
  author: string | null;
  /** Имя собеседника; в группе — название группы (если известно). */
  name: string | null;
  /** Группа: имя написавшего участника. */
  authorName?: string | null;
  /** Номер собеседника для чата со скрытым ID (`…@lid`), если известен. */
  phone?: string | null;
  body: string;
  type: string;
  hasMedia: boolean;
  media?: WireMedia | null;
  mediaInfo?: { mime: string | null; name: string | null; size: number | null } | null;
  quotedId: string | null;
  timestamp: number;
  ack: number | null;
}

export type WireEvent =
  | { type: 'message'; instanceId: string; message: WireMessage }
  | { type: 'edit'; instanceId: string; id: string; chatId: string; body: string; prevBody: string; at: number }
  | { type: 'revoke'; instanceId: string; id: string; chatId: string; at: number }
  | { type: 'ack'; instanceId: string; id: string; ack: number }
  /** Полный текущий набор реакций сообщения (пустой — все сняли). */
  | { type: 'reaction'; instanceId: string; id: string; chatId: string; reactions: WireReaction[] };

export interface WireReaction {
  emoji: string;
  /** Поставил наш аккаунт (сотрудник с телефона). */
  mine: boolean;
}

const TIMEOUT_MS = 10_000;

/**
 * Внутренний HTTP к сервису мессенджеров (ADR 0014). Сервис — наш, в сети стенда, не портал
 * Битрикс24 (правило про модуль `bitrix24` к нему не относится). Недоступен — 503.
 */
@Injectable()
export class MessengerServiceClient {
  readonly base: string;
  readonly token: string;

  constructor(config: ConfigService<Env, true>) {
    this.base = config.get('MESSENGER_URL', { infer: true }).replace(/\/$/, '');
    this.token = config.get('MESSENGER_TOKEN', { infer: true }) ?? '';
  }

  headers(): Record<string, string> {
    return this.token ? { 'x-messenger-token': this.token } : {};
  }

  private async request<T>(method: string, path: string, body?: unknown, timeoutMs = TIMEOUT_MS): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers: { ...this.headers(), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new ServiceUnavailableException({ code: 'MESSENGER_UNAVAILABLE', message: 'Сервис мессенджеров недоступен' });
    }
    if (res.status === 422) {
      // Отказ мессенджера (номера нет в WhatsApp, правка запрещена) — понятная ошибка сотруднику.
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new UnprocessableEntityException({ code: 'MESSENGER_REFUSED', message: err.error ?? 'Мессенджер отказал' });
    }
    if (!res.ok) throw new ServiceUnavailableException({ code: 'MESSENGER_ERROR', message: `Сервис мессенджеров: ${res.status} ${(await res.text()).slice(0, 200)}` });
    return (await res.json()) as T;
  }

  list(): Promise<ServiceInstance[]> {
    return this.request('GET', '/instances');
  }
  ensure(id: string, spec: { kind: string; phone: string; auth: 'code' | 'qr' }): Promise<ServiceInstance> {
    return this.request('PUT', `/instances/${id}`, spec);
  }
  restart(id: string): Promise<ServiceInstance> {
    return this.request('POST', `/instances/${id}/restart`);
  }
  stop(id: string): Promise<ServiceInstance> {
    return this.request('POST', `/instances/${id}/stop`);
  }
  remove(id: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/instances/${id}`);
  }

  contact(id: string, phone: string): Promise<{ exists: boolean; chatId: string | null }> {
    return this.request('POST', `/instances/${id}/contact`, { phone });
  }

  /** Telegram: собеседник по логину (`contacts.resolveUsername`), без отправки сообщения. */
  contactByLogin(id: string, login: string): Promise<{ exists: boolean; chatId: string | null }> {
    return this.request('POST', `/instances/${id}/contact`, { login });
  }

  send(id: string, to: string, text: string, quotedId?: string, media?: { mime: string; name: string; data: Buffer }): Promise<WireMessage> {
    return this.request('POST', `/instances/${id}/send`, { to, text, quotedId, ...(media ? { media: { mime: media.mime, name: media.name, data: media.data.toString('base64') } } : {}) }, media ? 120_000 : undefined);
  }
  /** Фото профиля собеседника в хранилище сервиса (для аватара в открытой линии); нет — null. */
  async avatar(id: string, chatId: string): Promise<WireMedia | null> {
    return (await this.request<{ media: WireMedia | null }>('POST', `/instances/${id}/avatar`, { chat: chatId }, 25_000)).media;
  }
  /** Имена участников и названия групп по ID (неизвестных нет в ответе). */
  async names(id: string, ids: string[]): Promise<Record<string, string>> {
    if (!ids.length) return {};
    return (await this.request<{ names: Record<string, string> }>('POST', `/instances/${id}/names`, { ids }, 25_000)).names ?? {};
  }
  /** Вложение сообщения (скачать в хранилище сервиса, если ещё нет). */
  mediaOf(id: string, messageId: string): Promise<WireMedia> {
    return this.request('POST', `/instances/${id}/media`, { id: messageId }, 120_000);
  }
  async readMedia(id: string, fileId: string): Promise<{ data: Buffer; mime: string } | null> {
    const res = await fetch(`${this.base}/instances/${id}/media/${fileId}`, { headers: this.headers(), signal: AbortSignal.timeout(120_000) }).catch(() => null);
    return res?.ok ? { data: Buffer.from(await res.arrayBuffer()), mime: res.headers.get('content-type') ?? 'application/octet-stream' } : null;
  }
  edit(id: string, messageId: string, text: string): Promise<WireMessage> {
    return this.request('POST', `/instances/${id}/edit`, { id: messageId, text });
  }
  deleteMessage(id: string, messageId: string, everyone = true): Promise<{ ok: boolean }> {
    return this.request('POST', `/instances/${id}/delete`, { id: messageId, everyone });
  }
  history(id: string, chats = 30, perChat = 30): Promise<WireMessage[]> {
    return this.request('GET', `/instances/${id}/history?chats=${chats}&perChat=${perChat}`);
  }

  screenFiles(id: string): Promise<MessengerScreenFilesDto> {
    return this.request('GET', `/instances/${id}/screen-files`);
  }
  uploadScreenFile(id: string, f: { mime: string; name: string; data: Buffer }): Promise<MessengerScreenFilesDto> {
    return this.request('POST', `/instances/${id}/screen-files`, { mime: f.mime, name: f.name, data: f.data.toString('base64') }, 120_000);
  }
  removeScreenFile(id: string, fileId: string): Promise<MessengerScreenFilesDto> {
    return this.request('DELETE', `/instances/${id}/screen-files/${fileId}`);
  }
  /** Подставить файл в следующее окно выбора файла на экране мессенджера. */
  offerScreenFile(id: string, fileId: string): Promise<MessengerScreenFilesDto> {
    return this.request('POST', `/instances/${id}/screen-files/${fileId}/attach`);
  }
  /** Вставить на экран: текст — в поле под курсором, файл экрана — событием «вставить» в открытый чат. */
  screenPaste(id: string, what: { text: string } | { fileId: string }): Promise<{ ok: boolean }> {
    return this.request('POST', `/instances/${id}/screen-paste`, what);
  }
  cancelScreenOffer(id: string): Promise<MessengerScreenFilesDto> {
    return this.request('DELETE', `/instances/${id}/screen-files`);
  }

  async screenshot(id: string): Promise<Buffer | null> {
    const res = await fetch(`${this.base}/instances/${id}/screenshot`, { headers: this.headers(), signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => null);
    return res?.ok ? Buffer.from(await res.arrayBuffer()) : null;
  }
}
