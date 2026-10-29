import { ContactAlertsService } from './contact-alerts.service.js';
const actor = { source: 'bitrix', accountId: 242, accountName: 'Автоматизация', accountType: 'system_user', attribution: 'last_editor', application: null };
const row = { id:'a1',portalId:'p1',contactId:7,kind:'change',status:'new',createdAt:new Date(),changes:[{field:'NAME',before:'Старое',after:'Новое'}],actor,messageId:null,sendError:null };
function setup() {
  const findMany=vi.fn(async()=>[row]);const update=vi.fn(async()=>row);
  const db={contactAlert:{findMany,findFirst:vi.fn(async({where}:{where:{portalId:string}})=>where.portalId==='p1'?row:null),groupBy:vi.fn(async()=>[{status:'new',_count:1}]),update},portalSettings:{findUnique:vi.fn(async()=>({alertChatId:5}))},crmEntity:{findMany:vi.fn(async({where}:{where:{entityId:{in:number[]}}})=>where.entityId.in.map(entityId=>({entityId,title:'Иван Петров'})))}};
  const visible=vi.fn(async()=>new Set<number>());
  const call=vi.fn(async()=>({result:{NAME:{title:'Имя'}}}));
  const user={portal:{id:'p1',timezone:'UTC'},userId:9,client:{call}} as never;
  return {service:new ContactAlertsService(db as never,{visible} as never),db,visible,call,user};
}
it('значения и автор скрыты без CRM-прав, но безопасное предупреждение остаётся',async()=>{
  const t=setup();const result=await t.service.list(t.user,{});
  expect(result.items[0]).toMatchObject({contactId:7,restricted:true,changes:[],actor:{accountId:null},contactName:null});
  expect(t.call).not.toHaveBeenCalled();
  expect(t.db.contactAlert.findMany).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({portalId:'p1'})}));
  t.visible.mockResolvedValue(new Set([7]));
  expect((await t.service.list(t.user,{})).items[0]).toMatchObject({restricted:false,changes:[{label:'Имя'}],contactName:'Иван Петров',actor:{accountId:242,accountType:'system_user',application:null}});
});
it('чужой портал не может менять статус; смена статуса не меняет карточку CRM',async()=>{
  const t=setup();
  await expect(t.service.setStatus({...t.user as object,portal:{id:'p2'}} as never,'a1','resolved')).rejects.toMatchObject({status:404});
  expect(t.db.contactAlert.update).not.toHaveBeenCalled();
  await t.service.setStatus(t.user,'a1','resolved');expect(t.call).not.toHaveBeenCalled();
});
it('доставка в общий чат содержит только идентификатор, без значений контакта; сбой сохраняется для повтора',async()=>{
  const t=setup();const call=vi.fn(async()=>({result:500}));
  await t.service.deliverPending({id:'p1'} as never,{call} as never);
  expect(call).toHaveBeenCalledWith('im.message.add',expect.objectContaining({DIALOG_ID:'chat5'}));
  const payload=JSON.stringify(call.mock.calls);
  expect(payload).not.toContain('Старое');expect(payload).not.toContain('Новое');
  expect(t.db.contactAlert.update).toHaveBeenCalledWith(expect.objectContaining({data:{messageId:500,sendError:null}}));
  call.mockRejectedValue(new Error('network'));
  await t.service.deliverPending({id:'p1'} as never,{call} as never);
  expect(t.db.contactAlert.update).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({sendError:expect.any(String)})}));
});
it('«принять все» меняет только уведомления своего портала и пропускает уже принятые',async()=>{
  const t=setup();
  expect(await t.service.setStatusMany({...t.user as object,portal:{id:'p2'}} as never,['a1'],'resolved')).toEqual({updated:0});
  expect(await t.service.setStatusMany(t.user,['a1','a1'],'resolved')).toEqual({updated:1});
  expect(t.db.contactAlert.update).toHaveBeenCalledTimes(1);
  expect(t.call).not.toHaveBeenCalled();
});
