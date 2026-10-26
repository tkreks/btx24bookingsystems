import type { Messenger } from '../../generated/prisma/client.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { bbToMessenger, lineText, MessengerConnectorService, PHONE_MARK } from './messenger-connector.service.js';
import { MessengerInboxService, phoneOfChat } from './messenger-inbox.service.js';
import type { MessengerServiceClient, WireMessage } from './messenger-service.client.js';

/** База в памяти: сообщения и чаты мессенджера. */
function fakeDb() {
  const msgs: Record<string, unknown>[] = [];
  const chats: Record<string, unknown>[] = [];
  const key = (w: { messengerId_externalId: { externalId: string } }) => w.messengerId_externalId.externalId;
  const prisma = {
    messenger: { findUnique: vi.fn(async () => M), findFirst: vi.fn(async () => M), updateMany: vi.fn() },
    portal: { findFirst: vi.fn(async () => ({ id: 'p1', status: 'ACTIVE' })) },
    messengerMessage: {
      findUnique: vi.fn(async ({ where }: never) => msgs.find((m) => m.externalId === key(where)) ?? null),
      findFirst: vi.fn(async ({ where }: { where: { b24MessageId?: number } }) => msgs.find((m) => where.b24MessageId && m.b24MessageId === where.b24MessageId) ?? null),
      upsert: vi.fn(async ({ where, create, update }: never) => {
        const prev = msgs.find((m) => m.externalId === key(where));
        if (prev) return Object.assign(prev, update);
        const row = { id: `r${msgs.length}`, editedAt: null, edits: null, deletedAt: null, relayError: null, ...(create as object) };
        msgs.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: object }) => Object.assign(msgs.find((m) => m.id === where.id)!, data)),
      updateMany: vi.fn(),
      findMany: vi.fn(async () => msgs.filter((m) => m.source === 'app')),
    },
    messengerChat: {
      findUnique: vi.fn(async () => chats[0] ?? null),
      upsert: vi.fn(async ({ create, update }: { create: object; update: object }) => (chats[0] ? Object.assign(chats[0], update) : (chats.push({ ...create }), chats[0]))),
    },
  } as unknown as PrismaService;
  return { prisma, msgs, chats };
}
const M = { id: 'm1', portalId: 'p1', kind: 'whatsapp', phone: '79990007272', lineMode: 'own', lineId: 14 } as Messenger;
const wire = (id: string, body: string, fromMe = false): WireMessage => ({ id, chatId: '79991234567@c.us', fromMe, author: null, name: 'Тата', body, type: 'chat', hasMedia: false, quotedId: null, timestamp: 1_800_000_000, ack: null });

