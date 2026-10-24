import { MessengerConnectorService } from './messenger-connector.service.js';
import type { InboxListener } from './messenger-inbox.service.js';
import type { Messenger, MessengerMessage } from '../../generated/prisma/client.js';
const m={id:'m1',portalId:'p1',kind:'whatsapp',lineMode:'own',lineId:14} as Messenger;
const msg=(dealId:number,relayChatId:string|null=null)=>({id:'row',externalId:'external',chatId:'client@lid',dealId,relayChatId,body:'Вопрос',sentAt:new Date(),awaitingDeal:false,mediaId:null}) as MessengerMessage;
function setup(prior:MessengerMessage|null,other:MessengerMessage|null) {
 let listener: InboxListener;
 const call=vi.fn(async(_method:string,_params:Record<string,unknown>)=>({result:{SUCCESS:true,DATA:{RESULT:[{SUCCESS:true,session:{CHAT_ID:'900'}}]}}}));
 const db={portal:{findFirst:vi.fn(async()=>({id:'p1',status:'ACTIVE'}))},messengerMessage:{findFirst:vi.fn(async({where}:{where:{dealId:unknown}})=>typeof where.dealId==='number'?prior:other),update:vi.fn()},messengerChat:{findUnique:vi.fn(async()=>({phone:'79259734763',name:'Клиент'}))}};
 const svc=new MessengerConnectorService(db as never,{clientFor:()=>({call})} as never,{} as never,{listen:(l:InboxListener)=>{listener=l;}} as never,{} as never,{} as never);
 svc.onModuleInit();
 return {svc,db,call,incoming:(row:MessengerMessage)=>svc.publishChosen(m,row),automatic:(row:MessengerMessage)=>listener.incoming(m,row,'Клиент'),edited:(row:MessengerMessage)=>listener.edited(m,row)};
}
it('первая сделка переиспользует существующий remote, следующая имеет отдельный диалог без CRM дубля',async()=>{
 const first=setup(null,null);
 try {await first.incoming(msg(11));expect(first.call.mock.calls[0][1]).toMatchObject({MESSAGES:[{chat:{id:'client@lid'},message:{disable_crm:'Y'}}]});}finally{first.svc.onApplicationShutdown();}
 const second=setup(null,msg(11,'client@lid'));
 try {await second.incoming(msg(12));expect(second.call.mock.calls[0][1]).toMatchObject({MESSAGES:[{chat:{id:'client@lid::deal:12'}}]});}finally{second.svc.onApplicationShutdown();}
});
it('правка после смены сделки возвращается в исходный relayChatId',async()=>{
 const t=setup(msg(11,'client@lid'),msg(12,'client@lid::deal:12'));
 try {await t.edited(msg(11,'client@lid'));expect(t.call.mock.calls[0][0]).toBe('imconnector.update.messages');expect(t.call.mock.calls[0][1]).toMatchObject({MESSAGES:[{chat:{id:'client@lid'}}]});}finally{t.svc.onApplicationShutdown();}
});

it('новый канал найденного клиента не создаёт ОЛ до явного выбора менеджера',async()=>{
 const t=setup(null,null);
 try {await t.automatic(msg(11));expect(t.call).not.toHaveBeenCalled();await t.incoming(msg(11));expect(t.call).toHaveBeenCalledTimes(1);}finally{t.svc.onApplicationShutdown();}
});
