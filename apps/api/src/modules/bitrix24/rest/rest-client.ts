import { encodeParams } from './encode-params.js';
import { Bitrix24Error, CLIENT_GONE, isClientGone, RATE_LIMIT_CODES, TOKEN_EXPIRED_CODES } from './errors.js';
import type { RateLimiter } from './rate-limiter.js';
import { isReadMethod } from './read-only.js';
import { clientGone, countRest } from '../../../common/cache-invalidation.js';

/** Источник access-токена. Для токенов приложения умеет обновлять, для токена пользователя — нет. */
export interface AccessProvider {
  getAccessToken(): Promise<string>;
  /** Вызывается после `expired_token`; возвращает новый токен или бросает ошибку. */
  refresh(expiredToken: string): Promise<string>;
}

/**
 * Исключения из режима только чтения (песочница). `allows` — разрешён ли изменяющий вызов с этими
 * параметрами; `recorded` — после успешного вызова (журнал созданного).
 */
export interface WritePolicy {
  /** `scope` — проверенный клиентом контекст операции (объединение дублей контактов), иначе нет. */
  allows(method: string, params: Record<string, unknown>, scope?: WriteScope): Promise<boolean>;
  recorded(method: string, params: Record<string, unknown>, result: unknown): Promise<void>;
}

export interface RestResponse<T = unknown> {
  result: T;
  total?: number;
  next?: number;
}

export interface BatchCommand {
  method: string;
  params?: Record<string, unknown>;
}

export interface BatchResult {
  result: Record<string, unknown>;
  errors: Record<string, { error: string; error_description?: string }>;
  total: Record<string, number>;
  next: Record<string, number>;
}

export interface RestClientOptions {
  /** База REST портала, например https://portal.bitrix24.ru/rest/ */
  clientEndpoint: string;
  access: AccessProvider;
  limiter: RateLimiter;
  /** Ключ лимитера — member_id портала. */
  limiterKey: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRateLimitRetries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  /** Отклонять изменяющие методы (B24_READ_ONLY). */
  readOnly?: boolean;
  /** Точечные исключения из readOnly (песочница записи). */
  writePolicy?: WritePolicy;
  /** Запрос окончательно не удался (после повторов) — для журнала действий. */
  onFailure?: (f: RestFailure) => void;
}

/** Кто делал запрос (сотрудник — для токена пользователя; нет — приложение). */
export interface RestActor {
  userId: number;
  name: string;
}

/** Неудавшийся запрос: метод, код ошибки, изменяющий ли он, кто делал. */
export interface RestFailure {
  method: string;
  code: string;
  message: string;
  write: boolean;
  actor: RestActor | null;
}

const METHOD_RE = /^[a-z][a-z0-9_.]*$/i;

/** Чтение: метод на чтение или пакет только из чтений (команды batch — строки `method?query`). */
function readOnlyCall(method: string, params: Record<string, unknown>): boolean {
  if (method !== 'batch') return isReadMethod(method);
  const cmd = params.cmd;
  return !!cmd && typeof cmd === 'object' && Object.values(cmd).every((c) => typeof c === 'string' && isReadMethod(c.split('?')[0]!));
}

/**
 * Объединение дублей контактов (решение владельца 2026-10-30, ADR 0022) — единственное исключение из
 * запрета правки контактов. Разрешение выдаётся на конкретный набор контактов (основной — первый) и
 * пропускает через `client.callContactMerge` только: `crm.contact.update` этих контактов без
 * PHONE/EMAIL/IM/WEB и один `crm.entity.mergeBatch` (entityTypeId 3, ровно эти ID в этом порядке).
 * Создаёт его только `contacts/contact-merge.service.ts` (после PermanentAdminGuard).
 */
export class ContactMergeGrant {
  readonly ids: readonly number[];
  private merged = false;

  constructor(primaryId: number, ids: readonly number[]) {
    const rest = ids.filter((id) => id !== primaryId);
    const all = [primaryId, ...rest];
    if (!all.every((id) => Number.isSafeInteger(id) && id > 0) || new Set(all).size !== all.length || rest.length < 1 || rest.length !== ids.length - 1 || all.length > 10)
      throw new Bitrix24Error('CONTACT_WRITE_DISABLED', 'Неверный набор контактов для объединения');
    this.ids = Object.freeze(all);
  }

