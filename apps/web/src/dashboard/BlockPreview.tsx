import type { ReactNode } from 'react';
import type { DashboardBlockType } from '@btx24/shared';
import { BLOCK_PREVIEWS, type BlockPreviewSpec } from './block-catalog.js';

/**
 * Схематичный эскиз блока для каталога «Добавить блок» / «Заменить блок»: как блок выглядит на
 * дашборде (число, строки, график, шкала…), без данных. Цвета — только токены темы через классы
 * `.bsk-*` в styles.css, поэтому тёмная тема работает сама.
 */
export function BlockPreview({ type, size = 'card' }: { type: DashboardBlockType; size?: 'card' | 'large' }) {
  const spec = BLOCK_PREVIEWS[type];
  return (
    <svg className={`bsk bsk-${size} tone-${spec.tone ?? 'primary'}`} viewBox="0 0 200 120" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">
      <rect className="bsk-frame" x="3" y="3" width="194" height="114" rx="10" />
      <rect className="bsk-bar" x="12" y="11" width="64" height="5" rx="2.5" />
      <rect className="bsk-bar2" x="168" y="11" width="20" height="5" rx="2.5" />
      {sketch(spec)}
    </svg>
  );
}

/** Полоска-«текст». */
const T = (x: number, y: number, w: number, cls = 'bsk-bar', h = 5) => <rect className={cls} x={x} y={y} width={w} height={h} rx={h / 2} />;

function sketch(s: BlockPreviewSpec): ReactNode {
  switch (s.kind) {
    case 'stat':
      return <Stat s={s} />;
    case 'compare':
      return <Compare s={s} />;
    case 'list':
      return <List s={s} />;
    case 'chart':
      return <Chart s={s} />;
    case 'sources':
      return <Sources />;
    case 'timeline':
      return <Timeline now={!!s.now} />;
    case 'kpi':
      return <Kpi />;
    case 'log':
      return <Log mine={!!s.mine} />;
    case 'people':
      return <People />;
    case 'activity':
      return <Activity />;
    case 'messengers':
      return <Messengers />;
    case 'duplicates':
      return <Duplicates />;
    case 'alerts':
      return <Alerts />;
    case 'certificates':
      return <Certificates />;
    case 'stops':
      return <Stops />;
  }
}

function LeadIcon({ lead, x, y }: { lead: BlockPreviewSpec['lead']; x: number; y: number }) {
  switch (lead) {
    case 'phone':
      return (
        <g>
          <circle className="bsk-soft" cx={x} cy={y} r="7" />
          <path className="bsk-stroke" d={`M${x - 3} ${y - 3}q0 6 6 6`} />
        </g>
      );
    case 'deal':
      return (
        <g>
          <rect className="bsk-soft" x={x - 7} y={y - 7} width="14" height="14" rx="3.5" />
          <rect className="bsk-acc" x={x - 3.5} y={y - 1} width="7" height="5" rx="1" />
        </g>
      );
    case 'chat':
      return (
        <g>
          <circle className="bsk-avatar" cx={x} cy={y} r="7" />
          <path className="bsk-acc" d={`M${x + 3} ${y + 3}h6v-5a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2Z`} />
        </g>
      );
    case 'time':
      return (
        <g>
          <rect className="bsk-soft" x={x - 8} y={y - 5} width="20" height="10" rx="3" />
          {T(x - 4, y - 1.5, 12, 'bsk-acc', 3)}
        </g>
      );
    default:
      return <circle className="bsk-avatar" cx={x} cy={y} r="7" />;
  }
}

function Stat({ s }: { s: BlockPreviewSpec }) {
  const [a, b] = (s.value ?? '0').split(' / ');
  if (b)
    return (
      <g>
        <text className="bsk-num" x="22" y="72" fontSize="34">
          {a}
        </text>
        {T(22, 84, 44, 'bsk-bar2')}
        <rect className="bsk-line" x="99.5" y="40" width="1" height="54" />
        <text className="bsk-num bsk-num-muted" x="118" y="72" fontSize="34">
          {b}
        </text>
        {T(118, 84, 38, 'bsk-bar2')}
        <rect className="bsk-soft" x="22" y="98" width="60" height="9" rx="4.5" />
      </g>
    );
  return (
    <g>
      {s.lead && <LeadIcon lead={s.lead} x={26} y={40} />}
      <text className="bsk-num" x="18" y="86" fontSize="42">
        {a}
      </text>
      {T(20, 96, 70, 'bsk-bar2')}
      <polyline className="bsk-stroke bsk-thick" points="118,90 132,80 146,84 160,66 174,70 186,52" />
      <circle className="bsk-acc" cx="186" cy="52" r="3" />
    </g>
  );
}

