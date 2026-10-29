import { connectorLabel } from './format.js';
import { channelProvider } from './channel-error.js';

const CHANNEL_COLORS: Record<string, string> = {
  WhatsApp: '#18be72',
  Telegram: '#249fdf',
  Instagram: '#e94a8d',
  Viber: '#8354c9',
  ВКонтакте: '#1686e9',
  MAX: '#506df5',
  Авито: '#00aaff',
  'Онлайн-чат': '#3269f6',
};

/** Метка канала: цветная точка с первой буквой + название. */
export function Channel({ connector }: { connector: string }) {
  const label = connectorLabel(connector);
  return (
    <span className="cl-channel">
      <span className="cl-channel-dot" style={{ background: CHANNEL_COLORS[label] ?? '#7e95bd' }} aria-hidden="true">
        {label === 'ВКонтакте' ? 'vk' : label[0]}
      </span>
      <span className="cl-channel-label">{label}{channelProvider(connector) ? ` · ${channelProvider(connector)}` : ''}</span>
    </span>
  );
}

/** «Все каналы»: значки каналов, наложенные друг на друга (одинаковые названия — один значок). */
export function ChannelStack({ connectors, label = 'Все каналы' }: { connectors: string[]; label?: string }) {
  const labels = [...new Set(connectors.map(connectorLabel))].slice(0, 5);
  return (
    <span className="cl-channel cl-channel-stack" title={labels.join(', ')}>
      <span className="cl-channel-dots" aria-hidden="true">
        {labels.map((l, i) => (
          <span key={l} className="cl-channel-dot" style={{ background: CHANNEL_COLORS[l] ?? '#7e95bd', zIndex: labels.length - i }}>
            {l === 'ВКонтакте' ? 'vk' : l[0]}
          </span>
        ))}
      </span>
      <span className="cl-channel-label">{label}</span>
    </span>
  );
}
