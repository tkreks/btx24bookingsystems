import { formatDuration, type ViewerBookingDto, type ViewerDayDto } from '@btx24/shared';
import { MoneyRows, PaymentsTable, Products, StatusTag, timeRange } from './BookingDetails.js';
import { AlertIcon, CalendarIcon, ClockIcon, CommentIcon, HourglassIcon, GuestsIcon, HouseIcon, Initial, ProgramIcon } from './icons.js';
import { minutesOf, resourceName, timeStatus } from './viewer-model.js';

const dayMonth = (iso: string, tz: string) => new Intl.DateTimeFormat('ru-RU', { timeZone: tz, day: 'numeric', month: 'long' }).format(new Date(iso));

/** Режим «Список»: карточки броней по времени начала; «Подробнее» (или нажатие) — окно со всеми сведениями. */
export function ViewerList({ day, emptyText, onOpen }: { day: ViewerDayDto; emptyText: string; onOpen: (b: ViewerBookingDto) => void }) {
  if (!day.bookings.length) return <p className="vw-empty">{emptyText}</p>;
  const tz = day.timezone;
  return (
    <ul className="vw-list">
      {[...day.bookings]
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
        .map((b) => (
          <li key={b.bookingId} className={`vw-card st-${timeStatus(b)}`}>
            <button type="button" className="vw-card-main" onClick={() => onOpen(b)}>
              <span className="vw-card-head">
                <span className="vw-house">
                  <HouseIcon />
                </span>
                <span className="vw-card-headtext">
                  <span className="vw-title-row">
                    <span className="vw-title">{b.title}</span>
                    <StatusTag b={b} />
                  </span>
                  <span className="vw-when">
                    <span className="vw-ic">
                      <CalendarIcon /> {dayMonth(b.startsAt, tz)}
                    </span>
                    <span className="vw-time-tag">
                      <ClockIcon /> {timeRange(b, tz)}
                    </span>
                  </span>
                </span>
              </span>
              <span className="vw-meta-line">
                <span className="vw-ic vw-resource">
                  <HouseIcon size={16} /> {resourceName(day, b.resourceIds)}
                </span>
                <span className="vw-ic vw-duration">
                  <HourglassIcon /> {formatDuration(minutesOf(b))}
                </span>
                <span className="vw-client">
                  <Initial name={b.clientName} /> {b.clientName ?? 'Не указан'}
                </span>
              </span>
              {(b.guests !== null || b.programGuests !== null) && (
                <span className="vw-guests">
                  {b.guests !== null && (
                    <span className="vw-ic">
                      <GuestsIcon /> Гостей: <b>{b.guests}</b>
                    </span>
                  )}
                  {b.programGuests !== null && (
                    <span className="vw-ic vw-program">
                      <ProgramIcon /> Программы: <b>{b.programGuests}</b>
                    </span>
                  )}
                </span>
              )}
              <MoneyRows b={b} />
              <PaymentsTable b={b} tz={tz} />
              {b.important && (
                <span className="vw-comment-line vw-important-line2" title="Важно">
                  <AlertIcon />
                  <span className="vw-comment-box">
                    <span className="sr-only">Важно: </span>
                    {b.important}
                  </span>
                </span>
              )}
              {b.comment && (
                <span className="vw-comment-line" title="Комментарий">
                  <CommentIcon />
                  <span className="vw-comment-box">{b.comment}</span>
                </span>
              )}
            </button>
            {b.products && (
              <div className="vw-card-products">
                <Products b={b} />
              </div>
            )}
            <button type="button" className="vw-card-more" onClick={() => onOpen(b)}>
              Подробнее
            </button>
          </li>
        ))}
    </ul>
  );
}
