import type { PaymentRequestDto } from '@btx24/shared';
import { PAYMENT_STATUS_LABELS } from '@btx24/shared';

/** Статус sent сам по себе не доказывает доставку: без чата ссылка остаётся для ручной отправки. */
export function paymentFeedback(request: Pick<PaymentRequestDto, 'status' | 'messageSent' | 'error'>): string {
  if (request.error) return request.error;
  if (request.status === 'link_pending') return 'Счёт создан. Ждём формирования ссылки.';
  if (request.status === 'sent') return request.messageSent ? 'Ссылка отправлена клиенту. Ждём оплату.' : 'Счёт создан. Ссылка клиенту не отправлена.';
  return PAYMENT_STATUS_LABELS[request.status];
}
