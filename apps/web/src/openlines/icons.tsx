/** Иконки страницы чатов (контуры из макета `docs/prototype/ui/chat_redesign.html`). */
const PATHS = {
  back: 'm15 18-6-6 6-6M9 12h12',
  search: 'M10.9 3.9a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm5.1 12.1 5 5',
  filter: 'M4 6h16M7 12h10m-7 6h4',
  close: 'M18 6 6 18M6 6l12 12',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  external: 'M13 5h6v6M19 5l-9 9M19 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h4',
  in: 'M6 6v9a3 3 0 0 0 3 3h9m-5-5 5 5-5 5',
  out: 'M18 18V9a3 3 0 0 0-3-3H6m5 5-5-5 5-5',
  send: 'm21 3-7.3 18-3.5-7.2L3 10.3 21 3Zm-10.8 10.8 4.9-4.9',
  clip: 'm20 11.5-8.7 8.7a5 5 0 0 1-7.1-7.1l9.1-9.1a3.3 3.3 0 0 1 4.7 4.7l-9.2 9.2a1.7 1.7 0 0 1-2.4-2.4l8.4-8.4',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}
