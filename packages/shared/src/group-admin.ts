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
