/** Совместимость 1.34.7 с WA 2026: MediaModel.__x_id перекрывает ID нового сообщения при spread. */
export function patchWhatsAppUtils(source: string): string {
  if (source.includes('delete message.__x_id;')) return source;
  const marker = "        // Bot's won't reply if canonicalUrl is set (linking)";
  if (!source.includes(marker)) throw new Error('WhatsApp sendMessage changed: outgoing media compatibility patch needs review');
  return source.replace(marker, "        // MediaModel carries __x_id=undefined; it must not overwrite the outgoing Msg key.\n        delete message.__x_id;\n\n" + marker);
}
