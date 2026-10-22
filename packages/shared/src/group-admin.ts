import type { MemberKind } from './access.js';

export interface NamedBitrixItem {
  id: number;
  name: string;
}
/** Отдел из `department.get`; `parentId` — для дерева в выборе участников. */
export interface DepartmentItem extends NamedBitrixItem {
  parentId: number | null;
}
/** Сотрудник для выбора участников: поиск по имени/должности/отделу или состав отдела. */
export interface EmployeeDto extends NamedBitrixItem {
  position: string;
  departmentIds: number[];
}
export interface GroupDirectoryDto {
  users: NamedBitrixItem[];
  resources: NamedBitrixItem[];
  categories: NamedBitrixItem[];
  departments: DepartmentItem[];
  departmentsAvailable: boolean;
}
export interface ExternalUserSummaryDto {
  id: string;
  login: string;
  role: 'VIEWER' | 'TECHNOLOGIST';
  disabled: boolean;
}
export interface ChangeExternalPasswordDto {
  password: string;
}
export type AdminMemberDto = { kind: MemberKind; bitrixId: number };

/** Поле сделки для настройки группы (`GET /api/admin/deal-fields`, из `crm.deal.fields`). */
export interface DealFieldInfo {
  code: string;
  label: string;
  type: string;
  multiple: boolean;
  readOnly: boolean;
  /** Варианты списка (для значения по умолчанию). */
  items?: { id: string; value: string }[];
}
/** Стадия воронки (`GET /api/admin/deal-stages?categoryId=`). */
export interface DealStageItem {
  id: string;
  name: string;
  /** '' — в работе, 'S' — успех, 'F' — провал. */
  semantics: string;
}
/** Товарный каталог (`GET /api/admin/catalog`): разделы и активные товары. */
export interface CatalogDto {
  sections: { id: string; name: string; parentId: string | null }[];
  products: { id: number; name: string; price: number | null; currency: string | null; sectionId: string | null }[];
}
