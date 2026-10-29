import { ContactSyncJob } from './contact-sync.job.js';
it('сбой события сохраняется для повтора, следующие события и периодическая синхронизация продолжаются', async () => {
  const events = [
    { id: 'e1', event: 'ONCRMCONTACTUPDATE', payload: { data: { FIELDS: { ID: '7' } } }, receivedAt: new Date() },
    { id: 'e2', event: 'ONCRMCONTACTUPDATE', payload: { data: { FIELDS: { ID: '8' } } }, receivedAt: new Date() },
  ];
  const update = vi.fn(async () => ({}));
  const findMany = vi.fn(async ({ where }: { where: { status: string } }) => where.status === 'PENDING' ? events : []);
  const refreshContact = vi.fn(async (_p: unknown, _c: unknown, id: number) => { if (id === 7) throw new Error('network'); });
  const syncContacts = vi.fn(async () => undefined);
  const job = new ContactSyncJob({ portal: { findMany: async () => [{ id: 'p1' }] }, bitrix24Event: { findMany, update } } as never, { clientFor: () => ({}) } as never, { refreshContact, syncContacts, reconcileContacts: vi.fn(async () => undefined) } as never);
  await job.tick();
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'e1' }, data: expect.objectContaining({ status: 'FAILED' }) }));
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'e2' }, data: expect.objectContaining({ status: 'PROCESSED' }) }));
  expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ portalId: 'p1', status: 'FAILED' }) }));
  expect(syncContacts).toHaveBeenCalledTimes(2);
});
