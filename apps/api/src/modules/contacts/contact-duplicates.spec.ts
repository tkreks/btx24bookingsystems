import { buildGroups, indexContact, matchesQuery, normalizeEmail, normalizeName, page, type IndexedContact } from './contact-duplicates.index.js';
import { compareFields } from './contact-compare.js';
import { ContactDuplicatesService, messengerFieldCodes, suggestPrimary } from './contact-duplicates.service.js';

const c = (id: number, row: Record<string, unknown>): IndexedContact => indexContact(id, row);
const phone = (...v: string[]) => v.map((VALUE) => ({ VALUE, VALUE_TYPE: 'WORK' }));

describe('нормализация', () => {
  it('телефон, почта, имя', () => {
    expect(c(1, { PHONE: phone('8 (912) 345-67-89', '+7 912 345 67 89', '912-345-67-89', '12345') }).phoneKeys).toEqual(['79123456789']);
    expect(normalizeEmail('  Ivan@Mail.RU ')).toBe('ivan@mail.ru');
    expect(normalizeEmail('нет')).toBeNull();
    expect(normalizeName('Виктория', 'Трубицына')).toBe(normalizeName(' трубицына ', 'ВИКТОРИЯ'));
    expect(normalizeName('Алёна', 'Иванова')).toBe('алена иванова');
    expect(normalizeName('Виктория', '')).toBeNull();
    expect(normalizeName('', '')).toBeNull();
  });
});