function Compare({ s }: { s: BlockPreviewSpec }) {
  return (
    <g>
      <text className="bsk-num" x="14" y="62" fontSize="32">
        {s.value}
      </text>
      <rect className="bsk-soft" x="104" y="38" width="38" height="16" rx="8" />
      <path className="bsk-acc" d={s.down ? 'M112 42h10l-5 7Z' : 'M112 50h10l-5-7Z'} />
      {T(125, 44, 12, 'bsk-acc', 4)}
      {T(14, 74, 30, 'bsk-bar2', 4)}
      <rect className="bsk-acc" x="52" y="72" width="120" height="8" rx="4" />
      {T(14, 90, 30, 'bsk-bar2', 4)}
      <rect className="bsk-bar" x="52" y="88" width="88" height="8" rx="4" />
      {T(14, 104, 50, 'bsk-bar2', 4)}
    </g>
  );
}

function List({ s }: { s: BlockPreviewSpec }) {
  const widths = [78, 62, 86, 54];
  const status = ['bsk-bar2', 'bsk-acc', 'bsk-soft', 'bsk-soft'];
  return (
    <g>
      {widths.map((w, i) => {
        const y = 32 + i * 21;
        return (
          <g key={i} className={s.strike ? 'bsk-faded' : undefined}>
            {i > 0 && <rect className="bsk-line" x="12" y={y - 6} width="176" height="0.8" />}
            <LeadIcon lead={s.lead} x={20} y={y + 4} />
            {T(36, y, w, 'bsk-ink')}
            {T(36, y + 8, w * 0.6, 'bsk-bar2', 4)}
            {s.strike && <rect className="bsk-acc" x="34" y={y + 2} width={w + 4} height="1.4" />}
            <Trail trail={s.trail} y={y + 4} i={i} status={status[i]} />
          </g>
        );
      })}
    </g>
  );
}

function Trail({ trail, y, i, status }: { trail: BlockPreviewSpec['trail']; y: number; i: number; status: string }) {
  switch (trail) {
    case 'badge':
      return i < 2 ? <circle className="bsk-acc" cx="182" cy={y} r="5" /> : T(168, y - 2, 18, 'bsk-bar2', 4);
    case 'time':
      return T(166, y - 2, 20, 'bsk-bar2', 4);
    case 'amount':
      return (
        <g>
          {T(150, y - 4, 32, 'bsk-ink', 5)}
          {T(162, y + 3, 20, i % 2 ? 'bsk-ok' : 'bsk-bar2', 3)}
        </g>
      );
    case 'status':
      return <rect className={status} x="156" y={y - 5} width="30" height="10" rx="5" />;
    case 'warn':
      return <path className="bsk-acc" d={`M181 ${y - 6}l6 11h-12Z`} />;
    case 'check':
      return (
        <g>
          <rect className="bsk-soft" x="160" y={y - 6} width="26" height="12" rx="6" />
          <path className="bsk-stroke" d={`M168 ${y}l3 3 6-6`} />
        </g>
      );
    default:
      return null;
  }
}

function Chart({ s }: { s: BlockPreviewSpec }) {
  const grid = [34, 58, 82, 106].map((y) => <rect key={y} className="bsk-line" x="14" y={y} width="174" height="0.8" />);
  if (s.bars) {
    const a = [40, 56, 32, 64, 48, 70, 44, 58];
    const b = [12, 18, 8, 22, 14, 10, 16, 12];
    return (
      <g>
        {grid}
        {a.map((h, i) => (
          <g key={i}>
            <rect className="bsk-acc" x={20 + i * 21} y={106 - h} width="8" height={h} rx="2" />
            <rect className="bsk-danger" x={29 + i * 21} y={106 - b[i]} width="8" height={b[i]} rx="2" />
          </g>
        ))}
      </g>
    );
  }
  return (
    <g>
      {grid}
      <path className="bsk-area" d="M14 90 L38 78 L62 84 L86 60 L110 68 L134 46 L158 54 L188 36 V106 H14Z" />
      <polyline className="bsk-stroke bsk-thick" points="14,90 38,78 62,84 86,60 110,68 134,46 158,54 188,36" />
      <polyline className="bsk-stroke-ok" points="14,100 38,94 62,96 86,84 110,88 134,74 158,80 188,66" />
      <polyline className="bsk-stroke-muted" points="14,104 38,102 62,98 86,100 110,94 134,96 158,90 188,92" />
    </g>
  );
}

function Sources() {
  const rows = [150, 112, 84, 60, 34];
  return (
    <g>
      {rows.map((w, i) => {
        const y = 28 + i * 17;
        return (
          <g key={i}>
            {T(12, y + 2, 26, 'bsk-bar2', 4)}
            <rect className={i ? 'bsk-soft' : 'bsk-acc'} x="42" y={y} width={w - 20} height="9" rx="3" />
            {T(42 + w - 16, y + 2, 12, 'bsk-ink', 4)}
          </g>
        );
      })}
    </g>
  );
}