describe('Переписка мессенджера в базе', () => {
  it('повтор события не создаёт дубль и не передаёт в линию дважды', async () => {
    const db = fakeDb();
    const inbox = new MessengerInboxService(db.prisma);
    const incoming = vi.fn(async () => undefined);
    inbox.listen({ incoming, outgoing: vi.fn(), edited: vi.fn(), revoked: vi.fn() });
    await inbox.apply([{ type: 'message', instanceId: 'm1', message: wire('a', 'Привет') }, { type: 'message', instanceId: 'm1', message: wire('a', 'Привет') }]);
    expect(db.msgs).toHaveLength(1);
    expect(incoming).toHaveBeenCalledTimes(1);
  });

  it('отправленное с телефона — в линию (outgoing); своё из приложения — нет', async () => {
    const db = fakeDb();
    const inbox = new MessengerInboxService(db.prisma);
    const outgoing = vi.fn(async () => undefined);
    inbox.listen({ incoming: vi.fn(), outgoing, edited: vi.fn(), revoked: vi.fn() });
    await inbox.apply([{ type: 'message', instanceId: 'm1', message: wire('p', 'С телефона', true) }]);
    await inbox.message(M, wire('q', 'Из приложения', true), { source: 'app' });
    expect(outgoing).toHaveBeenCalledTimes(1);
    expect(outgoing.mock.calls[0]).toEqual([M, expect.objectContaining({ externalId: 'p' })]);
  });

  it('реакции — текущий набор сообщения', async () => {
    const db = fakeDb();
    const inbox = new MessengerInboxService(db.prisma);
    await inbox.apply([{ type: 'reaction', instanceId: 'm1', id: 'a', chatId: '79991234567@c.us', reactions: [{ emoji: '👍', mine: false }, { emoji: 'x'.repeat(40), mine: true }] }]);
    expect(db.prisma.messengerMessage.updateMany).toHaveBeenCalledWith({ where: { messengerId: 'm1', externalId: 'a' }, data: { reactions: [{ emoji: '👍', mine: false }] } });
  });

  it('текст для линии: с телефона — с меткой, в группе — с автором', () => {
    const base = { chatId: '79991234567@c.us', body: 'Какой возраст детей?', type: 'chat', hasMedia: false };
    expect(lineText({ ...base, fromMe: true }, null, false)).toBe(`${PHONE_MARK}\nКакой возраст детей?`);
    expect(lineText({ ...base, chatId: '5116402572@g.us', fromMe: false }, 'Светлана', false)).toBe('Светлана:\nКакой возраст детей?');
    expect(lineText({ ...base, fromMe: false }, null, false)).toBe('Какой возраст детей?');
  });

  it('правка хранит прежний текст, удаление — отметка, текст остаётся', async () => {
    const db = fakeDb();
    const inbox = new MessengerInboxService(db.prisma);
    await inbox.apply([
      { type: 'message', instanceId: 'm1', message: wire('a', 'Завтра в 10') },
      { type: 'edit', instanceId: 'm1', id: 'a', chatId: '79991234567@c.us', body: 'Завтра в 11', prevBody: 'Завтра в 10', at: 1_800_000_100 },
      { type: 'revoke', instanceId: 'm1', id: 'a', chatId: '79991234567@c.us', at: 1_800_000_200 },
    ]);
    expect(db.msgs[0]).toMatchObject({ body: 'Завтра в 11', edits: [{ body: 'Завтра в 10' }] });
    expect(db.msgs[0].deletedAt).toBeInstanceOf(Date);
  });

  it('номер собеседника — только из личного чата', () => {
    expect(phoneOfChat('79991234567@c.us')).toBe('79991234567');
    expect(phoneOfChat('123456789012345@lid')).toBeNull();
    expect(phoneOfChat('120363@g.us')).toBeNull();
  });
});

