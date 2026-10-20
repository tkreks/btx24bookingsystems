import { encodeParams } from './encode-params.js';
import { Bitrix24Error, RATE_LIMIT_CODES, TOKEN_EXPIRED_CODES } from './errors.js';
import type { RateLimiter } from './rate-limiter.js';
import { isReadMethod } from './read-only.js';

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
  allows(method: string, params: Record<string, unknown>): Promise<boolean>;
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
}

const METHOD_RE = /^[a-z][a-z0-9_.]*$/i;
const BATCH_MAX = 50;

/**
 * Единый клиент REST Битрикс24 (AGENTS.md: прямые вызовы портала из доменных модулей запрещены).
 * Повторяет только то, что портал гарантированно не выполнил: `QUERY_LIMIT_EXCEEDED` и
 * `expired_token`. Сетевые ошибки и таймауты НЕ повторяются — иначе `*.add` мог бы создать дубль.
 */
export class Bitrix24RestClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: RestClientOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<RestResponse<T>> {
    if (!METHOD_RE.test(method)) throw new Bitrix24Error('INVALID_METHOD', `Invalid REST method name: ${method}`);
    const viaPolicy = await this.assertAllowed(method, params);
    let token = await this.opts.access.getAccessToken();
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      await this.opts.limiter.acquire(this.opts.limiterKey);
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

  /** true — вызов разрешён только благодаря песочнице (после успеха его надо записать в журнал). */
  private async assertAllowed(method: string, params: Record<string, unknown>): Promise<boolean> {
    if (method === 'batch' || !this.opts.readOnly || isReadMethod(method)) return false; // команды пакета проверяет batch()
    if (this.opts.writePolicy && (await this.opts.writePolicy.allows(method, params))) return true;
    throw new Bitrix24Error('READ_ONLY_MODE', `${method} is blocked: Bitrix24 integration is in read-only mode (B24_READ_ONLY)`);
  }

  private assertReadable(method: string): void {
    if (this.opts.readOnly && !isReadMethod(method)) {
      throw new Bitrix24Error('READ_ONLY_MODE', `${method} is blocked: Bitrix24 integration is in read-only mode (B24_READ_ONLY)`);
    }
  }

  private async post(method: string, payload: Record<string, unknown>) {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.clientEndpoint.replace(/\/?$/, '/')}${method}.json`, {
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
