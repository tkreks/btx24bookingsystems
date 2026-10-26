import { MessengerChatsService } from './messenger-chats.service.js';
import type { Messenger } from '../../generated/prisma/client.js';
const M={id:'m1',portalId:'p1',lineMode:null,lineId:null} as Messenger;
function setup() {
  const row={id:'row1',messengerId:'m1',chatId:'x@lid',externalId:'wa1',hasMedia:true,fromMe:true,body:'Caption',type:'image',mediaId:null,mediaMime:null,mediaName:null,mediaSize:null,sentAt:new Date(),editedAt:null,deletedAt:null,edits:[],ack:1,source:'app',relayError:null};
  const prisma={messengerMessage:{findFirst:vi.fn(async()=>row),update:vi.fn(async({data}:{data:object})=>Object.assign(row,data))},messengerChat:{findFirst:vi.fn(async()=>({chatId:'x@lid',phone:'79991234567'})),findUnique:vi.fn(async()=>({chatId:'x@lid',phone:'79991234567'}))}};
  const service={send:vi.fn(async()=>({id:'wa1'})),mediaOf:vi.fn(async()=>({fileId:'a'.repeat(40),mime:'image/png',name:'Фото.png',size:5})),readMedia:vi.fn(async()=>({mime:'image/png',data:Buffer.from('image')}))};
  const inbox={message:vi.fn(async()=>row)};const connector={firstContact:vi.fn(async()=>row)};
  const svc=new MessengerChatsService(prisma as never,service as never,inbox as never,connector as never,{} as never);
  return {svc,row,prisma,service,inbox,connector};
}
describe('Файлы в переписке мессенджера',()=>{
  it('номер без открытой линии не отправляет, неверные данные — 400',async()=>{
    const t=setup();const file={mime:'image/png',name:'Фото.png',data:Buffer.from('image')};
    // Номер без открытой линии: отправка запрещена (сообщения — только через рабочие линии, 2026-10-26).
    await expect(t.svc.sendFile({userId:7} as never,M,'x@lid','',file)).rejects.toMatchObject({status:409,response:{code:'NO_OPENLINE'}});
    expect(t.service.send).not.toHaveBeenCalled();
    await expect(t.svc.sendFile({} as never,M,'bad','x',file)).rejects.toMatchObject({status:400});
    await expect(t.svc.sendFile({} as never,M,'x@lid','x',{...file,data:Buffer.alloc(0)})).rejects.toMatchObject({status:400});
  });
  it('номер с собственной ОЛ открывает/дополняет линию от имени сотрудника',async()=>{
    const t=setup();const m={...M,kind:'whatsapp',state:'ready',lineMode:'own',lineId:14} as Messenger;const file={mime:'application/pdf',name:'x.pdf',data:Buffer.from('pdf')};
    const call=vi.fn(async(method:string)=>method==='imopenlines.config.list.get'?{result:[{ID:'14',ACTIVE:'Y',LINE_NAME:'WhatsApp'}]}:{result:{CONFIGURED:true,STATUS:true,ERROR:false}});
    const user={userId:7,portal:{id:'p-media'},client:{call}} as never;
    Object.assign(t.row,{b24ChatId:321});
    const result=await t.svc.sendFile(user,m,'x@lid','Caption',file);
    expect(result.openlineChatId).toBe(321);
    expect(t.connector.firstContact).toHaveBeenCalledWith(user,m,'79991234567@c.us','Caption',file,undefined);expect(t.service.send).not.toHaveBeenCalled();
  });
  it('файл истории скачивается лениво, связь сообщения ограничена номером; удалённое не выдаётся',async()=>{
    const t=setup();const file=await t.svc.media(M,'row1');expect(file).toMatchObject({name:'Фото.png',data:Buffer.from('image')});
    expect(t.prisma.messengerMessage.findFirst).toHaveBeenCalledWith({where:{messengerId:'m1',OR:[{id:'row1'},{externalId:'row1'}]}});
    expect(t.service.mediaOf).toHaveBeenCalledWith('m1','wa1');await t.svc.media(M,'row1');expect(t.service.mediaOf).toHaveBeenCalledTimes(1);
    t.row.deletedAt=new Date() as never;await expect(t.svc.media(M,'row1')).rejects.toMatchObject({status:404});
    t.prisma.messengerMessage.findFirst.mockResolvedValueOnce(null as never);await expect(t.svc.media(M,'other')).rejects.toMatchObject({status:404});
  });
  it('фильтр сделки применяется к запросу сообщений до пагинации и ограничен порталом/номером', async()=>{
    const findMany=vi.fn(async()=>[]);const updateMany=vi.fn(async()=>({count:0}));
    const service=new MessengerChatsService({messengerMessage:{findMany},messengerChat:{updateMany}} as never,{} as never,{} as never,{} as never,{} as never);
    await service.messages(M,'x@lid','2026-10-24T10:00:00Z',12);
    expect(findMany).toHaveBeenCalledWith({where:{portalId:'p1',messengerId:'m1',chatId:'x@lid',dealId:12,sentAt:{lt:new Date('2026-10-24T10:00:00Z')}},orderBy:{sentAt:'desc'},take:50});
  });

});
