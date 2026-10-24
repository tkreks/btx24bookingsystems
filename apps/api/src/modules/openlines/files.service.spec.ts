import { FilesService, MAX_FILE_BYTES } from './files.service.js';
import { Bitrix24Error } from '../bitrix24/rest/errors.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';

function setup(portalId = 'p1') {
  const prisma = {
    storedFile: { create: vi.fn(async ({ data }: { data: { name: string; mime: string; size: number } }) => ({ id: 'saved', name: data.name, mime: data.mime, size: data.size })), findMany: vi.fn(async () => []), deleteMany: vi.fn() },
    messageTemplate: { findMany: vi.fn(async () => []) },
    workGroup: { findMany: vi.fn(async () => []) },
  };
  const client = { call: vi.fn(async () => ({ result: { ID: '99', TYPE: 'file', NAME: 'Правила.pdf', SIZE: '3', DOWNLOAD_URL: 'https://portal/rest/download.json?auth=secret' } })), download: vi.fn(async () => ({ data: Buffer.from('pdf'), contentType: 'application/pdf' })), listAll: vi.fn(async () => [{ ID: '99', TYPE: 'file', NAME: 'Правила.pdf', SIZE: '3' }]) };
  const user = { portal: { id: portalId }, userId: 7, client } as unknown as B24UserContext;
  return { svc: new FilesService(prisma as unknown as PrismaService), prisma, client, user };
}
describe('Вложения из Диска', () => {
  it.each(['p1', 'p2'])('читает файл пользовательским клиентом и сохраняет копию в портале %s', async (portalId) => {
    const t = setup(portalId);
    expect(await t.svc.importDisk(t.user, { fileId: 99 })).toEqual({ id: 'saved', name: 'Правила.pdf', mime: 'application/pdf', size: 3 });
    expect(t.client.call).toHaveBeenCalledWith('disk.file.get', { id: 99 });
    expect(t.client.download).toHaveBeenCalledWith(expect.any(String), MAX_FILE_BYTES);
    expect(t.prisma.storedFile.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ portalId, ownerUserId: 7, name: 'Правила.pdf', data: new Uint8Array(Buffer.from('pdf')) }) }));
  });
  it('не принимает URL/tenant/имя от браузера', async () => {
    const t = setup();
    await expect(t.svc.importDisk(t.user, { fileId: 99, url: 'https://evil/x' })).rejects.toThrow();
    await expect(t.svc.importDisk(t.user, { fileId: 99, portalId: 'p2' })).rejects.toThrow();
    expect(t.client.call).not.toHaveBeenCalled();
  });
  it('ошибка прав не приводит к загрузке токеном приложения', async () => {
    const t = setup(); t.client.call.mockRejectedValue(new Bitrix24Error('ACCESS_DENIED', 'denied'));
    await expect(t.svc.importDisk(t.user, { fileId: 99 })).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(t.client.download).not.toHaveBeenCalled(); expect(t.prisma.storedFile.create).not.toHaveBeenCalled();
  });
  it('ограничивает размер до скачивания и сообщает об отсутствии scope', async () => {
    const t = setup(); t.client.call.mockResolvedValueOnce({ result: { TYPE: 'file', SIZE: String(MAX_FILE_BYTES + 1), DOWNLOAD_URL: 'https://portal/file' } } as never);
    await expect(t.svc.importDisk(t.user, { fileId: 99 })).rejects.toThrow('Файл больше 10 МБ');
    expect(t.client.download).not.toHaveBeenCalled();
    t.client.call.mockRejectedValueOnce(new Bitrix24Error('insufficient_scope', 'no disk'));
    await expect(t.svc.importDisk(t.user, { fileId: 99 })).rejects.toThrow('Для выбора файлов');
  });
  it('обзор папок отдаёт страницу и продолжение; поиск выполняется на портале', async () => {
    const t = setup();
    t.client.call.mockResolvedValueOnce({ result: [{ ID: '99', TYPE: 'file', NAME: 'Правила.pdf', SIZE: '3' }], next: 100 } as never);
    expect(await t.svc.disk(t.user, { folderId: '6', offset: '50', q: 'Правила' })).toEqual({ items: [{ id: 99, kind: 'file', name: 'Правила.pdf', size: 3 }], nextOffset: 100 });
    expect(t.client.call).toHaveBeenCalledWith('disk.folder.getChildren', { id: 6, order: { NAME: 'ASC', ID: 'ASC' }, start: 50, filter: { NAME: '%Правила%' } });
    await expect(t.svc.disk(t.user, { folderId: 6, storageId: 9 })).rejects.toThrow();
  });
  it('копия подтверждения в группе не удаляется как разовое вложение', async () => {
    const t = setup();
    t.prisma.workGroup.findMany.mockResolvedValue([{ options: { bookingTypes: [{ confirmation: [{ files: [{ storedFileId: 'kept', name: 'Прайс' }] }] }] } }] as never);
    await t.svc.dropUnused(t.user, ['kept', 'orphan']);
    expect(t.prisma.storedFile.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['orphan'] }, portalId: 'p1', ownerUserId: 7 } });
  });
});