  get scope(): WriteScope {
    return { kind: 'contact-merge', ids: this.ids };
  }

  /** Бросает CONTACT_WRITE_DISABLED, если вызов выходит за рамки объединения. */
  check(method: string, params: Record<string, unknown>): void {
    const deny = (why: string) => {
      throw new Bitrix24Error('CONTACT_WRITE_DISABLED', `Объединение контактов: ${why}`);
    };
    if (this.merged) deny('разрешение уже использовано');
    const m = method.toLowerCase();
    if (m === 'crm.contact.update') {
      if (!this.ids.includes(Number(params.id)) || !/^\d+$/.test(String(params.id ?? ''))) deny('контакт не из объединяемой группы');
      const fields = params.fields;
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) deny('нет полей');
      for (const key of Object.keys(fields as object)) if (CONTACT_MULTI_FIELDS.has(key.toUpperCase()) || !/^[A-Z0-9_]+$/.test(key)) deny(`поле ${key} не меняется`);
      return;
    }
    if (m === 'crm.entity.mergebatch') {
      const p = (params.params ?? {}) as Record<string, unknown>;
      const ids = Array.isArray(p.entityIds) ? p.entityIds.map(Number) : [];
      if (Number(p.entityTypeId) !== 3 || ids.length !== this.ids.length || ids.some((id, i) => id !== this.ids[i])) deny('другие контакты');
      this.merged = true;
      return;
    }
    deny(`метод ${method} недоступен`);
  }
}

/** Контекст изменяющего вызова, проверенный клиентом (для WritePolicy). */
export type WriteScope = { kind: 'contact-merge'; ids: readonly number[] };

/** Множественные поля контакта: при объединении Битрикс24 их складывает сам, приложение их не пишет. */
const CONTACT_MULTI_FIELDS = new Set(['PHONE', 'EMAIL', 'IM', 'WEB', 'LINK']);

/** Контакты пока только читаем — явное решение владельца 2026-10-28, независимо от песочницы. */
export function assertContactsReadOnly(method: string, params: Record<string, unknown>): void {
  const m = method.toLowerCase();
  // Объединение удаляет записи CRM — только через ContactMergeGrant (callContactMerge).
  if (m === 'crm.entity.mergebatch') throw new Bitrix24Error('CONTACT_WRITE_DISABLED', 'Объединение записей CRM доступно только из окна объединения дублей контактов');
  if (/^crm\.contact\.(add|update|delete)$/.test(m) || (/^crm\.item\.(add|update|delete)$/.test(m) && Number(params.entityTypeId ?? params.ENTITY_TYPE_ID) === 3)) {
    throw new Bitrix24Error('CONTACT_WRITE_DISABLED', 'Редактирование контактов приложением пока не разрешено владельцем');
  }
  if (m === 'batch' && params.cmd && typeof params.cmd === 'object') {
    for (const command of Object.values(params.cmd)) if (typeof command === 'string') {
      const at = command.indexOf('?');
      const name = at < 0 ? command : command.slice(0, at);
      if (name.toLowerCase() === 'batch') throw new Bitrix24Error('CONTACT_WRITE_DISABLED', 'Вложенные пакеты недоступны');
      const query = new URLSearchParams(at < 0 ? '' : command.slice(at + 1));
      assertContactsReadOnly(name, Object.fromEntries(query));
    }
  }
}

const goneError = (method: string) => new Bitrix24Error(CLIENT_GONE, 'Клиент не дождался ответа — запрос к Битрикс24 не отправлялся', 499, { method });
const BATCH_MAX = 50;

/**
 * Единый клиент REST Битрикс24 (AGENTS.md: прямые вызовы портала из доменных модулей запрещены).
 * Повторяет только то, что портал гарантированно не выполнил: `QUERY_LIMIT_EXCEEDED` и
 * `expired_token`. Сетевые ошибки и таймауты НЕ повторяются — иначе `*.add` мог бы создать дубль.
 */
export class Bitrix24RestClient {
  /** Сотрудник, чьим токеном идут запросы (ставит проверка токена) — для журнала ошибок. */
  actor: RestActor | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: RestClientOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<RestResponse<T>> {
    return this.run<T>(method, params);
  }

