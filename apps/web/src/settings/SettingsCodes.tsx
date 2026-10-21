import { useEffect, useState } from 'react';
import type { SettingsCodeCreatedDto, SettingsCodeDto } from '@btx24/shared';
import { apiDelete, apiGet, apiPost } from '../api.js';
import { fmtDateTime } from '../format.js';

const HOURS = [1, 4, 8, 24, 72];

/** ⚙ → «Приложение»: временные пароли к настройкам (выдают постоянные администраторы). */
export function SettingsCodes({ timezone }: { timezone: string }) {
  const [list, setList] = useState<SettingsCodeDto[] | null>(null);
  const [hours, setHours] = useState(4);
  const [created, setCreated] = useState<SettingsCodeCreatedDto | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  // Момент загрузки списка — для статусов «истёк» (без вызова Date.now() при каждом рендере).
  const [now, setNow] = useState(() => Date.now());

  const load = () =>
    apiGet<SettingsCodeDto[]>('/admin/settings-codes').then((l) => {
      setList(l);
      setNow(Date.now());
    }, (e) =>
      setError(e instanceof Error ? e.message : 'Не удалось загрузить пароли'),
    );
  useEffect(() => {
    let active = true;
    apiGet<SettingsCodeDto[]>('/admin/settings-codes').then(
      (l) => active && setList(l),
      (e) => active && setError(e instanceof Error ? e.message : 'Не удалось загрузить пароли'),
    );
    return () => {
      active = false;
    };
  }, []);

  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await f();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось выполнить');
    } finally {
      setBusy(false);
    }
  };

  const status = (c: SettingsCodeDto) =>
    c.revokedAt
      ? 'отозван'
      : Date.parse(c.expiresAt) <= now
        ? 'истёк'
        : c.usedByUserId
          ? `действует у сотрудника #${c.usedByUserId}`
          : 'не использован';

  return (
    <section className="settings-card">
      <h3>Временный доступ к настройкам</h3>
      <p className="muted">
        Пароль одноразовый: первый, кто его введёт (кнопка «Настройки» на дашборде), получает права администратора
        приложения до конца срока. Создавать пароли и менять список администраторов по временному доступу нельзя.
      </p>
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      <div className="bp-import">
        <label>
          Срок
          <select value={hours} onChange={(e) => setHours(Number(e.target.value))}>
            {HOURS.map((h) => (
              <option key={h} value={h}>
                {h} ч
              </option>
            ))}
          </select>
        </label>
        <button
          className="primary"
          disabled={busy}
          onClick={() => void run(async () => setCreated(await apiPost<SettingsCodeCreatedDto>('/admin/settings-codes', { hours })))}
        >
          Создать пароль
        </button>
      </div>
      {created && (
        <div className="notice temp-code">
          Пароль: <b className="code">{created.code}</b> — действует до {fmtDateTime(created.expiresAt, timezone)}. Он
          показан один раз — передайте сотруднику.{' '}
          <button
            type="button"
            className="link"
            onClick={() => {
              void navigator.clipboard?.writeText(created.code).then(() => setCopied(true));
            }}
          >
            {copied ? 'Скопировано' : 'Скопировать'}
          </button>
        </div>
      )}
      {list && list.length > 0 && (
        <ul className="codes-list">
          {list.map((c) => (
            <li key={c.id}>
              <span>
                до {fmtDateTime(c.expiresAt, timezone)} · <span className="muted">{status(c)}</span>
              </span>
              {!c.revokedAt && Date.parse(c.expiresAt) > now && (
                <button disabled={busy} onClick={() => void run(() => apiDelete(`/admin/settings-codes/${c.id}`))}>
                  Отозвать
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
