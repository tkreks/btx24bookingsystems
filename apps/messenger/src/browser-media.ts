/** Выполняется Puppeteer внутри WA Web, без ссылок на Node-модули/внешние переменные. */
export async function cachedMediaFromBrowser(id: string, maxBytes: number): Promise<{ mimetype: string; filename?: string | null; data: string } | null> {
  type Message = Record<string, unknown> & { mimetype?: string; filename?: string; size?: number; mediaData?: { mediaBlob?: { getBlob: () => Blob | Promise<Blob> } } };
  const wa = globalThis as unknown as {
    require: (name: string) => { Msg?: { get: (id: string) => Message | undefined }; downloadManager?: { downloadAndMaybeDecrypt: (params: Record<string, unknown>) => Promise<ArrayBuffer> } };
    WWebJS: { arrayBufferToBase64Async: (buffer: ArrayBuffer) => Promise<string> };
  };
  const msg = wa.require('WAWebCollections').Msg?.get(id);
  if (!msg) return null;
  if ((msg.size ?? 0) > maxBytes) throw new Error('Файл больше 64 МБ');
  const cached = msg.mediaData?.mediaBlob;
  let bytes: ArrayBuffer; let mime = msg.mimetype || 'application/octet-stream';
  if (cached) {
    const blob = await cached.getBlob(); if (!blob?.size) return null;
    if (blob.size > maxBytes) throw new Error('Файл больше 64 МБ');
    bytes = await blob.arrayBuffer(); mime = msg.mimetype || blob.type || mime;
  } else {
    const manager = wa.require('WAWebDownloadManager').downloadManager;
    if (!manager) return null;
    // Современный WA требует mimetype: whatsapp-web.js 1.34.7 его не передаёт (InvalidMediaFileType).
    const qpl = { addAnnotations() { return this; }, addPoint() { return this; } };
    bytes = await manager.downloadAndMaybeDecrypt({ directPath: msg.directPath, encFilehash: msg.encFilehash, filehash: msg.filehash,
      mediaKey: msg.mediaKey, mediaKeyTimestamp: msg.mediaKeyTimestamp, type: msg.type, mimetype: msg.mimetype,
      signal: AbortSignal.timeout(60_000), downloadQpl: qpl });
  }
  if (bytes.byteLength > maxBytes) throw new Error('Файл больше 64 МБ');
  return { mimetype: mime, filename: msg.filename ?? null, data: await wa.WWebJS.arrayBufferToBase64Async(bytes) };
}