describe('группы', () => {
  const contacts = [
    c(1, { NAME: 'Анна', LAST_NAME: 'Смирнова', PHONE: phone('+79120000001'), DATE_MODIFY: '2026-01-01T00:00:00+03:00' }),
    c(2, { NAME: 'Аня', PHONE: phone('89120000001'), EMAIL: phone('anna@x.ru') }),
    c(3, { NAME: 'Анна С.', EMAIL: phone('ANNA@x.ru ') }),
    c(4, { NAME: 'Виктория', LAST_NAME: 'Трубицына', DATE_MODIFY: '2026-10-01T00:00:00+03:00' }),
    c(5, { NAME: 'Трубицына', LAST_NAME: 'Виктория', DATE_MODIFY: '2025-10-01T00:00:00+03:00' }),
    c(6, { NAME: 'Смирнова', LAST_NAME: 'Анна' }),
    c(7, { NAME: 'Пётр', LAST_NAME: 'Иванов', PHONE: phone('+79990000077') }),
    c(8, { NAME: 'Петр', LAST_NAME: 'Иванов', PHONE: phone('+79990000077') }),
    c(9, { NAME: 'Один' }),
  ];

  it('union-find: общий телефон 1~2, общая почта 2~3 → одна группа', () => {
    const groups = buildGroups(contacts, 'all');
    const g = groups.find((x) => x.members.some((m) => m.id === 1))!;
    expect(g.members.map((m) => m.id).sort()).toEqual([1, 2, 3]);
    expect(g.reasons).toEqual(expect.arrayContaining([{ kind: 'phone', value: '79120000001' }, { kind: 'email', value: 'anna@x.ru' }]));
    // 6 совпадает с 1 по имени, но не входит в телефон/почта-группу → отдельная группа по имени.
    expect(groups.find((x) => x.reasons[0]?.kind === 'name' && x.members.some((m) => m.id === 6))!.members.map((m) => m.id).sort()).toEqual([1, 6]);
    // 7 и 8 — один телефон и одно имя: имя не плодит отдельную группу, а добавляется причиной.
    const g78 = groups.find((x) => x.members.some((m) => m.id === 7))!;
    expect(g78.reasons.map((r) => r.kind)).toEqual(['phone', 'name']);
    expect(groups.filter((x) => x.members.some((m) => m.id === 7))).toHaveLength(1);
    expect(groups.some((x) => x.members.some((m) => m.id === 9))).toBe(false);
    // Больше контактов — выше.
    expect(groups[0]!.members).toHaveLength(3);
  });

  it('by=phone / email / name', () => {
    expect(buildGroups(contacts, 'phone').map((g) => g.members.map((m) => m.id).sort())).toEqual(expect.arrayContaining([[1, 2], [7, 8]]));
    expect(buildGroups(contacts, 'email').map((g) => g.members.map((m) => m.id).sort())).toEqual([[2, 3]]);
    const names = buildGroups(contacts, 'name');
    expect(names.every((g) => g.reasons[0]!.kind === 'name')).toBe(true);
    // Равный размер — сначала с более свежим изменением (4/5 — октябрь 2026).
    expect(names[0]!.members.map((m) => m.id).sort()).toEqual([4, 5]);
  });

  it('q: имя, почта, цифры телефона; страницы курсором', () => {
    const groups = buildGroups(contacts, 'all');
    expect(groups.filter((g) => matchesQuery(g, 'трубиц')).map((g) => g.members.map((m) => m.id).sort())).toEqual([[4, 5]]);
    expect(groups.filter((g) => matchesQuery(g, 'ANNA@')).length).toBe(1);
    expect(groups.filter((g) => matchesQuery(g, '912 000')).length).toBe(2);
    expect(groups.filter((g) => matchesQuery(g, 'петр')).length).toBe(1);
    const meta = { scanned: contacts.length, builtAt: '2026-10-30T00:00:00.000Z' };
    const p1 = page(groups, { limit: 2 }, meta);
    expect(p1).toMatchObject({ total: groups.length, nextCursor: '2', scanned: 9 });
    expect(p1.groups).toHaveLength(2);
    const p2 = page(groups, { limit: 2, cursor: p1.nextCursor }, meta);
    expect(p2.nextCursor).toBeNull();
    expect(p2.groups[0]!.key).toBe(groups[2]!.key);
    expect(page(groups, { limit: 1000 }, meta).groups.length).toBeLessThanOrEqual(100);
    expect(p1.groups[0]!.contacts[0]).not.toHaveProperty('phoneKeys');
  });

  it('в группе — старые сначала, без даты — в конце', () => {
    const g = buildGroups(
      [
        c(30, { PHONE: phone('+79125550000'), DATE_CREATE: '2026-03-01T00:00:00+03:00' }),
        c(10, { PHONE: phone('+79125550000') }),
        c(20, { PHONE: phone('+79125550000'), DATE_CREATE: '2024-01-01T00:00:00+03:00' }),
        c(40, { PHONE: phone('+79125550000'), DATE_CREATE: '2024-01-01T00:00:00+03:00' }),
      ],
      'phone',
    );
    expect(g[0]!.members.map((m) => m.id)).toEqual([20, 40, 30, 10]);
  });

  it('мессенджеры из IM: коннекторы открытых линий и типы мессенджеров', () => {
    const im = [
      { VALUE_TYPE: 'IMOL', VALUE: 'imol|wz_whatsapp_ceacd473beec8c39f54fd7afd810cd43d|1|79120000001|77' },
      { VALUE_TYPE: 'IMOL', VALUE: 'imol|btx24_whatsapp|3|79120000001@c.us|5' },
      { VALUE_TYPE: 'IMOL', VALUE: 'imol|wz_max_conneceacd473beec8c39f54fd7afd810cd43d|1|x|1' },
      { VALUE_TYPE: 'IMOL', VALUE: 'imol|fbinstagramdirect|2|y|3' },
      { VALUE_TYPE: 'IMOL', VALUE: 'imol|btx24_telegram|4|z|9' },
      { VALUE_TYPE: 'TELEGRAM', VALUE: 'https://t.me/ssfnv' },
      { VALUE_TYPE: 'SKYPE', VALUE: 'skype-user' },
      { VALUE_TYPE: 'IMOL', VALUE: 'imol|unknown_conn|1|q|1' },
      'мусор',
    ];
    expect(c(1, { IM: im }).messengers).toEqual(['whatsapp', 'max', 'instagram', 'telegram']);
    expect(c(2, {}).messengers).toEqual([]);
    expect(indexContact(3, {}, 'https://x/y.jpg').photo).toBe('https://x/y.jpg');
  });

  it('ID мессенджеров: пространства не смешиваются, нормализация', () => {
    const fields = { telegram: ['UF_A', 'UF_B'], telegramLogin: ['UF_L'], whatsapp: ['UF_W'], whatsappLid: ['UF_WL'], max: ['UF_M'] };
    const k = (row: Record<string, unknown>) => indexContact(1, row, null, fields).messengerKeys;
    expect(k({ UF_A: ' 5789248202 ', UF_B: 5789248202, UF_L: '@IvanPetrov' })).toEqual(['telegram:5789248202', 'telegram-login:ivanpetrov']);
    expect(k({ UF_W: ['79120000001@c.us', '123456789012345@lid', '79120000001'], UF_WL: '123456789012345' })).toEqual(['whatsapp:79120000001', 'whatsapp-lid:123456789012345']);
    expect(k({ UF_M: '  ', UF_A: '0', UF_L: '1' })).toEqual([]);
    expect(k({ UF_M: '-7123456' })).toEqual(['max:-7123456']);
    const g = buildGroups(
      [
        indexContact(1, { UF_A: '111222333' }, null, fields),
        indexContact(2, { UF_B: '111222333', PHONE: phone('+79125550001') }, null, fields),
        indexContact(3, { PHONE: phone('89125550001') }, null, fields),
        indexContact(4, { UF_W: ['79125550002@c.us'] }, null, fields),
        indexContact(5, { UF_WL: '79125550002' }, null, fields),
      ],
      'all',
    );
    // 1~2 по Telegram, 2~3 по телефону → одна группа; номер WhatsApp и LID — разные пространства.
    expect(g.map((x) => x.members.map((m) => m.id))).toEqual([[1, 2, 3]]);
    expect(g[0]!.reasons).toEqual(expect.arrayContaining([{ kind: 'messenger', value: 'Telegram 111222333' }]));
    expect(buildGroups([indexContact(1, { UF_A: '111222333' }, null, fields), indexContact(2, { UF_B: '111222333' }, null, fields)], 'messenger')[0]!.key).toBe('m-1');
  });

  it('поля мессенджеров: сопоставление портала + по умолчанию + кандидаты, код — одной роли', () => {
    const f = messengerFieldCodes({ max: 'UF_CRM_MAXID_WZ', telegram: 'UF_CRM_MY_TG' });
    expect(f.telegram).toEqual(['UF_CRM_MY_TG', 'UF_CRM_BTX24_TELEGRAM_ID', 'UF_CRM_TELEGRAMID_WZ']);
    expect(f.max).toEqual(['UF_CRM_MAXID_WZ', 'UF_CRM_BTX24_MAX_ID']);
    expect(f.whatsappLid).toEqual(['UF_CRM_BTX24_WHATSAPP_LID', 'UF_CRM_WHATSAPPLID_WZ']);
    expect(messengerFieldCodes({ telegramLogin: 'UF_CRM_TELEGRAMID_WZ' }).telegram).not.toContain('UF_CRM_TELEGRAMID_WZ');
    expect(messengerFieldCodes({ telegram: "UF_CRM_X'); DROP" }).telegram).toEqual(['UF_CRM_BTX24_TELEGRAM_ID', 'UF_CRM_TELEGRAMID_WZ']);
  });

  it('общий для слишком многих контактов телефон не связывает их', () => {
    const many = Array.from({ length: 60 }, (_, i) => c(100 + i, { NAME: `К${i}`, PHONE: phone('+70000000000') }));
    expect(buildGroups(many, 'phone')).toHaveLength(0);
  });
});

