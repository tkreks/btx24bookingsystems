import { useSyncExternalStore } from 'react';

/**
 * Сообщение со ссылкой на оплату, которое отправляется в фоне (решение владельца 2026-10-31): после
 * «Отправить» окно оплаты закрывается, открывается чат сделки, и там сразу видно это сообщение со статусом
 * «отправляется» → «отправлено» / ошибка. Счёт и ссылка при этом создаются на сервере.
 */
export interface PendingPaymentSend {
  id: string;
  dealId: number;
  text: string;
  files: string[];
  date: string;
  status: 'sending' | 'sent' | 'error';
  error?: string;
}

let items: PendingPaymentSend[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** Показать сообщение «отправляется»; возвращает идентификатор для `finishPendingPayment`. */
export function startPendingPayment(p: Pick<PendingPaymentSend, 'dealId' | 'text' | 'files'>): string {
  const id = crypto.randomUUID();
  items = [...items, { ...p, id, date: new Date().toISOString(), status: 'sending' }];
  emit();
  return id;
}

export function finishPendingPayment(id: string, result: { ok: true } | { ok: false; error: string }): void {
  items = items.map((x) => (x.id === id ? { ...x, status: result.ok ? 'sent' : 'error', error: result.ok ? undefined : result.error } : x));
  emit();
}

export function dropPendingPayment(id: string): void {
  items = items.filter((x) => x.id !== id);
  emit();
}

/** Текст для ленты чата: ссылка, которой ещё нет, — подпись «ссылка на оплату». */
export function pendingText(text: string): string {
  return text.replace(/\{link\}|\{\{\s*СсылкаНаОплату\s*\}\}|\{=Variable:paymentlink[^}]*\}/gi, '🔗 ссылка на оплату');
}

export function usePendingPayments(dealId: number): PendingPaymentSend[] {
  const all = useSyncExternalStore(subscribe, () => items);
  return all.filter((x) => x.dealId === dealId);
}
