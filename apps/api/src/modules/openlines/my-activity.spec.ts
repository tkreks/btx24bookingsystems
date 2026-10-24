import { ActivityService } from './activity.service.js';
import { OpenlinesController } from './openlines.controller.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import type { PrismaService } from '../../prisma/prisma.service.js';

const at = '2026-10-24T00:10:00Z'; // 03:10 в зоне портала
function setup(portalId = 'p1') {
  const actions = [
    { id:'a1', at:new Date(at), userId:7, action:'app.enter', summary:'Мой вход', entityType:null,entityId:null,details:null },
    { id:'a2', at:new Date(at), userId:8, action:'settings.update',summary:'Чужие настройки',entityType:null,entityId:null,details:null },
    { id:'a3', at:new Date(at), userId:7, action:'booking.created',summary:'Бронь',entityType:'booking',entityId:'10',details:null },
    { id:'a4', at:new Date(at), userId:7, action:'request',summary:'Отправил сообщение',entityType:'chat',entityId:'99',details:{route:'POST /api/openlines/chats/:chatId/send',messageIds:[101]} },
  ];
  const db = {
    workGroupMember:{findMany:vi.fn(async()=>[{kind:'USER',bitrixId:7},{kind:'USER',bitrixId:8}])},
    openlineChat:{findMany:vi.fn(async()=>[{chatId:99,clientName:'Клиент',title:'Чат'}])},
    systemMessage:{findMany:vi.fn(async()=>[{chatId:99,messageId:103,userId:7,sentAt:new Date(at)}])},
    bookingRecord:{findMany:vi.fn(async()=>[{bookingId:10,dealId:10,createdAt:new Date(at),createdByUserId:7},{bookingId:20,dealId:20,createdAt:new Date(at),createdByUserId:8}])},
    actionLog:{findMany:vi.fn(async()=>actions)},
  };
  const listAll = vi.fn(async(method:string)=> {
    if(method==='crm.activity.list')return [
      {ID:'1',START_TIME:at,END_TIME:'2026-10-24T00:11:00Z',COMPLETED:'N',DIRECTION:'1',RESPONSIBLE_ID:8,OWNER_TYPE_ID:2,OWNER_ID:10,SETTINGS:{DURATION:60}},
      {ID:'2',START_TIME:at,END_TIME:'2026-10-24T00:10:30Z',COMPLETED:'N',DIRECTION:'1',RESPONSIBLE_ID:7,OWNER_TYPE_ID:2,OWNER_ID:20,SETTINGS:{DURATION:30}},
    ];
    if(method==='voximplant.statistic.get')return [{CRM_ACTIVITY_ID:'1',PORTAL_USER_ID:'7'},{CRM_ACTIVITY_ID:'2',PORTAL_USER_ID:'8'}];
    if(method==='crm.deal.list')return [{ID:'10',CREATED_BY_ID:7,DATE_CREATE:at,TITLE:'Моя'},{ID:'20',CREATED_BY_ID:8,DATE_CREATE:at,TITLE:'Чужая'}];
    if(method==='user.get')return [{ID:'7',NAME:'Я'},{ID:'8',NAME:'Другой'}];
    return [];
  });
  const batch=vi.fn(async(_commands:Record<string,{method:string;params?:Record<string,unknown>}>)=>({result:{c99:{messages:[
    {id:101,author_id:7,date:at,text:'Мой ответ'}, {id:102,author_id:8,date:at,text:'Чужой ответ'},
    {id:103,author_id:7,date:at,text:'Автоматизация'},
    {id:104,author_id:900,date:at,text:'=== Исходящее сообщение, автор: Кто-то === Общий телефон'},
  ],users:[{id:7},{id:8},{id:900,connector:true}]}},errors:{}}));
  const user={portal:{id:portalId,timezone:'Europe/Moscow',domain:'portal.test'},userId:7,userName:'Я',isAdmin:true,client:{listAll,batch,callV3:vi.fn(async()=>({items:[]}))}} as unknown as B24UserContext;
  return {svc:new ActivityService(db as unknown as PrismaService),db,user,listAll,batch};
}
describe('только мои действия, даже у администратора',()=>{
  it.each(['p1','p2'])('scope текущего сотрудника и портала %s; звонки/сообщения/действия без чужого и автоматики',async(portalId)=>{
    const t=setup(portalId);const data=await t.svc.mine(t.user,{from:'2026-10-24',to:'2026-10-24'},true);
    expect(data.userId).toBe(7);
    expect(data.events.every(e=>e.actorId===7)).toBe(true);
    expect(data.events.some(e=>e.id==='call:1')).toBe(true);
    expect(data.events.some(e=>e.id==='call:2')).toBe(false);
    expect(data.events.filter(e=>e.kind==='message')).toHaveLength(1);
    expect(data.events.some(e=>e.id==='chat:99:101')).toBe(true);
    expect(data.events.filter(e=>e.kind==='booking')).toHaveLength(1);
    expect(JSON.stringify(data.events)).not.toContain('Чуж');
    expect(t.db.workGroupMember.findMany).not.toHaveBeenCalled();
    expect(t.db.actionLog.findMany).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({portalId,userId:{in:[7]},actorKind:'user'})}));
    expect(t.db.bookingRecord.findMany).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({portalId,createdByUserId:{in:[7]}})}));
    const callQuery=t.listAll.mock.calls.find(([m])=>m==='crm.activity.list');
    expect(callQuery).toBeDefined();
  });
  it('сетка0–24 включает ночные звонки COMPLETED=N и фактического сотрудника телефонии',async()=>{
    const t=setup();const data=await t.svc.day(t.user,{date:'2026-10-24'});
    expect([data.fromHour,data.toHour]).toEqual([0,24]);
    const me=data.employees.find(e=>e.userId===7)!;
    expect(me.totals.call).toBe(1);expect(me.hours[3].call).toBe(1);
    expect(me.events.find(e=>e.id==='call:1')?.durationSec).toBe(60);
    expect(t.listAll).toHaveBeenCalledWith('crm.activity.list',expect.objectContaining({filter:expect.not.objectContaining({COMPLETED:'Y'})}),{max:2000});
  });
  it('без openlines.read не читает переписку',async()=>{
    const t=setup();await t.svc.mine(t.user,{from:'2026-10-24',to:'2026-10-24'},false);
    expect(t.db.openlineChat.findMany).not.toHaveBeenCalled();
  });
  it('контроллер игнорирует переданные userId/scope/portalId администратора',async()=>{
    const t=setup(); const mine=vi.fn(async()=>({events:[]}));
    const c=Object.assign(Object.create(OpenlinesController.prototype),{access:{resolve:async()=>({isAppAdmin:true,groups:[]})},activity:{mine}}) as OpenlinesController;
    await c.myActivity(t.user,{from:'2026-10-24',to:'2026-10-24',userId:8,scope:'all',portalId:'p2'});
    expect(mine).toHaveBeenCalledWith(t.user,{from:'2026-10-24',to:'2026-10-24'},true);
  });
  it('находит мой ответ старше первой страницы50сообщений и не берёт предыдущий период',async()=>{
    const t=setup();
    t.batch.mockImplementation(async(commands)=>{
      const before=Number(commands.c99.params?.LAST_ID??0);
      const messages=before?[{id:101,author_id:7,date:at,text:'Мой старый ответ'},{id:1,author_id:7,date:'2026-10-23T20:59:00Z',text:'Другой период'}]:Array.from({length:50},(_,i)=>({id:200-i,author_id:8,date:at,text:'Чужое'}));
      return {result:{c99:{messages,users:[{id:7},{id:8}]}},errors:{}};
    });
    const data=await t.svc.mine(t.user,{from:'2026-10-24',to:'2026-10-24'},true);
    expect(data.events.filter(e=>e.kind==='message')).toHaveLength(1);
    expect(data.events.find(e=>e.messageId===101)?.text).toContain('Мой старый ответ');
    expect(JSON.stringify(data.events)).not.toContain('Другой период');
    expect(t.batch).toHaveBeenCalledTimes(2);
    expect(t.batch.mock.calls[1][0].c99.params?.LAST_ID).toBe(151);
  });
  it('неверный период отклоняется до доступа к источникам',async()=>{
    const t=setup();await expect(t.svc.mine(t.user,{from:'bad',to:'2026-10-24'})).rejects.toThrow();
    expect(t.listAll).not.toHaveBeenCalled();
  });
});
