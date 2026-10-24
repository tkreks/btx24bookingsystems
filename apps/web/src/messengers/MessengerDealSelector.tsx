import { useEffect, useState } from 'react';
import type { MessengerClientContextDto } from '@btx24/shared';
import { MessengerChatsDialog } from './MessengerChatsDialog.js';
import { apiGet, apiPut } from '../api.js';
/** Только собственный коннектор; чужие провайдеры не переназначаем. */
export function MessengerDealSelector({ chatId, timezone }: { chatId: number; timezone: string }) {
  const [state, setState] = useState<{ id: number; ctx: MessengerClientContextDto } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let active = true;
    const load = () => apiGet<MessengerClientContextDto>(`/messengers/openlines/${chatId}/context`).then(ctx => { if (active) setState({ id: chatId, ctx }); }, () => undefined);
    void load(); const timer = setInterval(() => void load(), 15_000);
    return () => { active = false; clearInterval(timer); };
  }, [chatId]);
  const ctx = state?.id === chatId ? state.ctx : null;
  if (!ctx || !ctx.deals.some(d => d.active)) return null;
  return <div className="mc-context"><label>Сделка входящих сообщений <select aria-label="Сделка клиента" value={ctx.activeDealId ?? ''} disabled={busy} onChange={async e => {
    setBusy(true);
    try { const next = await apiPut<MessengerClientContextDto>(`/messengers/openlines/${chatId}/deal`, { dealId: Number(e.target.value) }); setState({ id: chatId, ctx: next }); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось выбрать сделку'); }
    finally { setBusy(false); }
  }}><option value="" disabled>Выберите сделку</option>{ctx.deals.filter(d => d.active).map(d => <option key={d.id} value={d.id}>#{d.id} · {d.title}</option>)}</select></label>
  {ctx.needsChoice && <p className="notice">У клиента несколько активных сделок. Выберите сделку обращения.</p>}{error && <p className="notice error">{error}</p>}
  {ctx.messenger && ctx.chatId && <button type="button" onClick={() => setOpen(true)}>Переписка по сделкам</button>}
  {open && ctx.messenger && ctx.chatId && <MessengerChatsDialog messenger={ctx.messenger} initialChatId={ctx.chatId} timezone={timezone} admin={false} onClose={() => setOpen(false)} />}
  </div>;
}
