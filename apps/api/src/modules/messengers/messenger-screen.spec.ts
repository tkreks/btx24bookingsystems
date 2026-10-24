import type { MessengerDto } from '@btx24/shared';
import { MessengerChatsService } from './messenger-chats.service.js';
import { MessengerScreenController } from './messenger-screen.controller.js';

const row = (id: string, groupIds: string[]) => ({ id, portalId: 'p1', kind: 'whatsapp', phone: '7499000000' + id.slice(-1), groupIds, lineMode: null, lineId: null, state: 'ready', auth: 'qr', createdAt: new Date(), connectedAt: null });
const live = (id: string, state: MessengerDto['state'], error: string | null = null) => ({ id, kind: 'whatsapp', phone: '7499000000' + id.slice(-1), title: null, state, error }) as MessengerDto;

function setup(permissions = ['openlines.read', 'openlines.send']) {
  const rows = [row('m1', ['g1']), row('m2', ['g1']), row('m3', ['g1']), row('m4', ['other'])];
  const db = { messenger: { findMany: vi.fn(async () => rows), findFirst: vi.fn(async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null) } };
  const a = { isAppAdmin: false, groups: [{ group: { id: 'g1' }, permissions }] };
  const chats = new MessengerChatsService(db as never, {} as never, {} as never, {} as never, { resolve: vi.fn(async () => a) } as never);
  const messengers = {
    list: vi.fn(async () => [live('m1', 'ready'), live('m2', 'failed', 'Вход не удался'), live('m3', 'starting'), live('m4', 'ready')]),
    vncTicket: vi.fn(async () => 'tkt'),
  };
  const service = { screenFiles: vi.fn(async () => ({ files: [], offer: null })) };
  const ctl = new MessengerScreenController(chats, messengers as never, service as never);
  return { ctl, messengers, service, user: { portal: { id: 'p1' }, userId: 7 } as never };
}

describe('Блок «Мессенджеры» и экран для сотрудника', () => {
  it('только номера групп сотрудника, работающие или с ошибкой (с описанием)', async () => {
    const t = setup();
    expect(await t.ctl.status(t.user)).toEqual([
      expect.objectContaining({ id: 'm1', state: 'ready', error: null, canScreen: true }),
      expect.objectContaining({ id: 'm2', state: 'failed', error: 'Вход не удался', canScreen: true }),
    ]);
  });

  it('без права писать — статус виден, экран и файлы недоступны', async () => {
    const t = setup(['openlines.read']);
    expect((await t.ctl.status(t.user)).map((m) => m.canScreen)).toEqual([false, false]);
    await expect(t.ctl.vncTicket(t.user, 'm1')).rejects.toMatchObject({ status: 403 });
    await expect(t.ctl.files(t.user, 'm1')).rejects.toMatchObject({ status: 403 });
    expect(t.messengers.vncTicket).not.toHaveBeenCalled();
    expect(t.service.screenFiles).not.toHaveBeenCalled();
  });

  it('номер чужой группы — нет экрана; своей — билет VNC', async () => {
    const t = setup();
    await expect(t.ctl.vncTicket(t.user, 'm4')).rejects.toMatchObject({ status: 403 });
    expect(await t.ctl.vncTicket(t.user, 'm1')).toEqual({ url: '/api/messengers/vnc?ticket=tkt' });
    expect(t.messengers.vncTicket).toHaveBeenCalledWith('p1', 7, 'm1');
  });
});
