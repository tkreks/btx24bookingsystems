import { describe, expect, it } from 'vitest';
import { applySendResult, pendingOutgoing, retryGroup, type Outgoing } from './ChatView.js';

const item = (key: string, text: string, fileIds: string[] = []): Outgoing => ({ key, text, files: [], date: '', status: 'sending', ids: [], step: { text, fileIds } });

describe('исходящие сообщения чата', () => {
  it('раскладывает ID по шагам; ошибка — на своём шаге, остальные не ушли', () => {
    const out = applySendResult([item('a', 'привет', ['f1']), item('b', 'цена'), item('c', 'итог')], {
      sent: 1,
      messageIds: [10, 11],
      error: { step: 1, code: 'X', message: 'канал выключен' },
    });
    expect(out.map((o) => [o.status, o.ids, o.error])).toEqual([
      ['sent', [10, 11], undefined],
      ['error', [], 'канал выключен'],
      ['error', [], 'Не отправлено: предыдущее сообщение цепочки не ушло'],
    ]);
  });

  it('ушедшее исчезает, когда все его сообщения пришли в ленте; ошибки остаются', () => {
    const sent = { ...item('a', 'x'), status: 'sent' as const, ids: [10, 11] };
    const failed = { ...item('b', 'y'), status: 'error' as const };
    expect(pendingOutgoing([sent, failed], [{ id: 10 }]).map((o) => o.key)).toEqual(['a', 'b']);
    expect(pendingOutgoing([sent, failed], [{ id: 10 }, { id: 11 }]).map((o) => o.key)).toEqual(['b']);
  });

  it('«Повторить» без ответа сервера — вся пачка с прежним ключом; после ответа — только этот шаг', () => {
    const lost = (key: string) => ({ ...item(key, key), status: 'error' as const, sendKey: 'k1' });
    const a = lost('a');
    const b = lost('b');
    const other = { ...item('c', 'c'), status: 'error' as const, sendKey: 'k2' };
    const answered = { ...item('d', 'd'), status: 'error' as const };
    expect(retryGroup([a, other, b, answered], b).map((o) => o.key)).toEqual(['a', 'b']);
    expect(retryGroup([a, other, b, answered], answered).map((o) => o.key)).toEqual(['d']);
  });
});