  /**
   * Запись в рамках объединения дублей контактов (`ContactMergeGrant`): единственный путь, которым
   * приложение меняет контакты. Разрешение проверяется до сети; при B24_READ_ONLY вызов дополнительно
   * должна пропустить песочница (`WritePolicy` получает `scope`).
   */
  async callContactMerge<T = unknown>(grant: ContactMergeGrant, method: string, params: Record<string, unknown>): Promise<RestResponse<T>> {
    if (!(grant instanceof ContactMergeGrant)) throw new Bitrix24Error('CONTACT_WRITE_DISABLED', 'Нет разрешения на объединение контактов');
    grant.check(method, params);
    return this.run<T>(method, params, grant.scope);
  }

  private async run<T>(method: string, params: Record<string, unknown>, scope?: WriteScope): Promise<RestResponse<T>> {
    try {
      return await this.callOnce<T>(method, params, scope);
    } catch (err) {
      if (err instanceof Bitrix24Error && !isClientGone(err) && this.opts.onFailure)
        try {
          this.opts.onFailure({ method, code: String(err.code), message: err.message, write: method !== 'batch' && !isReadMethod(method), actor: this.actor });
        } catch {
          /* журнал не должен ломать запрос */
        }
      throw err;
    }
  }

  private async callOnce<T>(method: string, params: Record<string, unknown>, scope?: WriteScope): Promise<RestResponse<T>> {
    if (!METHOD_RE.test(method)) throw new Bitrix24Error('INVALID_METHOD', `Invalid REST method name: ${method}`);
    const viaPolicy = await this.assertAllowed(method, params, scope);
    // Чтение для ушедшего клиента не отправляем; запись — всегда до конца (журнал операций, компенсация).
    const cancelled = readOnlyCall(method, params) ? clientGone : undefined;
    let token = await this.opts.access.getAccessToken();
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const queued = Date.now();
      if (!(await this.opts.limiter.acquire(this.opts.limiterKey, cancelled))) throw goneError(method);
      countRest(method, Date.now() - queued);
      const body = await this.post(method, { ...params, auth: token });
      if (!body.error) {
        if (viaPolicy) await this.opts.writePolicy!.recorded(method, params, body.result);
        return { result: body.result as T, total: body.total, next: body.next };
      }

      const code = String(body.error);
      if (TOKEN_EXPIRED_CODES.has(code) && !refreshed) {
        token = await this.opts.access.refresh(token);
        refreshed = true;
        continue;
      }
      if (RATE_LIMIT_CODES.has(code) && attempt < (this.opts.maxRateLimitRetries ?? 5)) {
        await this.sleep((this.opts.retryDelayMs ?? 800) * (attempt + 1));
        continue;
      }
      throw new Bitrix24Error(code, body.error_description ?? code, body.httpStatus, { method });
    }
  }

  /**
   * Метод REST 3.0 (`/rest/api/<method>`, JSON-тело, токен — в `auth`): ответ `{ result: { items | item } }`,
   * ошибка — `{ error: { code, message } }`. Пока только чтение (история рабочего времени и т. п.).
   */
  async callV3<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!METHOD_RE.test(method)) throw new Bitrix24Error('INVALID_METHOD', `Invalid REST method name: ${method}`);
    if (!isReadMethod(method)) throw new Bitrix24Error('READ_ONLY_MODE', `${method}: REST 3.0 is used for reads only`);
    let token = await this.opts.access.getAccessToken();
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const queued = Date.now();
      if (!(await this.opts.limiter.acquire(this.opts.limiterKey, clientGone))) throw goneError(method);
      countRest(method, Date.now() - queued);
      const body = await this.post(`api/${method}`, { ...params, auth: token }, '');
      const err = body.error as unknown;
      if (!err) return body.result as T;
      // Общие ошибки REST приходят строкой (`expired_token`), ошибки REST 3.0 — объектом.
      const code = typeof err === 'object' && err !== null ? String((err as { code?: unknown }).code) : String(err);
      const v3 = typeof err === 'object' && err !== null ? (err as { message?: unknown; validation?: { field?: string; message?: string }[] }) : null;
      // Ошибка проверки запроса — с полями (что именно не так).
      const details = v3?.validation?.map((x) => `${x.field ?? ''}: ${x.message ?? ''}`).join('; ');
      const message = v3 ? `${String(v3.message ?? code)}${details ? ` (${details})` : ''}` : (body.error_description ?? code);
      if (TOKEN_EXPIRED_CODES.has(code) && !refreshed) {
        token = await this.opts.access.refresh(token);
        refreshed = true;
        continue;
      }
      if (RATE_LIMIT_CODES.has(code) && attempt < (this.opts.maxRateLimitRetries ?? 5)) {
        await this.sleep((this.opts.retryDelayMs ?? 800) * (attempt + 1));
        continue;
      }
      const e = new Bitrix24Error(code, message, body.httpStatus, { method });
      try {
        this.opts.onFailure?.({ method, code, message, write: false, actor: this.actor });
      } catch {
        /* журнал не должен ломать запрос */
      }
      throw e;
    }
  }

  /**
   * Пакет команд. Больше 50 команд режется на части, но только если команды независимы:
   * ссылки `$result[...]` между частями не работают.
   */
  async batch(commands: Record<string, BatchCommand>, opts: { halt?: boolean } = {}): Promise<BatchResult> {
    const entries = Object.entries(commands);
    if (entries.length > BATCH_MAX && entries.some(([, c]) => JSON.stringify(c.params ?? {}).includes('$result['))) {
      throw new Bitrix24Error('BATCH_TOO_LARGE', `Batch with $result references cannot exceed ${BATCH_MAX} commands`);
    }
    // Запись внутри batch песочница не разрешает: ссылки $result между командами не проверить.
    for (const [, c] of entries) this.assertReadable(c.method);
    const out: BatchResult = { result: {}, errors: {}, total: {}, next: {} };
    for (let i = 0; i < entries.length; i += BATCH_MAX) {
      const cmd: Record<string, string> = {};
      for (const [key, c] of entries.slice(i, i + BATCH_MAX)) {
        if (!METHOD_RE.test(c.method)) throw new Bitrix24Error('INVALID_METHOD', `Invalid REST method name: ${c.method}`);
        const qs = encodeParams(c.params ?? {});
        cmd[key] = qs ? `${c.method}?${qs}` : c.method;
      }
      const res = await this.call<{
        result?: Record<string, unknown> | unknown[];
        result_error?: Record<string, { error: string; error_description?: string }> | unknown[];
        result_total?: Record<string, number> | unknown[];
        result_next?: Record<string, number> | unknown[];
      }>('batch', { halt: opts.halt ? 1 : 0, cmd });
      const r = res.result ?? {};
      Object.assign(out.result, asRecord(r.result));
      Object.assign(out.errors, asRecord(r.result_error));
      Object.assign(out.total, asRecord(r.result_total));
      Object.assign(out.next, asRecord(r.result_next));
      if (opts.halt && Object.keys(out.errors).length) break;
    }
    return out;
  }

  /** Все страницы списочного метода (`start`/`next`, шаг портала — 50). */
  async listAll<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    opts: { max?: number; pick?: (result: unknown) => T[] } = {},
  ): Promise<T[]> {
    const max = opts.max ?? 5000;
    const pick = opts.pick ?? ((r: unknown) => (Array.isArray(r) ? (r as T[]) : []));
    const items: T[] = [];
    let start: number | undefined = 0;
    while (start !== undefined && items.length < max) {
      const res: RestResponse = await this.call(method, { ...params, start });
      items.push(...pick(res.result));
      start = res.next;
    }
    return items.slice(0, max);
  }

  /**
   * Скачать файл по одноразовой ссылке портала (`downloadUrl` из REST, токен уже в ссылке). Только
   * хост самого портала — ссылку не подменить на чужой адрес; больше `maxBytes` — ошибка (поток
   * прерывается, не дочитывая). `redirects: 'portal'` — перенаправления проходим сами (до 4) и каждое
   * проверяем тем же правилом: уйти с портала (CDN, внутренняя сеть) нельзя. Без него — как раньше
   * (`fetch` по умолчанию).
   */
  async download(url: string, maxBytes = 50 * 1024 * 1024, opts: { redirects?: 'follow' | 'portal' } = {}): Promise<{ data: Buffer; contentType: string | null }> {
    const portal = new URL(this.opts.clientEndpoint);
    const onPortal = (raw: string, base?: URL): URL => {
      let target: URL;
      try {
        target = new URL(raw, base);
      } catch {
        throw new Bitrix24Error('INVALID_DOWNLOAD_URL', 'Download URL is malformed');
      }
      if (target.host !== portal.host || target.protocol !== portal.protocol || target.username || target.password)
        throw new Bitrix24Error('INVALID_DOWNLOAD_URL', 'Download URL is not on the portal host');
      return target;
    };
    let target = onPortal(url);
    const manual = opts.redirects === 'portal';
    let res: Response | undefined;
    for (let hop = 0; ; hop++) {
      try {
        res = await this.fetchImpl(target, { signal: AbortSignal.timeout(60_000), ...(manual ? { redirect: 'manual' as const } : {}) });
      } catch (err) {
        throw new Bitrix24Error('NETWORK_ERROR', `Download failed: ${(err as Error).message}`);
      }
      if (!manual || ![301, 302, 303, 307, 308].includes(res.status)) break;
      const next = res.headers.get('location');
      await res.body?.cancel();
      if (!next) throw new Bitrix24Error('DOWNLOAD_FAILED', 'Redirect without location', res.status);
      if (hop >= 3) throw new Bitrix24Error('DOWNLOAD_FAILED', 'Too many redirects', res.status);
      target = onPortal(next, target);
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new Bitrix24Error('DOWNLOAD_FAILED', `Download failed: HTTP ${res.status}`, res.status);
    }
    if (Number(res.headers.get('content-length') ?? 0) > maxBytes) {
      await res.body?.cancel();
      throw new Bitrix24Error('FILE_TOO_LARGE', 'File is too large');
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = res.body?.getReader();
    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) {
            await reader.cancel();
            throw new Bitrix24Error('FILE_TOO_LARGE', 'File is too large');
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    return { data: Buffer.concat(chunks, size), contentType: res.headers.get('content-type') };
  }

  /** true — вызов разрешён только благодаря песочнице (после успеха его надо записать в журнал). */
  private async assertAllowed(method: string, params: Record<string, unknown>, scope?: WriteScope): Promise<boolean> {
    // scope приходит только из callContactMerge, где ContactMergeGrant уже проверил вызов.
    if (!scope) assertContactsReadOnly(method, params);
    if (method === 'batch' || !this.opts.readOnly || isReadMethod(method)) return false; // команды пакета проверяет batch()
    if (this.opts.writePolicy && (await this.opts.writePolicy.allows(method, params, scope))) return true;
    throw new Bitrix24Error('READ_ONLY_MODE', `${method} is blocked: Bitrix24 integration is in read-only mode (B24_READ_ONLY)`);
  }

  private assertReadable(method: string): void {
    if (this.opts.readOnly && !isReadMethod(method)) {
      throw new Bitrix24Error('READ_ONLY_MODE', `${method} is blocked: Bitrix24 integration is in read-only mode (B24_READ_ONLY)`);
    }
  }

  private async post(method: string, payload: Record<string, unknown>, suffix = '.json') {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.clientEndpoint.replace(/\/?$/, '/')}${method}${suffix}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
      });
    } catch (err) {
      throw new Bitrix24Error('NETWORK_ERROR', `Bitrix24 request failed: ${(err as Error).message}`, undefined, { method });
    }
    const text = await res.text();
    let body: { result?: unknown; error?: string; error_description?: string; total?: number; next?: number };
    // REST 3.0 отдаёт ошибку объектом { code, message } — тип шире, разбирает callV3.
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new Bitrix24Error('ERROR_UNEXPECTED_ANSWER', `Bitrix24 returned non-JSON (HTTP ${res.status})`, res.status, { method });
    }
    if (!res.ok && !body.error) {
      throw new Bitrix24Error('HTTP_ERROR', `Bitrix24 HTTP ${res.status}`, res.status, { method });
    }
    return { ...body, httpStatus: res.status };
  }
}

/** Битрикс24 отдаёт пустые словари как `[]` — нормализуем. */
function asRecord<T>(v: Record<string, T> | unknown[] | undefined): Record<string, T> {
  return v && !Array.isArray(v) ? v : {};
}
