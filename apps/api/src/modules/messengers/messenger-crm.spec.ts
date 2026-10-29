import { MessengerCrmService } from './messenger-crm.service.js';
import type { Messenger } from '../../generated/prisma/client.js';
import type { Bitrix24RestClient } from '../bitrix24/rest/rest-client.js';
const M = { id:'m1', portalId:'p1' } as Messenger;
function setup(deals = [11,12], closed = new Set<number>()) {
 const chat={portalId:'p1',messengerId:'m1',chatId:'x@lid',phone:'79259734763',activeDealId:null as number|null,crmMatchedAt:null as Date|null,crmMatch:null as unknown};
 const db={portalSettings:{findUnique:vi.fn(async()=>null)},portal:{findFirst:vi.fn(async()=>({id:'p1',status:'ACTIVE'}))},messengerChat:{findFirst:vi.fn(async()=>chat),findUnique:vi.fn(async()=>chat),upsert:vi.fn(async({update}:{update:object})=>Object.assign(chat,update)),updateMany:vi.fn(async({data}:{data:object})=>{Object.assign(chat,data);return {count:1};})},messengerMessage:{count:vi.fn(async()=>2),updateMany:vi.fn(async()=>({count:2}))},$transaction:vi.fn(async(fn:(tx:unknown)=>Promise<void>)=>fn(db))};
 const client={call:vi.fn(async(method:string,p:Record<string,unknown>)=>{
  if(method==='crm.duplicate.findbycomm')return {result:{CONTACT:[7]}};
  if(method==='crm.contact.list')return {result:[{ID:'7',NAME:'Клиент'}]};
  if(method==='crm.deal.list')return {result:deals.map(id=>({ID:String(id),TITLE:`Deal ${id}`,CONTACT_ID:'7',STAGE_SEMANTIC_ID:closed.has(id)?'S':'P'}))};
  throw new Error(String(p));
 })};
 const portals={clientFor:vi.fn(()=>client)};
 const crm=new MessengerCrmService(db as never,portals as never);
 const user={portal:{id:'p1'},userId:9,client} as never;
 return {crm,db,client,chat,user};
}
describe('CRM matching and deal snapshots',()=>{
 it('matches RU variants and filters active deals by contacts, never queries the whole portal',async()=>{
  const t=setup([11]);const route=await t.crm.route(M,'x@lid');expect(route).toEqual({dealId:11,awaitingDeal:false});
  expect(t.client.call).toHaveBeenCalledWith('crm.duplicate.findbycomm',{type:'PHONE',values:['+79259734763','89259734763','79259734763']});
  expect(t.client.call).toHaveBeenCalledWith('crm.deal.list',expect.objectContaining({filter:{'@CONTACT_ID':[7],STAGE_SEMANTIC_ID:'P'}}));
  expect(t.db.messengerChat.updateMany).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({portalId:'p1',messengerId:'m1'})}));
 });
 it('several deals require employee choice, pending messages only are claimed',async()=>{
  const t=setup();expect(await t.crm.route(M,'x@lid')).toEqual({dealId:null,awaitingDeal:true});
  await expect(t.crm.sending(t.user,M,'x@lid')).rejects.toMatchObject({status:409});
  const ctx=await t.crm.choose(t.user,M,'x@lid',12);expect(ctx.activeDealId).toBe(12);
  expect(t.db.messengerMessage.updateMany).toHaveBeenCalledWith({where:{portalId:'p1',messengerId:'m1',chatId:'x@lid',awaitingDeal:true},data:{dealId:12,awaitingDeal:false}});
  expect(await t.crm.route(M,'x@lid')).toEqual({dealId:12,awaitingDeal:false});
  await expect(t.crm.sending(t.user,M,'x@lid',11)).rejects.toMatchObject({status:409});
 });
 it('CRM failure does not count as an unknown client and does not permit automatic CRM creation',async()=>{
  const t=setup();t.client.call.mockRejectedValue(new Error('CRM unavailable'));
  expect(await t.crm.route(M,'x@lid')).toEqual({dealId:null,awaitingDeal:true});
  expect(t.db.messengerChat.updateMany).not.toHaveBeenCalled();
 });
 it('employee CRM permissions determine candidates; invalid and invisible deal cannot be selected',async()=>{
  const t=setup([11]);await expect(t.crm.choose(t.user,M,'x@lid',12)).rejects.toMatchObject({status:400});
  expect(t.db.$transaction).not.toHaveBeenCalled();
 });
 it('no phone/contact never becomes an unfiltered CRM deal query',async()=>{
  const t=setup();const client={call:vi.fn(async()=>({result:{}}))};
  expect(await t.crm.match(client as unknown as Bitrix24RestClient,'79259734763',true)).toEqual({contacts:[],deals:[]});
  expect(client.call).toHaveBeenCalledTimes(1);
 });
 it('read context uses employee client, no application CRM credentials for the request',async()=>{
  const t=setup([11]);const ctx=await t.crm.context(t.user,M,'x@lid');expect(ctx.deals.map(d=>d.id)).toEqual([11]);expect(ctx.needsChoice).toBe(true);
 });
 it('завершённая выбранная сделка остаётся только в истории, новые сообщения требуют активную',async()=>{
  const t=setup([11,12],new Set([11]));t.chat.activeDealId=11;
  const ctx=await t.crm.context(t.user,M,'x@lid');expect(ctx.activeDealId).toBeNull();expect(ctx.needsChoice).toBe(true);
  await expect(t.crm.sending(t.user,M,'x@lid',11)).rejects.toMatchObject({status:409});
 });

});
