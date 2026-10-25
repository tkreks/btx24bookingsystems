import { MessengerChatsService } from './messenger-chats.service.js';
function setup() {
 const mine={id:'m1',portalId:'p1',kind:'whatsapp',phone:'74993467272',groupIds:['g1'],lineMode:null,lineId:null,state:'ready',auth:'qr',createdAt:new Date(),connectedAt:null};
 const db={messenger:{findMany:vi.fn(async()=>[mine,{...mine,id:'m2',groupIds:['other']}]),findFirst:vi.fn(async()=>mine)},messengerChat:{findFirst:vi.fn(async()=>null)},messengerMessage:{findFirst:vi.fn(async()=>({b24ChatId:99})),findMany:vi.fn(async()=>[{b24ChatId:99}])}};
 const service={contact:vi.fn(async()=>({exists:true,chatId:'79259734763@c.us'})),send:vi.fn()};
 const a={isAppAdmin:false,groups:[{group:{id:'g1'},permissions:['openlines.read','openlines.send']}]};const access={resolve:vi.fn(async()=>a)};
 const user={portal:{id:'p1'},userId:7,client:{call:vi.fn(async()=>({result:{id:99}}))}};
 const svc=new MessengerChatsService(db as never,service as never,{} as never,{} as never,access as never);
 return {mine,db,service,access,a,user,svc};
}
describe('Read-only messenger discovery and OL permissions',()=>{
 it('search only authorized group numbers and never sends or creates a chat',async()=>{
  const t=setup();const d=await t.svc.search(t.user as never,'89259734763');expect(d.phone).toBe('79259734763');expect(d.results).toHaveLength(1);expect(d.results[0]).toMatchObject({status:'found',canSend:true});
  expect(t.service.contact).toHaveBeenCalledWith('m1','79259734763');expect(t.service.send).not.toHaveBeenCalled();expect(t.db.messenger.findMany).toHaveBeenCalledWith(expect.objectContaining({where:{portalId:'p1'}}));
 });
 it('not found differs from disconnected and read-only employee cannot write',async()=>{
  const t=setup();t.service.contact.mockResolvedValueOnce({exists:false,chatId:null as never});expect((await t.svc.search(t.user as never,'9259734763')).results[0].status).toBe('not_found');
  t.service.contact.mockRejectedValueOnce(new Error('disconnected'));expect((await t.svc.search(t.user as never,'9259734763')).results[0].status).toBe('unavailable');
  t.a.groups[0].permissions=['openlines.read'];expect((await t.svc.search(t.user as never,'9259734763')).results[0].canSend).toBe(false);
 });
 it('known OL chat needs positive portal authorization; absence from local deny list is insufficient',async()=>{
  const t=setup();Object.assign(t.mine,{lineMode:'own',lineId:14});t.user.client.call.mockRejectedValueOnce(new Error('ACCESS_ERROR'));
  await expect(t.svc.forUser(t.user as never,'m1',false,'x@lid')).rejects.toThrow('ACCESS_ERROR');expect(t.user.client.call).toHaveBeenCalledWith('imopenlines.dialog.get',{CHAT_ID:99});
 });
 it('login search checks only Telegram numbers, by login, without CRM phone lookup',async()=>{
  const t=setup();const tg={...t.mine,id:'m3',kind:'telegram',phone:'79895793606'};t.db.messenger.findMany.mockResolvedValueOnce([t.mine,tg] as never);
  (t.service as unknown as {contactByLogin:unknown}).contactByLogin=vi.fn(async()=>({exists:true,chatId:'555@lid'}));
  const d=await t.svc.search(t.user as never,undefined,'@Ivan_Petrov');
  expect(d).toMatchObject({phone:'',login:'Ivan_Petrov'});expect(d.results.map(r=>r.messenger.id)).toEqual(['m3']);expect(d.results[0]).toMatchObject({status:'found',chatId:'555@lid'});
  expect(t.service.contact).not.toHaveBeenCalled();expect(t.db.messengerChat.findFirst).not.toHaveBeenCalled();
  await expect(t.svc.search(t.user as never,'abc')).rejects.toMatchObject({status:400});
 });
 it('foreign portal messenger is not found even for a known ID',async()=>{
  const t=setup();t.db.messenger.findFirst.mockResolvedValueOnce(null as never);await expect(t.svc.own('foreign','m1')).rejects.toMatchObject({status:404});
  expect(t.db.messenger.findFirst).toHaveBeenCalledWith({where:{id:'m1',portalId:'foreign'}});
 });
});