describe('сервис: копия CRM и кэш', () => {
  it('читает только свой портал, кэширует, сбрасывает после invalidate', async () => {
    const $queryRaw = vi.fn(async (sql: TemplateStringsArray, ..._args: unknown[]) =>
      sql.join('?').includes('OpenlineChat')
        ? [
            { contactId: '29650', clientAvatar: 'https://cdn-ru.bitrix24.ru/new.jpg' },
            { contactId: 29650, clientAvatar: 'https://cdn-ru.bitrix24.ru/old.jpg' },
          ]
        : [
            { entityId: 29090, photo: null, im: '[{"VALUE_TYPE":"IMOL","VALUE":"imol|wz_whatsapp_ceacd473|1|7912|55"}]', n: '"Виктория"', ln: '"Трубицына"', sn: null, ph: '[{"VALUE":"+79120000001"}]', em: null, dc: '"2025-12-15T16:11:02+03:00"', dm: null, a: '"302"' },
            { entityId: 29650, photo: null, im: null, n: 'Виктория', ln: 'Трубицына', sn: null, ph: [{ VALUE: '89120000001' }], em: null, dc: '2025-12-26T13:44:56+03:00', dm: null, a: 302 },
            { entityId: 31000, photo: null, im: null, mf: '["5789248202", null, null, null, null, null, null, null, null, null, null, null, null]', n: 'Иван', ln: null, sn: null, ph: null, em: null, dc: null, dm: null, a: null },
            { entityId: 31001, photo: null, im: null, mf: [null, '5789248202'], n: 'Ваня', ln: null, sn: null, ph: null, em: null, dc: null, dm: null, a: null },
            { entityId: 29700, photo: 'https://portal.test/crm.jpg', im: null, n: 'Виктория', ln: 'Трубицына', sn: null, ph: '[{"VALUE":"+7 912 000-00-01"}]', em: null, dc: null, dm: null, a: null },
          ],
    );
    const findUnique = vi.fn(async () => ({ contactFieldMap: { telegram: 'UF_CRM_BTX24_TELEGRAM_ID' } }));
    const svc = new ContactDuplicatesService({ $queryRaw, portalSettings: { findUnique } } as never);
    const user = { portal: { id: 'p1' } } as never;
    const r = await svc.list(user, { by: 'all' });
    expect(r.groups).toHaveLength(2);
    // ID Telegram в поле Wazzup у одного и в нашем поле у другого — дубль.
    expect(r.groups.find((g) => g.reasons[0]!.kind === 'messenger')).toMatchObject({ reasons: [{ kind: 'messenger', value: 'Telegram 5789248202' }], contacts: [{ id: 31000 }, { id: 31001 }] });
    r.groups = r.groups.filter((g) => g.reasons[0]!.kind !== 'messenger');
    expect(r.groups[0]!.reasons.map((x) => x.kind)).toEqual(['phone', 'name']);
    // Старые сначала, без даты создания — в конце.
    expect(r.groups[0]!.contacts.map((x) => x.id)).toEqual([29090, 29650, 29700]);
    expect(r.groups[0]!.contacts.map((x) => x.photo)).toEqual([null, 'https://cdn-ru.bitrix24.ru/new.jpg', 'https://portal.test/crm.jpg']);
    expect(r.groups[0]!.contacts.map((x) => x.messengers)).toEqual([['whatsapp'], [], []]);
    // Оба запроса — только по своему порталу; настройки полей — своего портала.
    expect($queryRaw.mock.calls.map((call) => call.slice(1).filter((v) => typeof v === 'string'))).toEqual([['p1'], ['p1']]);
    expect(findUnique).toHaveBeenCalledWith({ where: { portalId: 'p1' } });
    await svc.list(user, { by: 'name' });
    expect($queryRaw).toHaveBeenCalledTimes(2);
    svc.invalidate('p1');
    await svc.list(user, { by: 'all' });
    expect($queryRaw).toHaveBeenCalledTimes(4);
  });
});

