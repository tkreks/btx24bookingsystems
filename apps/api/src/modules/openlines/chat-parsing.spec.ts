import {
  authorKind,
  connectorOf,
  crmLinksOf,
  lastMeaningful,
  messageKind,
  messageText,
  phoneOutgoing,
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
  it('skips system and bot messages when deciding who wrote last (the Bitrix24 dialog list rule)', () => {
    const users = [
      { id: 5, connector: true },
      { id: 6, bot: true },
    ];
    const got = lastMeaningful(
      [
        { id: 4, author_id: 0, date: 'd' },
        { id: 3, author_id: 6, date: 'c' },
        { id: 2, author_id: 5, date: 'b' },
        { id: 1, author_id: 7, date: 'a' },
      ],
      users,
    );
    expect(got).toMatchObject({ kind: 'client', human: true, message: { id: 2 } });
    expect(lastMeaningful([{ id: 1, author_id: 0, date: 'a' }], users)).toMatchObject({ kind: 'system', human: false });
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

describe('сообщения менеджера с телефона (Wazzup)', () => {
  const users = [{ id: 900, name: 'Клиент Иван', connector: true }, { id: 42, name: 'Елена' }];
  const msg = (id: number, author_id: number, text: string) => ({ id, author_id, date: `2026-10-22T10:0${id}:00+03:00`, text });

  it('recognizes the marker and keeps the text', () => {
    expect(phoneOutgoing('=== Исходящее сообщение, автор: Телефон ===\nДобрый день!')).toEqual({ author: 'Телефон', text: 'Добрый день!' });
    expect(phoneOutgoing('=== Исходящее сообщение, автор: Елена ===')).toEqual({ author: 'Елена', text: '' });
    expect(phoneOutgoing('Здравствуйте, === Исходящее сообщение')).toBeNull();
    // ответ с телефона цитатой: сначала цитата клиента, потом метка и ответ
    expect(phoneOutgoing('>>У нас перенос, возможно то же самое?\n \n \n=== Исходящее сообщение, автор: Телефон ===\nхорошо')).toEqual({
      author: 'Телефон',
      text: '>>У нас перенос, возможно то же самое?\nхорошо',
    });
  });

  it('a phone reply is ours: no longer «waiting reply», shown as outgoing with a phone mark', () => {
    const messages = [msg(1, 900, 'Есть свободная баня?'), msg(2, 900, '=== Исходящее сообщение, автор: Телефон ===\nДа, на субботу есть')];
    const last = lastMeaningful(messages, users);
    expect(last).toMatchObject({ kind: 'employee', human: true });
    expect(messageText(last!.message.text)).toBe('Да, на субботу есть');
    expect(toMessageDto(messages[1], users, [])).toMatchObject({ author: { kind: 'employee', name: 'Телефон' }, viaPhone: true, text: 'Да, на субботу есть' });
    expect(toMessageDto(messages[0], users, [])).toMatchObject({ author: { kind: 'client', name: 'Клиент Иван' } });
    expect(toMessageDto(messages[0], users, [])).not.toHaveProperty('viaPhone');
  });

  it('an employee message with the same text is not affected', () => {
    expect(messageKind(msg(3, 42, '=== Исходящее сообщение, автор: Телефон ===\nx'), users)).toBe('employee');
    expect(toMessageDto(msg(3, 42, '=== Исходящее сообщение, автор: Телефон ===\nx'), users, [])).not.toHaveProperty('viaPhone');
  });
});
