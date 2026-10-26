import type { DealKind } from '@btx24/shared';

type GroupIconKind = 'sauna' | 'house' | 'water' | 'gazebo' | 'other';

/** Иконка группы по названию: баня, домик, домик на воде, беседка; иначе — общая. */
export function groupIconKind(name: string): GroupIconKind {
  const n = name.toLocaleLowerCase('ru');
  if (/бан|саун|хаммам|пар/.test(n)) return 'sauna';
  if (/на воде|плав|понтон/.test(n)) return 'water';
  if (/бесед|шат|навес/.test(n)) return 'gazebo';
  if (/дом|коттедж|изб|номер/.test(n)) return 'house';
  return 'other';
}

const GROUP_PATHS: Record<GroupIconKind, string> = {
  // Баня: таз и пар.
  sauna: 'M4 14h16l-1.5 6h-13zM8 10c-1-1.5 1-2.5 0-4M12 10c-1-1.5 1-2.5 0-4M16 10c-1-1.5 1-2.5 0-4',
  house: 'M3 11l9-7 9 7M5 9.5V20h14V9.5M10 20v-5h4v5',
  // Домик на воде: домик над волной.
  water: 'M4 10l8-6 8 6M6 8.5V15h12V8.5M10 15v-3.5h4V15M2 19c2 0 2-1.5 4-1.5s2 1.5 4 1.5 2-1.5 4-1.5 2 1.5 4 1.5 2-1.5 4-1.5',
  // Беседка: крыша и столбы.
  gazebo: 'M3 9l9-5 9 5zM5 9v11M19 9v11M3 20h18M8 15h8',
  other: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
};

const KIND_PATHS: Record<DealKind, string> = {
  // Посещение: календарь с галочкой.
  visit: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4M9 15l2 2 4-4',
  // Покупка сертификата: подарок.
  certificate: 'M4 10h16v10H4zM3 7h18v3H3zM12 7v13M12 7c-1.5-3-5-3-5-1s3 1 5 1c2 0 5 1 5-1s-3.5-2-5 1',
  // Бронирование сертификатом: билет.
  by_certificate: 'M3 7h18v3a2 2 0 0 0 0 4v3H3v-3a2 2 0 0 0 0-4zM14 7v10',
  // Без оплаты: перечёркнутая монета.
  no_payment: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM5.5 5.5l13 13M10 9h3a2 2 0 0 1 0 4h-3V8v8',
};

function Svg({ d, size }: { d: string; size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export const GroupIcon = ({ name, size = 22 }: { name: string; size?: number }) => <Svg d={GROUP_PATHS[groupIconKind(name)]} size={size} />;
export const DealKindIcon = ({ kind, size = 22 }: { kind: DealKind; size?: number }) => <Svg d={KIND_PATHS[kind]} size={size} />;
