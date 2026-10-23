// Сертификаты (решение владельца 2026-10-23): номер, номинал, на чьё имя, статус, дата оплаты, срок
// действия; действия — выпуск, изменение срока, погашение (использован / истёк).

export const CERTIFICATE_STATUSES = ['new', 'used', 'expired'] as const;
export type CertificateStatus = (typeof CERTIFICATE_STATUSES)[number];

export const CERTIFICATE_STATUS_LABELS: Record<CertificateStatus, string> = {
  new: 'Новый',
  used: 'Использован',
  expired: 'Истёк',
};

/** Причина погашения = итоговый статус. */
export type CertificateRedeemReason = Exclude<CertificateStatus, 'new'>;

export type CertificateAction = 'issued' | 'changed' | 'redeemed';
export const CERTIFICATE_ACTION_LABELS: Record<CertificateAction, string> = {
  issued: 'Выпуск',
  changed: 'Изменение срока',
  redeemed: 'Погашение',
};

/** Номер: буквы, цифры и дефис, до 32 знаков (хранится в верхнем регистре). */
export const CERTIFICATE_NUMBER = /^[A-Za-zА-Яа-яЁё0-9-]{1,32}$/;

export interface CertificateDto {
  id: string;
  number: string;
  nominal: number;
  holderName: string;
  status: CertificateStatus;
  /** День оплаты (YYYY-MM-DD) или null. */
  paidOn: string | null;
  /** Действителен по этот день включительно (YYYY-MM-DD). */
  validUntil: string;
  /** Новый, а срок уже прошёл — пора погасить как «истёк». */
  overdue: boolean;
  dealId: number | null;
  comment: string | null;
  createdAt: string;
  redeemedAt: string | null;
}

export interface CertificateEventDto {
  id: string;
  action: CertificateAction;
  at: string;
  userName: string;
  /** Что изменилось: «срок 01.05.2027 → 01.08.2027», «причина: использован». */
  text: string;
}

export interface CertificateListDto {
  items: CertificateDto[];
  counts: Record<CertificateStatus | 'all' | 'overdue', number>;
  /** Может выпускать, менять и погашать (администратор приложения или право `payment.send`). */
  canManage: boolean;
  /** Показаны не все (больше лимита) — сузьте поиск. */
  truncated: boolean;
}

export interface CertificateDetailsDto extends CertificateDto {
  events: CertificateEventDto[];
}

export interface IssueCertificateInput {
  /** Пусто — следующий свободный номер. */
  number?: string;
  nominal: number;
  holderName: string;
  paidOn?: string | null;
  validUntil: string;
  dealId?: number | null;
  comment?: string | null;
}

export interface ChangeCertificateInput {
  validUntil: string;
  comment?: string | null;
}

export interface RedeemCertificateInput {
  reason: CertificateRedeemReason;
  comment?: string | null;
}
