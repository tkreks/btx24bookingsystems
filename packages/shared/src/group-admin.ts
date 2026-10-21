import type { MemberKind } from './access.js';

export interface NamedBitrixItem {
  id: number;
  name: string;
}
export interface GroupDirectoryDto {
  users: NamedBitrixItem[];
  resources: NamedBitrixItem[];
  categories: NamedBitrixItem[];
  departments: NamedBitrixItem[];
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
