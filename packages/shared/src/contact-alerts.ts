export interface ContactActorDto {
  source: 'bitrix';
  accountId: number | null;
  accountName: string | null;
  accountType: 'employee' | 'system_user' | 'unknown';
  attribution: 'last_editor' | 'unknown';
  application: null;
}
export interface ContactChangeDto { field: string; label?: string; before: unknown; after: unknown }
export interface ContactAlertDto {
  id: string; contactId: number; kind: 'change' | 'deleted' | 'missing'; status: 'new' | 'viewed' | 'resolved' | 'ignored';
  createdAt: string; changes: ContactChangeDto[]; actor: ContactActorDto; restricted: boolean; delivered: boolean; sendError: string | null;
  /** Имя контакта из копии CRM (только если сотруднику виден контакт). */
  contactName?: string | null;
}
export interface ContactAlertListDto { items: ContactAlertDto[]; nextCursor: string | null; counts: Record<'new' | 'viewed' | 'resolved' | 'ignored', number>; chatConfigured: boolean }

/** `POST /api/contact-alerts/bulk` — статус сразу нескольким уведомлениям («Принять все изменения»). */
export interface ContactAlertBulkDto { ids: string[]; status: ContactAlertDto['status'] }
