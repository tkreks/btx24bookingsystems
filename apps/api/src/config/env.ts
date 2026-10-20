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
  /** Каталог собранного apps/web; если не задан — статика не раздаётся (dev-режим через Vite). */
  WEB_DIST_DIR: optionalString(z.string()),
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