function Timeline({ now }: { now: boolean }) {
  const rows = [
    [
      [48, 40],
      [118, 50],
    ],
    [[70, 64]],
    [
      [40, 26],
      [96, 36],
      [150, 30],
    ],
    [[124, 58]],
  ];
  const nowX = 132;
  return (
    <g>
      {[40, 64, 88, 112, 136, 160, 184].map((x) => (
        <g key={x}>
          <rect className="bsk-line" x={x} y="24" width="0.8" height="88" />
          {T(x - 5, 22, 10, 'bsk-bar2', 3)}
        </g>
      ))}
      {rows.map((r, i) => {
        const y = 32 + i * 20;
        return (
          <g key={i}>
            {T(10, y + 4, 22, 'bsk-bar')}
            {r.map(([x, w], j) => {
              const live = x <= nowX && x + w >= nowX;
              const cls = now ? (live ? 'bsk-acc' : 'bsk-soft') : i === 3 ? 'bsk-stop' : j % 2 ? 'bsk-soft-strong' : 'bsk-acc';
              return <rect key={j} className={cls} x={x} y={y} width={w} height="13" rx="3" />;
            })}
          </g>
        );
      })}
      {now && (
        <g>
          <rect className="bsk-danger" x={nowX - 0.8} y="24" width="1.6" height="90" />
          <circle className="bsk-danger" cx={nowX} cy="25" r="3" />
        </g>
      )}
    </g>
  );
}

function Kpi() {
  const nums = ['14', '6', '23', '41', '7', '2'];
  return (
    <g>
      {nums.map((n, i) => {
        const x = 12 + (i % 3) * 60;
        const y = 24 + Math.floor(i / 3) * 46;
        return (
          <g key={i}>
            <rect className="bsk-cell" x={x} y={y} width="56" height="42" rx="7" />
            <text className={`bsk-num${i === 5 ? ' bsk-num-danger' : ''}`} x={x + 8} y={y + 25} fontSize="20">
              {n}
            </text>
            {T(x + 8, y + 31, 36, 'bsk-bar2', 4)}
          </g>
        );
      })}
    </g>
  );
}

function Log({ mine }: { mine: boolean }) {
  const w = [96, 74, 108, 66];
  return (
    <g>
      <rect className="bsk-line" x="44.5" y="30" width="1" height="80" />
      {w.map((x, i) => {
        const y = 30 + i * 21;
        return (
          <g key={i}>
            <text className="bsk-time" x="12" y={y + 7} fontSize="8">
              {['09:12', '10:40', '12:05', '14:31'][i]}
            </text>
            <circle className={mine || i % 2 === 0 ? 'bsk-acc' : 'bsk-avatar'} cx="45" cy={y + 4} r="4" />
            {!mine && <circle className="bsk-avatar" cx="60" cy={y + 4} r="6" />}
            {T(mine ? 56 : 72, y, x, 'bsk-ink')}
            {T(mine ? 56 : 72, y + 8, x * 0.55, 'bsk-bar2', 4)}
          </g>
        );
      })}
    </g>
  );
}

function People() {
  return (
    <g>
      {[0, 1, 2, 3].map((i) => {
        const y = 32 + i * 21;
        return (
          <g key={i} className={i === 3 ? 'bsk-faded' : undefined}>
            <circle className="bsk-avatar" cx="22" cy={y + 4} r="8" />
            <circle className={i === 3 ? 'bsk-bar' : 'bsk-ok'} cx="28" cy={y + 10} r="3.2" />
            {T(38, y, [70, 58, 80, 52][i], 'bsk-ink')}
            {T(38, y + 8, 40, 'bsk-bar2', 4)}
            {T(160, y + 2, 26, i === 3 ? 'bsk-bar2' : 'bsk-ok', 5)}
          </g>
        );
      })}
    </g>
  );
}

function Activity() {
  const spans = [
    [20, 90],
    [36, 70],
    [10, 110],
    [60, 50],
  ];
  return (
    <g>
      {spans.map(([s, w], i) => {
        const y = 30 + i * 21;
        return (
          <g key={i}>
            <circle className="bsk-avatar" cx="20" cy={y + 5} r="7" />
            {T(32, y + 3, 26, 'bsk-bar')}
            <rect className="bsk-soft" x="64" y={y} width="96" height="10" rx="3" />
            <rect className="bsk-acc" x={64 + s * 0.6} y={y} width={w * 0.6} height="10" rx="3" />
            {T(166, y + 3, 10, 'bsk-ink', 4)}
            {T(180, y + 3, 8, 'bsk-bar2', 4)}
          </g>
        );
      })}
    </g>
  );
}

