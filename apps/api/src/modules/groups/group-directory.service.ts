import { BadRequestException, Injectable } from '@nestjs/common';
import type {
  CatalogDto,
  DealFieldInfo,
  DealStageItem,
  DepartmentItem,
  EmployeeDto,
  GroupDirectoryDto,
  NamedBitrixItem,
} from '@btx24/shared';
import { z } from 'zod';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { Bitrix24Error } from '../bitrix24/rest/errors.js';

type BitrixUser = {
  ID: string;
  NAME?: string;
  LAST_NAME?: string;
  WORK_POSITION?: string;
  UF_DEPARTMENT?: (number | string)[] | number | string;
  ACTIVE?: boolean | string;
  USER_TYPE?: string;
};

const employeeQuery = z
  .object({
    q: z.string().trim().min(2).max(100).optional(),
    departmentId: z.coerce.number().int().positive().optional(),
  })
  .strict()
  .refine((v) => (v.q === undefined) !== (v.departmentId === undefined));

const fullName = (u: BitrixUser) => [u.NAME, u.LAST_NAME].filter(Boolean).join(' ') || `Сотрудник #${u.ID}`;

@Injectable()
export class GroupDirectoryService {
  constructor(private readonly prisma: PrismaService) {}
  async get(user: B24UserContext): Promise<GroupDirectoryDto> {
    const [resources, categories, departments, users] = await Promise.all([
      user.client.listAll<NamedBitrixItem>(
        'booking.v1.resource.list',
        {},
        {
          pick: (r) => (r as { resource?: NamedBitrixItem[] }).resource ?? [],
        },
      ),
      user.client.listAll<NamedBitrixItem>(
        'crm.category.list',
        { entityTypeId: 2 },
        {
          pick: (r) => (r as { categories?: NamedBitrixItem[] }).categories ?? [],
        },
      ),
      this.departments(user),
      this.users(user),
    ]);
    const named = (rows: NamedBitrixItem[]) =>
      rows.map((r) => ({ id: Number(r.id), name: r.name })).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    return {
      users,
      resources: named(resources),
      categories: named(categories),
      departments: departments.items,
      departmentsAvailable: departments.available,
    };
  }

  private async users(user: B24UserContext): Promise<NamedBitrixItem[]> {
    const [members, admins] = await Promise.all([
      this.prisma.workGroupMember.findMany({
        where: { kind: 'USER', group: { portalId: user.portal.id, archivedAt: null } },
        select: { bitrixId: true },
      }),
      this.prisma.appAdmin.findMany({ where: { portalId: user.portal.id, kind: 'USER' }, select: { bitrixId: true } }),
    ]);
    const ids = [...new Set([...members, ...admins].map((m) => m.bitrixId))];
    if (!ids.length) return [];
    const rows = await user.client.listAll<{ ID: string; NAME?: string; LAST_NAME?: string }>('user.get', {
      FILTER: { ID: ids },
    });
    return rows.map((r) => ({ id: Number(r.ID), name: fullName(r) }));
  }

  /**
   * Сотрудники для выбора участников: `q` — поиск по имени, должности, названию отдела
   * (`user.search`, первые 50); `departmentId` — все активные сотрудники отдела (без вложенных).
   * Уволенные и внешние (экстранет, e-mail) не возвращаются.
   */
  async employees(user: B24UserContext, query: unknown): Promise<EmployeeDto[]> {
    const parsed = employeeQuery.safeParse(query);
    if (!parsed.success)
      throw new BadRequestException({
        code: 'INVALID_EMPLOYEE_QUERY',
        message: 'Укажите строку поиска (от 2 символов) или отдел',
      });
    const { q, departmentId } = parsed.data;
    const rows =
      q !== undefined
        ? ((await user.client.call<BitrixUser[]>('user.search', { FILTER: { FIND: q } })).result ?? [])
        : await user.client.listAll<BitrixUser>('user.get', { FILTER: { UF_DEPARTMENT: departmentId, ACTIVE: true } });
    return rows
      .filter((u) => u.ACTIVE !== false && u.ACTIVE !== 'N' && (u.USER_TYPE ?? 'employee') === 'employee')
      .map((u) => ({
        id: Number(u.ID),
        name: fullName(u),
        position: u.WORK_POSITION ?? '',
        departmentIds: [u.UF_DEPARTMENT ?? []].flat().map(Number).filter(Number.isSafeInteger),
      }))
      .filter((u) => Number.isSafeInteger(u.id) && u.id > 0)
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }

