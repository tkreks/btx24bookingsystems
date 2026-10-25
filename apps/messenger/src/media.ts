import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';

/** Вложение сообщения: где лежит у сервиса и что это. */
export interface WireMedia {
  /** Имя файла в хранилище сервиса (хеш экземпляра и ID сообщения). */
  fileId: string;
  mime: string;
  name: string | null;
  size: number;
}

/** Больше не скачиваем (видео WhatsApp — до 2 ГБ у документов; разумный предел для переписки). */
export const MAX_MEDIA_BYTES = 64 * 1024 * 1024;
const FILE_RE = /^[0-9a-f]{40}$/;

/**
 * Вложения переписки — в томе сервиса (`/data/media/<экземпляр>/<fileId>` + `.json` с описанием), а не
 * в базе приложения: фото и видео не раздувают её. Имя — хеш ID сообщения: повтор не дублирует файл.
 */
export class MediaStore {
  constructor(private readonly dataDir: string) {}

  fileIdOf(instanceId: string, messageId: string): string {
    return createHash('sha1').update(`${instanceId}:${messageId}`).digest('hex');
  }

  private dir(instanceId: string) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(instanceId)) throw new Error('invalid instance id');
    return `${this.dataDir}/media/${instanceId}`;
  }

  async save(instanceId: string, messageId: string, m: { mimetype: string; data: string; filename?: string | null }): Promise<WireMedia> {
    if (m.data.length > Math.ceil(MAX_MEDIA_BYTES / 3) * 4) throw new Error('media exceeds 64 MB');
    const fileId = this.fileIdOf(instanceId, messageId);
    const data = Buffer.from(m.data, 'base64');
    if (data.length > MAX_MEDIA_BYTES) throw new Error('media exceeds 64 MB');
    const meta: WireMedia = { fileId, mime: m.mimetype || 'application/octet-stream', name: m.filename ?? null, size: data.length };
    await mkdir(this.dir(instanceId), { recursive: true });
    await writeFile(`${this.dir(instanceId)}/${fileId}`, data);
    await writeFile(`${this.dir(instanceId)}/${fileId}.json`, JSON.stringify(meta));
    return meta;
  }

  async meta(instanceId: string, fileId: string): Promise<WireMedia | null> {
    if (!FILE_RE.test(fileId)) return null;
    try { return JSON.parse(await readFile(`${this.dir(instanceId)}/${fileId}.json`, 'utf8')) as WireMedia; } catch { return null; }
  }

  /** Файл по ключу (например, аватар собеседника), если сохранён не раньше `maxAgeMs` назад. */
  async recent(instanceId: string, key: string, maxAgeMs: number, now = Date.now()): Promise<WireMedia | null> {
    const fileId = this.fileIdOf(instanceId, key);
    const meta = await this.meta(instanceId, fileId);
    if (!meta) return null;
    const st = await stat(`${this.dir(instanceId)}/${fileId}`).catch(() => null);
    return st && now - st.mtimeMs < maxAgeMs ? meta : null;
  }

  async read(instanceId: string, fileId: string): Promise<{ meta: WireMedia; data: Buffer } | null> {
    const meta = await this.meta(instanceId, fileId);
    if (!meta) return null;
    const data = await readFile(`${this.dir(instanceId)}/${fileId}`).catch(() => null);
    return data ? { meta, data } : null;
  }
}

/** Имя файла по умолчанию по типу (фото и голосовые приходят без имени). */
export function defaultName(mime: string, type: string): string {
  const ext = (mime.split('/')[1] ?? 'bin').split(';')[0].replace('jpeg', 'jpg').replace('ogg', 'ogg').replace('quicktime', 'mov');
  const base = type === 'ptt' ? 'voice' : type === 'image' ? 'photo' : type === 'video' ? 'video' : type === 'sticker' ? 'sticker' : 'file';
  return `${base}.${ext}`;
}

/** Аватар собеседника перечитываем раз в неделю (ключ в хранилище — `avatar:<чат>`). */
export const AVATAR_TTL_MS = 7 * 24 * 3600_000;
export const avatarKey = (chatId: string) => `avatar:${chatId}`;
