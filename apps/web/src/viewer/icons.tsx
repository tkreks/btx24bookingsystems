/** Иконки экрана «Бронирования» (inline SVG, цвет — currentColor). */
const svg = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };

/** Домик с печной трубой — ресурс брони. */
export const HouseIcon = ({ size = 22 }: { size?: number }) => (
  <svg {...svg} width={size} height={size}>
    <path d="M3 11.5 12 4l9 7.5" />
    <path d="M16 7.3V4.5h2.5v4.9" />
    <path d="M5.5 9.8V20h13V9.8" />
    <path d="M10 20v-5.5h4V20" />
  </svg>
);

/** Двое — гости. */
export const GuestsIcon = () => (
  <svg {...svg}>
    <circle cx="9" cy="8" r="3" />
    <path d="M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5" />
    <circle cx="16.5" cy="9" r="2.5" />
    <path d="M15.5 14.2c2.7-.3 5 1.6 5 4.3" />
  </svg>
);

/** Трое — гости программы. */
export const ProgramIcon = () => (
  <svg {...svg}>
    <circle cx="12" cy="7.5" r="2.7" />
    <path d="M7.5 18.5c0-2.7 2-4.6 4.5-4.6s4.5 1.9 4.5 4.6" />
    <circle cx="5.5" cy="10" r="2.1" />
    <path d="M2 18c0-2.2 1.5-3.7 3.5-3.7" />
    <circle cx="18.5" cy="10" r="2.1" />
    <path d="M22 18c0-2.2-1.5-3.7-3.5-3.7" />
  </svg>
);

/** Облачко — комментарий. */
export const CommentIcon = () => (
  <svg {...svg}>
    <path d="M4 5.5h16v10H9l-4.5 3.5v-3.5H4z" />
  </svg>
);

const AVATAR_COLORS = ['#2563eb', '#7c3aed', '#db2777', '#ea580c', '#0d9488', '#16a34a', '#0891b2', '#9333ea'];

/** Кружок с первой буквой имени клиента (цвет — по имени, стабильный). */
export function Initial({ name }: { name: string | null }) {
  const text = (name ?? '').trim();
  const letter = text ? text[0].toLocaleUpperCase('ru') : '?';
  let h = 0;
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (
    <span className="vw-initial" style={{ background: text ? AVATAR_COLORS[h % AVATAR_COLORS.length] : '#9ca3af' }} aria-hidden="true">
      {letter}
    </span>
  );
}

/** «i» в круге — основная информация. */
export const InfoIcon = () => (
  <svg {...svg}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5.5M12 7.6v.2" />
  </svg>
);

/** Треугольник с «!» — важное. */
export const AlertIcon = () => (
  <svg {...svg}>
    <path d="M12 3.5 21 19.5H3z" />
    <path d="M12 10v4.5M12 17.2v.2" />
  </svg>
);

/** Кошелёк — финансы. */
export const WalletIcon = () => (
  <svg {...svg}>
    <path d="M4 7.5h14.5a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18z" />
    <path d="M4 7.5 15.5 4.5v3" />
    <path d="M16 13.5h.5" />
  </svg>
);

/** Коробка — товары и услуги. */
export const BoxIcon = () => (
  <svg {...svg}>
    <path d="M3.5 7.5 12 3.5l8.5 4v9L12 20.5l-8.5-4z" />
    <path d="M3.5 7.5 12 11.5l8.5-4M12 11.5v9" />
  </svg>
);

/** Решётка — дополнительные сведения (номера). */
export const HashIcon = () => (
  <svg {...svg}>
    <path d="M9 4 7 20M17 4l-2 16M4.5 9h16M3.5 15h16" />
  </svg>
);

/** Календарь — дата. */
export const CalendarIcon = ({ size = 18 }: { size?: number }) => (
  <svg {...svg} width={size} height={size}>
    <rect x="3.5" y="5" width="17" height="15" rx="2" />
    <path d="M3.5 9.5h17M8 3v4M16 3v4" />
  </svg>
);

/** Круглые часы — время брони. */
export const ClockIcon = () => (
  <svg {...svg} width={14} height={14}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </svg>
);

/** Песочные часы — длительность. */
export const HourglassIcon = () => (
  <svg {...svg}>
    <path d="M6.5 3.5h11M6.5 20.5h11" />
    <path d="M7.5 3.5c0 4 4.5 5.5 4.5 8.5s-4.5 4.5-4.5 8.5M16.5 3.5c0 4-4.5 5.5-4.5 8.5s4.5 4.5 4.5 8.5" />
  </svg>
);