function Messengers() {
  const tiles = ['bsk-ok', 'bsk-acc', 'bsk-violet', 'bsk-ok'];
  return (
    <g>
      {tiles.map((cls, i) => {
        const x = 12 + (i % 2) * 90;
        const y = 26 + Math.floor(i / 2) * 44;
        return (
          <g key={i}>
            <rect className="bsk-cell" x={x} y={y} width="86" height="38" rx="8" />
            <circle className={cls} cx={x + 16} cy={y + 19} r="9" />
            <path className="bsk-on-acc" d={`M${x + 11} ${y + 23}l1.4-4a5 5 0 1 1 2.2 2.2Z`} />
            {T(x + 30, y + 12, 44, 'bsk-ink')}
            <circle className={i === 3 ? 'bsk-danger' : 'bsk-ok'} cx={x + 33} cy={y + 26} r="2.6" />
            {T(x + 39, y + 24, 28, 'bsk-bar2', 4)}
          </g>
        );
      })}
    </g>
  );
}

function Duplicates() {
  const card = (x: number, y: number, key: string) => (
    <g key={key}>
      <rect className="bsk-cell" x={x} y={y} width="70" height="38" rx="7" />
      <circle className="bsk-avatar" cx={x + 13} cy={y + 13} r="6" />
      {T(x + 23, y + 9, 38, 'bsk-ink', 4)}
      {T(x + 23, y + 16, 26, 'bsk-bar2', 3)}
      {T(x + 8, y + 26, 46, 'bsk-soft-strong', 5)}
    </g>
  );
  return (
    <g>
      {[24, 70].map((y, i) => (
        <g key={y} className={i ? 'bsk-faded' : undefined}>
          {card(10, y, 'a')}
          {card(104, y, 'b')}
          <path className="bsk-stroke bsk-dash" d={`M80 ${y + 19}H104`} />
          <circle className="bsk-acc" cx="92" cy={y + 19} r="6" />
          <path className="bsk-on-acc-stroke" d={`M89 ${y + 17.5}h6M89 ${y + 20.5}h6`} />
          <rect className="bsk-acc" x="180" y={y + 12} width="12" height="14" rx="4" />
        </g>
      ))}
    </g>
  );
}

function Alerts() {
  const icons = ['warn', 'danger', 'info', 'warn'];
  return (
    <g>
      {icons.map((k, i) => {
        const y = 30 + i * 21;
        return (
          <g key={i}>
            {k === 'warn' ? (
              <path className="bsk-acc" d={`M20 ${y - 2}l7 12h-14Z`} />
            ) : (
              <circle className={k === 'danger' ? 'bsk-danger' : 'bsk-info'} cx="20" cy={y + 4} r="6" />
            )}
            {T(34, y, [92, 70, 110, 64][i], 'bsk-ink')}
            {T(34, y + 8, 56, 'bsk-bar2', 4)}
            {T(166, y + 2, 20, 'bsk-bar2', 4)}
          </g>
        );
      })}
    </g>
  );
}

function Certificates() {
  return (
    <g>
      {[0, 1].map((i) => {
        const x = 12 + i * 92;
        return (
          <g key={i}>
            <rect className="bsk-cell" x={x} y="26" width="84" height="56" rx="7" />
            <rect className={i ? 'bsk-danger' : 'bsk-acc'} x={x} y="26" width="6" height="56" rx="3" />
            {T(x + 14, 36, 50, 'bsk-ink')}
            {T(x + 14, 46, 36, 'bsk-bar2', 4)}
            <text className="bsk-num" x={x + 14} y="72" fontSize="14">
              {i ? '3 000' : '5 000'}
            </text>
            <path className={i ? 'bsk-danger' : 'bsk-acc'} d={`M${x + 66} 62v14l5-3 5 3v-14Z`} />
          </g>
        );
      })}
      <rect className="bsk-soft" x="12" y="92" width="44" height="12" rx="6" />
      <rect className="bsk-danger-soft" x="62" y="92" width="64" height="12" rx="6" />
    </g>
  );
}

function Stops() {
  return (
    <g>
      {[0, 1, 2].map((i) => {
        const y = 30 + i * 28;
        return (
          <g key={i}>
            <circle className="bsk-acc" cx="20" cy={y + 8} r="7" />
            <rect className="bsk-on-acc" x="16" y={y + 7} width="8" height="2" rx="1" />
            {T(34, y + 1, [70, 56, 84][i], 'bsk-ink')}
            <rect className="bsk-stop" x="34" y={y + 10} width={[120, 80, 140][i]} height="8" rx="3" />
          </g>
        );
      })}
    </g>
  );
}
