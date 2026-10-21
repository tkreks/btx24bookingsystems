import {
  authorKind,
  connectorOf,
  crmLinksOf,
  lastMeaningful,
  plainText,
  preview,
  toMessageDto,
} from './chat-parsing.js';

describe('chat parsing', () => {
  it('extracts the connector and drops the portal hash suffix', () => {
    expect(connectorOf('wz_whatsapp_ceacd473beec8c39f54fd7afd810cd43d|12|abc|7')).toBe('wz_whatsapp');
    expect(connectorOf('telegrambot|3|55|9')).toBe('telegrambot');
    expect(connectorOf(null)).toBe('');
  });
  it('parses CRM bindings', () => {
    expect(crmLinksOf('LEAD|0|COMPANY|0|CONTACT|140|DEAL|678')).toEqual({
      leadId: null,
      contactId: 140,
      companyId: null,
      dealId: 678,
    });
    expect(crmLinksOf('')).toEqual({ leadId: null, contactId: null, companyId: null, dealId: null });
  });
  it('classifies authors', () => {
    const users = [{ id: 5, connector: true }, { id: 6, bot: true }, { id: 7 }];
    expect([authorKind(0, users), authorKind(5, users), authorKind(6, users), authorKind(7, users)]).toEqual([
      'system',
      'client',
      'bot',
      'employee',
    ]);
  });
  it('skips system messages when deciding who wrote last', () => {
    const users = [{ id: 5, connector: true }];
    const got = lastMeaningful(
      [
        { id: 3, author_id: 0, date: 'c' },
        { id: 2, author_id: 5, date: 'b' },
        { id: 1, author_id: 7, date: 'a' },
      ],
      users,
    );
    expect(got).toMatchObject({ kind: 'client', message: { id: 2 } });
    expect(lastMeaningful([{ id: 1, author_id: 0, date: 'a' }], users)).toMatchObject({ kind: 'system' });
    expect(lastMeaningful([], users)).toBeNull();
  });
  it('strips messenger BB codes', () => {
    expect(plainText('[b]Здравствуйте[/b], [USER=7]Анна[/USER]! [URL=https://x.ru]ссылка[/URL]')).toBe(
      'Здравствуйте, Анна! ссылка',
    );
    expect(preview('a'.repeat(200), 10)).toBe(`${'a'.repeat(9)}…`);
  });
  it('maps a message with its files', () => {
    const dto = toMessageDto(
      { id: 9, author_id: 5, date: 'd', text: 'Фото', params: { FILE_ID: [44] } },
      [{ id: 5, name: 'Клиент', connector: true }],
      [
        { id: 44, name: 'a.jpg', size: 10, type: 'image', urlPreview: 'p', urlDownload: 'u' },
        { id: 45, name: 'other' },
      ],
    );
    expect(dto).toEqual({
      id: 9,
      date: 'd',
      author: { id: 5, name: 'Клиент', kind: 'client' },
      text: 'Фото',
      files: [{ id: 44, name: 'a.jpg', size: 10, type: 'image', previewUrl: 'p', url: 'u' }],
    });
  });
});
