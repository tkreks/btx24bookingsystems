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
   * Хосты серверов авторизации, которым доверяем (через запятую). Облако — oauth.bitrix.info;
   * для «коробки» сервер авторизации — сам портал, его домен добавляется сюда явно.
   */
  B24_TRUSTED_OAUTH_HOSTS: z
    .string()
    .default('oauth.bitrix.info')
    .transform((v) => v.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)),
  /**
   * Только чтение данных портала: изменяющие методы REST отклоняются до запроса. По умолчанию
   * включено — изменения на боевом портале разрешаются явно (`B24_READ_ONLY=false`).
   */
  B24_READ_ONLY: z
    .enum(['true', 'false', '1', '0'])
    .default('true')
    .transform((v) => v === 'true' || v === '1'),
  /** Лимит REST-запросов к одному порталу: устойчивая скорость и всплеск. */
  B24_RATE_PER_SEC: z.coerce.number().positive().default(2),
  B24_RATE_BURST: z.coerce.number().int().positive().default(10),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${issues}`);
  }
  return parsed.data;
}