describe('Своя открытая линия (коннектор)', () => {
  it('входящее фото уходит в линию подписанной ссылкой и сохраняет метаданные', async () => {
    const db=fakeDb();const inbox=new MessengerInboxService(db.prisma);const call=vi.fn(async()=>({result:{SUCCESS:true}}));
    const svc=new MessengerConnectorService(db.prisma,{clientFor:()=>({call})} as never,{} as never,inbox,{} as never,{url:()=> 'https://app.test/signed-file'} as never);
    await svc.onModuleInit();
    try {
      await inbox.apply([{type:'message',instanceId:'m1',message:{...wire('photo','Подпись'),type:'image',hasMedia:true,media:{fileId:'a'.repeat(40),mime:'image/png',name:'Фото.png',size:5}}}]);
      expect(db.msgs[0]).toMatchObject({mediaId:'a'.repeat(40),mediaMime:'image/png',mediaName:'Фото.png',mediaSize:5});
      expect(call).toHaveBeenCalledWith('imconnector.send.messages',expect.objectContaining({MESSAGES:[expect.objectContaining({message:expect.objectContaining({text:'Подпись',files:[{url:'https://app.test/signed-file',name:'Фото.png'}]})})]}));
    } finally { svc.onApplicationShutdown(); }
  });

  it('фото клиента уходит в линию аватаром (user.picture); нет фото — без него, сервис спрашиваем раз в сутки', async () => {
    const db=fakeDb();const inbox=new MessengerInboxService(db.prisma);const call=vi.fn(async()=>({result:{SUCCESS:true}}));
    const avatar=vi.fn(async()=>({fileId:'b'.repeat(40),mime:'image/jpeg',name:'avatar.jpg',size:3}));
    const svc=new MessengerConnectorService(db.prisma,{clientFor:()=>({call})} as never,{avatar} as never,inbox,{} as never,{url:(_m:string,f:string)=>`https://app.test/${f}`} as never);
    await svc.onModuleInit();
    try {
      await inbox.apply([{type:'message',instanceId:'m1',message:wire('a1','Привет')}]);
      await inbox.apply([{type:'message',instanceId:'m1',message:wire('a2','Ещё')}]);
      expect(call).toHaveBeenCalledWith('imconnector.send.messages',expect.objectContaining({MESSAGES:[expect.objectContaining({user:expect.objectContaining({picture:{url:`https://app.test/${'b'.repeat(40)}`}})})]}));
      expect(avatar).toHaveBeenCalledTimes(1);
      expect(await svc.pictureOf({id:'m1'} as never,'x@g.us')).toBeUndefined();
    } finally { svc.onApplicationShutdown(); }
  });

  it('повтор после сбоя второго файла не отправляет первый ещё раз', async () => {
    const db=fakeDb();vi.mocked(db.prisma.messengerMessage.findMany).mockImplementation((async () => db.msgs.filter(m=>m.source==='bitrix')) as never);
    const inbox=new MessengerInboxService(db.prisma);const call=vi.fn(async()=>({result:{SUCCESS:true}}));
    let attempt=0;const send=vi.fn(async (_id:string,to:string,text:string)=>{attempt++;if(attempt===2)throw new Error('disconnected');return {...wire('file'+attempt,text,true),chatId:to};});
    const svc=new MessengerConnectorService(db.prisma,{clientFor:()=>({call})} as never,{send} as never,inbox,{} as never,{} as never);
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('file',{headers:{'content-type':'application/pdf'}})));
    const data={LINE:14,MESSAGES:[{im:{chat_id:8,message_id:900},message:{text:'Подпись',files:[{link:'https://portal.test/one',name:'1.pdf'},{link:'https://portal.test/two',name:'2.pdf'}]},chat:{id:'79991234567@c.us'}}]};
    try {
      await expect(svc.fromBitrix({id:'p1',domain:'portal.test'} as never,'ONIMCONNECTORMESSAGEADD',data)).rejects.toThrow('disconnected');
      await svc.fromBitrix({id:'p1',domain:'portal.test'} as never,'ONIMCONNECTORMESSAGEADD',data);
      expect(send).toHaveBeenCalledTimes(3);expect(send.mock.calls[2][2]).toBe('');expect(db.msgs).toHaveLength(2);
      await svc.fromBitrix({id:'p1',domain:'portal.test'} as never,'ONIMCONNECTORMESSAGEADD',data);expect(send).toHaveBeenCalledTimes(3);
    } finally { vi.unstubAllGlobals(); }
  });

  it('файл оператора скачивается только с портала; подпись и байты уходят клиенту', async () => {
    const db=fakeDb();const inbox=new MessengerInboxService(db.prisma);const call=vi.fn(async()=>({result:{SUCCESS:true}}));
    const service={send:vi.fn(async (_id:string,to:string,text:string)=>({...wire('fileout',text,true),chatId:to}))} as unknown as MessengerServiceClient;
    const svc=new MessengerConnectorService(db.prisma,{clientFor:()=>({call})} as never,service,inbox,{} as never,{} as never);
    const get=vi.fn(async()=>new Response('bytes',{headers:{'content-type':'application/pdf'}}));vi.stubGlobal('fetch',get);
    const data={LINE:14,MESSAGES:[{im:{chat_id:8,message_id:900},message:{text:'Документ',files:[{link:'https://portal.test/file',name:'Счёт.pdf'}]},chat:{id:'79991234567@c.us'}}]};
    try {
      await svc.fromBitrix({id:'p1',domain:'portal.test'} as never,'ONIMCONNECTORMESSAGEADD',data);
      expect(service.send).toHaveBeenCalledWith('m1','79991234567@c.us','Документ',undefined,{mime:'application/pdf',name:'Счёт.pdf',data:Buffer.from('bytes')});
      expect(get).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllGlobals(); }
  });

  it.each(['https://evil.test/file','http://portal.test/file','https://portal.test:444/file','https://user:pass@portal.test/file'])('чужая/небезопасная ссылка %s не доставляется', async link => {
    const db=fakeDb();const send=vi.fn();const svc=new MessengerConnectorService(db.prisma,{clientFor:()=>({call:vi.fn()})} as never,{send} as never,new MessengerInboxService(db.prisma),{} as never,{} as never);
    const get=vi.fn();vi.stubGlobal('fetch',get);
    try {
      await expect(svc.fromBitrix({id:'p1',domain:'portal.test'} as never,'ONIMCONNECTORMESSAGEADD',{LINE:14,MESSAGES:[{message:{files:[{link}]},chat:{id:'x@c.us'}}]})).rejects.toThrow();
      expect(get).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it('redirect за пределы портала и Content-Length >64 МБ прекращают загрузку', async () => {
    const db=fakeDb();const send=vi.fn();const svc=new MessengerConnectorService(db.prisma,{clientFor:()=>({call:vi.fn()})} as never,{send} as never,new MessengerInboxService(db.prisma),{} as never,{} as never);
    const get=vi.fn().mockResolvedValueOnce(new Response(null,{status:302,headers:{location:'https://evil.test/file'}})).mockResolvedValueOnce(new Response('x',{headers:{'content-length':String(65*1024*1024)}}));
    vi.stubGlobal('fetch',get);
    const data={LINE:14,MESSAGES:[{message:{files:[{link:'https://portal.test/file'}]},chat:{id:'x@c.us'}}]};
    try {
      await expect(svc.fromBitrix({id:'p1',domain:'portal.test'} as never,'ONIMCONNECTORMESSAGEADD',data)).rejects.toThrow();
      expect(get).toHaveBeenCalledTimes(1);
      await expect(svc.fromBitrix({id:'p1',domain:'portal.test'} as never,'ONIMCONNECTORMESSAGEADD',data)).rejects.toThrow('64 МБ');expect(send).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it('текст оператора: BBCode → разметка WhatsApp', () => {
    expect(bbToMessenger('[b]Анна:[/b][br]Добрый день, [i]ждём[/i]')).toBe('*Анна:*\nДобрый день, _ждём_');
    expect(bbToMessenger('[b]Анна:[/b][br]Добрый день, [i]ждём[/i]', 'telegram')).toBe('Анна:\nДобрый день, ждём');
    expect(bbToMessenger('[b]Анна:[/b] [s]было[/s]', 'max')).toBe('Анна: было');
  });

  it('сообщение оператора уходит клиенту один раз; повтор события — только подтверждение доставки', async () => {
    const db = fakeDb();
    const inbox = new MessengerInboxService(db.prisma);
    const call = vi.fn(async () => ({ result: { SUCCESS: true } }));
    const service = { send: vi.fn(async (_id: string, to: string, text: string) => ({ ...wire('out1', text, true), chatId: to })) } as unknown as MessengerServiceClient;
    const svc = new MessengerConnectorService(db.prisma, { clientFor: () => ({ call }) } as never, service, inbox, { appBaseUrl: 'https://app.test' } as never, { url: () => null } as never);
    const data = { CONNECTOR: 'btx24_whatsapp', LINE: 14, MESSAGES: [{ im: { chat_id: 1807, message_id: 86497 }, message: { user_id: 27, text: '[b]Анна:[/b] [br]Здравствуйте' }, chat: { id: '79991234567@c.us' } }] };
    await svc.fromBitrix({ id: 'p1' } as never, 'ONIMCONNECTORMESSAGEADD', data);
    await svc.fromBitrix({ id: 'p1' } as never, 'ONIMCONNECTORMESSAGEADD', data);
    expect(service.send).toHaveBeenCalledTimes(1);
    expect(service.send).toHaveBeenCalledWith('m1', '79991234567@c.us', '*Анна:* \nЗдравствуйте');
    expect(db.msgs[0]).toMatchObject({ source: 'bitrix', b24MessageId: 86497, sentByUserId: 27 });
    expect(call).toHaveBeenCalledWith('imconnector.send.status.delivery', expect.objectContaining({ CONNECTOR: 'btx24_whatsapp', LINE: 14 }));
    expect(call.mock.calls.filter((c) => (c as unknown[])[0] === 'imconnector.send.status.delivery')).toHaveLength(2);
  });
});

describe('Первое сообщение из приложения в своей линии', () => {
  it('эхо из линии узнаётся по чату и тексту — второй раз клиенту не уходит', async () => {
    const db = fakeDb();
    const inbox = new MessengerInboxService(db.prisma);
    db.msgs.push({ id: 'r0', externalId: 'first', chatId: '79991234567@c.us', source: 'app', b24ChatId: 1807, b24MessageId: null, body: 'Добрый день!', sentAt: new Date() });
    const call = vi.fn(async () => ({ result: { SUCCESS: true } }));
    const service = { send: vi.fn() } as unknown as MessengerServiceClient;
    const svc = new MessengerConnectorService(db.prisma, { clientFor: () => ({ call }) } as never, service, inbox, { appBaseUrl: 'https://app.test' } as never, { url: () => null } as never);
    await svc.fromBitrix({ id: 'p1' } as never, 'ONIMCONNECTORMESSAGEADD', { LINE: 14, MESSAGES: [{ im: { chat_id: 1807, message_id: 900 }, message: { text: '[b]Анна:[/b][br]Добрый день!' }, chat: { id: '79991234567@c.us' } }] });
    expect(service.send).not.toHaveBeenCalled();
    expect(db.msgs[0].b24MessageId).toBe(900);
  });
});