describe('сравнение', () => {
  const meta = {
    ID: { type: 'integer', isReadOnly: true },
    NAME: { type: 'string', title: 'Имя' },
    LAST_NAME: { type: 'string', title: 'Фамилия' },
    TYPE_ID: { type: 'crm_status', statusType: 'CONTACT_TYPE', title: 'Тип' },
    PHONE: { type: 'crm_multifield', isMultiple: true, title: 'Телефон' },
    COMMENTS: { type: 'string', title: 'Комментарий' },
    PHOTO: { type: 'file', title: 'Фото' },
    UF_CRM_SIZE: { type: 'enumeration', listLabel: 'Размер', items: [{ ID: '5', VALUE: 'L' }] },
    BIRTHDATE: { type: 'date', title: 'Дата рождения' },
  };
  const rows = {
    1: { ID: '1', NAME: 'Виктория ', LAST_NAME: 'Трубицына', TYPE_ID: 'CLIENT', PHONE: phone('+79120000001'), COMMENTS: 'A', PHOTO: { id: 1 }, UF_CRM_SIZE: '5', BIRTHDATE: '' },
    2: { ID: '2', NAME: 'Виктория', LAST_NAME: 'Трубицына', TYPE_ID: 'PARTNER', PHONE: phone('89120000001'), COMMENTS: '', UF_CRM_SIZE: null, BIRTHDATE: '' },
  };
  it('single/multi, конфликт после нормализации пробелов, подписи значений, служебные и пустые скрыты', () => {
    const f = compareFields([1, 2], rows, meta, { statuses: { CONTACT_TYPE: { CLIENT: 'Клиенты', PARTNER: 'Партнёры' } }, users: {}, companies: {} });
    const by = Object.fromEntries(f.map((x) => [x.code, x]));
    expect(Object.keys(by).sort()).toEqual(['COMMENTS', 'LAST_NAME', 'NAME', 'PHONE', 'TYPE_ID', 'UF_CRM_SIZE']);
    expect(by.NAME!.conflict).toBe(false);
    expect(by.TYPE_ID).toMatchObject({ kind: 'single', conflict: true, values: { '1': 'Клиенты', '2': 'Партнёры' } });
    expect(by.PHONE).toMatchObject({ kind: 'multi', conflict: false, values: { '1': ['+79120000001'], '2': ['89120000001'] } });
    expect(by.COMMENTS!.conflict).toBe(false);
    expect(by.UF_CRM_SIZE).toMatchObject({ label: 'Размер', values: { '1': 'L', '2': null } });
  });
  it('основной по умолчанию: больше сделок, при равенстве — старше', () => {
    expect(suggestPrimary([{ id: 1, createdAt: '2024-01-01T00:00:00Z', dealsCount: 1 }, { id: 2, createdAt: '2025-01-01T00:00:00Z', dealsCount: 3 }])).toBe(2);
    expect(suggestPrimary([{ id: 5, createdAt: '2025-01-01T00:00:00Z', dealsCount: 2 }, { id: 9, createdAt: '2024-01-01T00:00:00Z', dealsCount: 2 }])).toBe(9);
  });
});
