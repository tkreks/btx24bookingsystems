import { useEffect, useState } from 'react';
import type { ChatChannelsAdminDto } from '@btx24/shared';
import { apiGet, apiPut } from '../api.js';

/**
 * «Каналы линий» (ADR 0017): какой наш номер у каждой открытой линии. Чаты клиента в линиях одного
 * номера (прежний Wazzup и своя линия приложения) — одна переписка в «Чатах».
 */
export function LineChannels() {
  const [data, setData] = useState<ChatChannelsAdminDto | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<number | null>(null);

  useEffect(() => {
    apiGet<ChatChannelsAdminDto>('/admin/chat-channels').then(setData, (e) => setError(e instanceof Error ? e.message : 'Не удалось загрузить'));
  }, []);

  const save = async (lineId: number, channel: string | null) => {
    setBusy(lineId);
    setError('');
    try {
      setData(await apiPut<ChatChannelsAdminDto>(`/admin/chat-channels/${lineId}`, { channel }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось сохранить');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="line-channels">
      <h3>Каналы линий</h3>
      <p className="muted">
        Чаты клиента в линиях одного номера показываются одной перепиской: вся история — в одном чате. Линия без номера — отдельная переписка.
      </p>
      {error && <div className="notice error" role="alert">{error}</div>}
      {!data && !error && <p className="muted">Загрузка…</p>}
      {data && (
        <table className="line-channels-table">
          <thead>
            <tr>
              <th>Линия</th>
              <th>Чатов</th>
              <th>Наш номер</th>
            </tr>
          </thead>
          <tbody>
            {data.lines.map((l) => {
              const own = `line:${l.lineId}`;
              return (
                <tr key={l.lineId}>
                  <td>{l.lineName}</td>
                  <td>{l.chats}</td>
                  <td>
                    <select
                      aria-label={`Номер линии «${l.lineName}»`}
                      value={l.channel}
                      disabled={busy === l.lineId}
                      onChange={(e) => void save(l.lineId, e.target.value)}
                    >
                      <option value={own}>Отдельная переписка линии</option>
                      {data.numbers.map((n) => (
                        <option key={n.channel} value={n.channel}>
                          {n.label}
                        </option>
                      ))}
                    </select>{' '}
                    {l.auto ? (
                      <span className="muted">авто</span>
                    ) : (
                      <button type="button" className="link" disabled={busy === l.lineId} onClick={() => void save(l.lineId, null)}>
                        авто
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
