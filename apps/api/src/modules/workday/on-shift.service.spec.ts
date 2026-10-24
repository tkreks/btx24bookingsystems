import { OnShiftService } from './on-shift.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';

describe('Кто на смене — доступ приложения, текущий статус, tenant',()=>{
  it.each(['p1','p2'])('только открытые и paused из доступа приложения в %s, включая вложенные отделы',async(portalId)=>{
    const prisma={appUser:{findMany:vi.fn(async()=>[{kind:'USER',bitrixId:7},{kind:'DEPARTMENT',bitrixId:10}])},appAdmin:{findMany:vi.fn(async()=>[{kind:'USER',bitrixId:8}])},actionLog:{groupBy:vi.fn(async()=>[{userId:7,_max:{at:new Date('2026-10-24T01:00:00Z')}}])}};
    const batch=vi.fn(async(_commands:Record<string,{method:string}>)=>({result:{u7:{STATUS:'OPENED',TIME_START:'2026-10-24T00:00:00Z'},u8:{STATUS:'CLOSED'},u9:{STATUS:'PAUSED'}},errors:{}}));
    const listAll=vi.fn(async(method:string)=>method==='department.get'?[{ID:'20',PARENT:'10'}]:[{ID:'7',NAME:'Я',ACTIVE:true},{ID:'8',NAME:'Админ',ACTIVE:true},{ID:'9',NAME:'Коллега',UF_DEPARTMENT:['20'],ACTIVE:'Y'},{ID:'11',NAME:'Посторонний',UF_DEPARTMENT:[99],ACTIVE:true}]);
    const user={portal:{id:portalId,domain:'p.test'},userId:7,userName:'Я',client:{batch,listAll}} as unknown as B24UserContext;
    const data=await new OnShiftService(prisma as unknown as PrismaService).list(user);
    expect(data.employees.map(e=>e.userId)).toEqual([7,9]);
    expect(data.employees[0].lastActivityAt).toBe('2026-10-24T01:00:00.000Z');
    expect(data.employees[1].status).toBe('PAUSED');
    expect(prisma.appUser.findMany).toHaveBeenCalledWith(expect.objectContaining({where:{portalId}}));
    expect(prisma.actionLog.groupBy).toHaveBeenCalledWith(expect.objectContaining({where:{portalId,actorKind:'user',userId:{in:[7,8,9]}}}));
    const commands=batch.mock.calls[0][0];
    expect(Object.keys(commands)).toEqual(['u7','u8','u9']);
    expect(Object.values(commands).every(c=>c.method==='timeman.status')).toBe(true);
  });
});
