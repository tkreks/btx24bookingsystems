import { z } from 'zod';

// docker compose передаёт незаданные переменные как пустую строку — считаем её «не задано».
const optionalString = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

// Единая точка описания переменных окружения api. Новая переменная = новая строка здесь +
// запись в корневом .env.example. Прямой доступ к process.env вне этого файла запрещён.
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  /** Публичный HTTPS-адрес приложения — его указывают в настройках приложения Битрикс24. */
  APP_BASE_URL: optionalString(z.string().url()),
  /** Ключ шифрования токенов порталов: 32 байта в base64 (`openssl rand -base64 32`). */
  ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes encoded as base64'),
  /** client_id / client_secret локального приложения (форма приложения на портале). */
  B24_CLIENT_ID: optionalString(z.string()),
  B24_CLIENT_SECRET: optionalString(z.string()),
  /**
   * Хосты серверов авторизации, которым доверяем (через запятую): облако — oauth.bitrix.info,
   * российское облако (*.bitrix24.ru) — oauth.bitrix24.tech; для «коробки» сервер авторизации —
   * сам портал, его домен добавляется сюда явно.
   */
  B24_TRUSTED_OAUTH_HOSTS: z
    .string()
    .default('oauth.bitrix.info,oauth.bitrix24.tech')
    .transform((v) => v.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)),
  /**
   * Только чтение данных портала: изменяющие методы REST отклоняются до запроса. По умолчанию
   * включено — изменения на боевом портале разрешаются явно (`B24_READ_ONLY=false`).
   */
  B24_READ_ONLY: z
    .enum(['true', 'false', '1', '0'])
    .default('true')
    .transform((v) => v === 'true' || v === '1'),
  /**
   * Песочница записи при B24_READ_ONLY=true (решение владельца): изменения разрешены только по
   * этим сделкам и для броней в периоде [FROM, TO) — даты в поясе портала. Пусто — выключена.
   */
  B24_SANDBOX_DEAL_IDS: z
    .string()
    .default('')
    .refine((v) => /^(\d+(,\d+)*)?$/.test(v.replace(/\s/g, '')), 'comma-separated deal ids'),
  B24_SANDBOX_BOOKINGS_FROM: optionalString(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  B24_SANDBOX_BOOKINGS_TO: optionalString(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  /**
   * Лимит REST-запросов к одному порталу: устойчивая скорость и всплеск. Битрикс24 — «дырявое
   * ведро» (~50 запросов в запасе, 2 в секунду); api и worker считают отдельно, поэтому всплеск у
   * каждого — 30 (запас 10 давал очередь: дашборд ждал за списком чатов до 16 секунд).
   * Превышение портал отвечает `QUERY_LIMIT_EXCEEDED` — клиент повторяет с паузой.
   */
  B24_RATE_PER_SEC: z.coerce.number().positive().default(2),
  B24_RATE_BURST: z.coerce.number().int().positive().default(30),
  /** Сервис мессенджеров (ADR 0014) — внутренний адрес в сети стенда. */
  MESSENGER_URL: z.string().url().default('http://messenger:3090'),
  /** Общий секрет api ↔ messenger (заголовок x-messenger-token); пусто — защищает только сеть стенда. */
  MESSENGER_TOKEN: optionalString(z.string().min(16)),
});

const withSandbox = envSchema.transform((e) => {
  const dealIds = e.B24_SANDBOX_DEAL_IDS.replace(/\s/g, '').split(',').filter(Boolean).map(Number);
  const range = e.B24_SANDBOX_BOOKINGS_FROM && e.B24_SANDBOX_BOOKINGS_TO ? { bookingsFrom: e.B24_SANDBOX_BOOKINGS_FROM, bookingsTo: e.B24_SANDBOX_BOOKINGS_TO } : { bookingsFrom: null, bookingsTo: null };
  const B24_SANDBOX = dealIds.length || range.bookingsFrom ? { dealIds, ...range } : null;
  return { ...e, B24_SANDBOX };
});

export type Env = z.infer<typeof withSandbox>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = withSandbox.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${issues}`);
  }
  return parsed.data;
}
