import { Injectable } from '@nestjs/common';
import type { OnShiftDto } from '@btx24/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { photoUrl } from '../bitrix24/rest/photo-url.js';
import { WorkdayService, type RawWorkday } from './workday.service.js';

/** Текущая смена, независимо от периода дашборда. Чужими сменами здесь нельзя управлять. */
@Injectable()
export class OnShiftService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workday?: WorkdayService,
  ) {}

  async list(user: B24UserContext): Promise<OnShiftDto> {
    const portalId = user.portal.id;
    const [appUsers, admins] = await Promise.all([
      this.prisma.appUser.findMany({ where: { portalId }, select: { kind: true, bitrixId: true } }),
      this.prisma.appAdmin.findMany({ where: { portalId }, select: { kind: true, bitrixId: true } }),
    ]);
    const selectors = [...appUsers, ...admins];
    const ids = new Set(selectors.filter((s) => s.kind === 'USER').map((s) => s.bitrixId));
    ids.add(user.userId); // Авторизованный сотрудник сам имеет доступ, включая администратора портала.
    const depts = new Set(selectors.filter((s) => s.kind === 'DEPARTMENT').map((s) => s.bitrixId));
    const notes: string[] = [];
    type Person = { ID: string; NAME?: string; LAST_NAME?: string; PERSONAL_PHOTO?: string; UF_DEPARTMENT?: (number|string)[]|number|string; ACTIVE?: boolean | string };
    const departments=(p:Person)=>Array.isArray(p.UF_DEPARTMENT)?p.UF_DEPARTMENT:p.UF_DEPARTMENT===undefined?[]:[p.UF_DEPARTMENT];
    let people: Person[];
    if (depts.size) {
      const tree = await user.client.listAll<{ID:string;PARENT?:string}>('department.get').catch(() => []);
      for (let guard=0;guard<100;guard++) {
        const children=tree.filter(d=>depts.has(Number(d.PARENT))&&!depts.has(Number(d.ID)));
        if(!children.length)break;children.forEach(d=>depts.add(Number(d.ID)));
      }
      people = await user.client.listAll<Person>('user.get', { FILTER: { ACTIVE: true } });
      people = people.filter(p=>ids.has(Number(p.ID))||departments(p).some(d=>depts.has(Number(d))));
    } else people = await user.client.listAll<Person>('user.get', { FILTER: { ID: [...ids], ACTIVE: true } });
    const visible = new Map(people.filter(p=>p.ACTIVE!==false&&p.ACTIVE!=='N'&&(ids.has(Number(p.ID))||departments(p).some(d=>depts.has(Number(d))))).map(p=>[Number(p.ID),p]));
    if(!visible.has(user.userId))visible.set(user.userId,{ID:String(user.userId),NAME:user.userName});
    const staffIds=[...visible.keys()];
    const [statuses, activity] = await Promise.all([
      user.client.batch(Object.fromEntries(staffIds.map(id=>[`u${id}`,{method:'timeman.status',params:{USER_ID:id}}]))),
      this.prisma.actionLog.groupBy({ by:['userId'], where:{portalId,actorKind:'user',userId:{in:staffIds}}, _max:{at:true} }),
    ]);
    const last = new Map(activity.map(a=>[a.userId,a._max.at?.toISOString()??null]));
    // Смены из Битрикс24 — и в базу приложения: день закрыли в Битрикс24 — закрыт и у нас.
    if (this.workday) for (const id of staffIds) { const raw = statuses.result[`u${id}`] as RawWorkday | undefined; if (raw?.STATUS) await this.workday.applyBitrix(portalId, id, raw).catch(() => undefined); }
    const employees: OnShiftDto['employees']=[];
    for(const [id,p]of visible){
      const day=statuses.result[`u${id}`] as {STATUS?:string;TIME_START?:string}|undefined;
      if(day?.STATUS!=='OPENED'&&day?.STATUS!=='PAUSED')continue;
      const time=Date.parse(day.TIME_START??'');
      employees.push({userId:id,name:[p.NAME,p.LAST_NAME].filter(Boolean).join(' ')||`Сотрудник #${id}`,photo:photoUrl(p.PERSONAL_PHOTO,user.portal.domain),status:day.STATUS,timeStart:Number.isFinite(time)?new Date(time).toISOString():null,lastActivityAt:last.get(id)??null});
    }
    if(Object.keys(statuses.errors).length)notes.push('Часть смен недоступна по правам Битрикс24.');
    return {employees:employees.sort((a,b)=>Number(b.status==='OPENED')-Number(a.status==='OPENED')||(b.lastActivityAt??'').localeCompare(a.lastActivityAt??'')||a.name.localeCompare(b.name,'ru')),notes};
  }
}
