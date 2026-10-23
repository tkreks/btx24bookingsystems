import { DEAL_STATUS_LABELS, NEEDS_CLOSE_TEXT, type DealStatusDto } from '@btx24/shared';

const HINT: Record<DealStatusDto['status'], string> = {
  in_work: 'Сделка в работе, активной брони нет',
  waiting: 'У сделки есть активная бронь — ждём клиента',
  done: 'Сделка завершена',
  failed: 'Сделка провалена',
};

/**
 * Статус сделки (канбан + брони): «В работе», «Ожидание клиента», «Завершена», «Провалена». Бронь прошла,
 * а в канбане сделка ещё в работе — «Завершена» и красный «!» с подсказкой закрыть сделку в Битрикс24.
 */
export function DealStatusBadge({ s }: { s: DealStatusDto | null | undefined }) {
  if (!s) return null;
  return (
    <span className="deal-status-wrap">
      <span className={`deal-status ${s.status}`} title={s.needsClose ? NEEDS_CLOSE_TEXT : HINT[s.status]}>
        {DEAL_STATUS_LABELS[s.status]}
      </span>
      {s.needsClose && (
        <span className="deal-close" title={NEEDS_CLOSE_TEXT} role="note">
          <b aria-hidden="true">!</b> закройте сделку в Битрикс24
        </span>
      )}
    </span>
  );
}