  /** Поля сделки для блока «Поля сделки» группы: код, подпись, тип. */
  async dealFields(user: B24UserContext): Promise<DealFieldInfo[]> {
    type Meta = {
      type?: string;
      isMultiple?: boolean;
      isReadOnly?: boolean;
      title?: string;
      formLabel?: string;
      listLabel?: string;
      items?: { ID: string | number; VALUE: string }[];
    };
    const res = await user.client.call<Record<string, Meta>>('crm.deal.fields');
    return Object.entries(res.result ?? {})
      .map(([code, m]) => ({
        code,
        label: m.formLabel || m.listLabel || m.title || code,
        type: m.type ?? 'string',
        multiple: Boolean(m.isMultiple),
        readOnly: Boolean(m.isReadOnly),
        ...(m.type === 'enumeration' ? { items: (m.items ?? []).map((i) => ({ id: String(i.ID), value: i.VALUE })) } : {}),
      }))
      .sort((a, b) => a.label.localeCompare(b.label, 'ru'));
  }

  /** Стадии воронки по порядку: общая воронка — `DEAL_STAGE`, остальные — `DEAL_STAGE_<id>`. */
  async dealStages(user: B24UserContext, query: unknown): Promise<DealStageItem[]> {
    const parsed = z.object({ categoryId: z.coerce.number().int().nonnegative() }).strict().safeParse(query);
    if (!parsed.success)
      throw new BadRequestException({ code: 'INVALID_CATEGORY', message: 'Укажите воронку (categoryId)' });
    const { categoryId } = parsed.data;
    const rows = await user.client.listAll<{
      STATUS_ID: string;
      NAME: string;
      SORT?: string;
      SEMANTICS?: string | null;
    }>('crm.status.list', {
      filter: { ENTITY_ID: categoryId === 0 ? 'DEAL_STAGE' : `DEAL_STAGE_${categoryId}` },
      order: { SORT: 'ASC' },
    });
    return rows
      .sort((a, b) => Number(a.SORT ?? 0) - Number(b.SORT ?? 0))
      .map((r) => ({ id: r.STATUS_ID, name: r.NAME, semantics: r.SEMANTICS ?? '' }));
  }

  /**
   * Каталог для товаров по умолчанию и разделов группы. `crm.product*` устарели, но работают с
   * правом `crm` (у `catalog.*` — отдельное право, которого у приложения нет); так делал прототип.
   */
  async catalog(user: B24UserContext): Promise<CatalogDto> {
    const [sections, products] = await Promise.all([
      user.client.listAll<{ ID: string; NAME: string; SECTION_ID?: string | null }>('crm.productsection.list', {
        select: ['ID', 'NAME', 'SECTION_ID'],
        order: { NAME: 'ASC' },
      }),
      user.client.listAll<{
        ID: string;
        NAME: string;
        PRICE?: string | null;
        CURRENCY_ID?: string | null;
        SECTION_ID?: string | null;
      }>('crm.product.list', {
        select: ['ID', 'NAME', 'PRICE', 'CURRENCY_ID', 'SECTION_ID'],
        filter: { ACTIVE: 'Y' },
        order: { NAME: 'ASC' },
      }),
    ]);
    return {
      sections: sections.map((s) => ({
        id: String(s.ID),
        name: s.NAME,
        parentId: s.SECTION_ID ? String(s.SECTION_ID) : null,
      })),
      products: products.map((p) => ({
        id: Number(p.ID),
        name: p.NAME,
        price: p.PRICE === null || p.PRICE === undefined || p.PRICE === '' ? null : Number(p.PRICE),
        currency: p.CURRENCY_ID ?? null,
        sectionId: p.SECTION_ID ? String(p.SECTION_ID) : null,
      })),
    };
  }

  private async departments(user: B24UserContext) {
    try {
      const rows = await user.client.listAll<{ ID: string; NAME: string; PARENT?: string | null }>('department.get');
      const items: DepartmentItem[] = rows.map((r) => ({
        id: Number(r.ID),
        name: r.NAME,
        parentId: r.PARENT ? Number(r.PARENT) : null,
      }));
      return { items, available: true };
    } catch (err) {
      // Отсутствие scope не должно мешать назначать сотрудников поимённо.
      if (
        err instanceof Bitrix24Error &&
        ['insufficient_scope', 'ACCESS_DENIED', 'ERROR_METHOD_NOT_FOUND'].includes(err.code)
      )
        return { items: [], available: false };
      throw err;
    }
  }
}
