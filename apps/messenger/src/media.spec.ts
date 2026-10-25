import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { ensureSerializedId } from './messages.js';
import { AVATAR_TTL_MS, avatarKey, MediaStore, MAX_MEDIA_BYTES, defaultName } from './media.js';

describe('MediaStore', () => {
  it('save/meta/read: одинаковый messageId не дублирует, экземпляры изолированы', async () => {
    const dir = await mkdtemp(`${tmpdir()}/btx-media-`);
    try {
      const store = new MediaStore(dir); const bytes = Buffer.from('test image');
      const meta = await store.save('m1', 'msg1', { mimetype:'image/png',filename:'Фото.png',data:bytes.toString('base64') });
      expect(meta).toMatchObject({mime:'image/png',name:'Фото.png',size:bytes.length});
      expect(await store.meta('m1',meta.fileId)).toEqual(meta);
      expect((await store.read('m1',meta.fileId))?.data).toEqual(bytes);
      expect((await store.save('m1','msg1',{mimetype:'image/png',data:bytes.toString('base64')})).fileId).toBe(meta.fileId);
      expect(await store.read('m2',meta.fileId)).toBeNull();
      expect(await store.read('m1','../secret')).toBeNull();
      await expect(store.save('../other','msg1',{mimetype:'text/plain',data:'eA=='})).rejects.toThrow('invalid instance');
      await writeFile(`${dir}/media/m1/${meta.fileId}.json`,'broken'); expect(await store.meta('m1',meta.fileId)).toBeNull();
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
  it('аватар: свежий файл по ключу отдаётся, устаревший — нет', async () => {
    const dir = await mkdtemp(`${tmpdir()}/btx-media-`);
    try {
      const store = new MediaStore(dir);
      expect(await store.recent('m1', avatarKey('1@lid'), AVATAR_TTL_MS)).toBeNull();
      const meta = await store.save('m1', avatarKey('1@lid'), { mimetype: 'image/jpeg', data: Buffer.from('jpg').toString('base64') });
      expect(await store.recent('m1', avatarKey('1@lid'), AVATAR_TTL_MS)).toEqual(meta);
      expect(await store.recent('m1', avatarKey('1@lid'), AVATAR_TTL_MS, Date.now() + AVATAR_TTL_MS + 1000)).toBeNull();
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
  it('отказывает больше 64 МБ до декодирования base64', async () => {
    await expect(new MediaStore('/unused').save('m1','x',{mimetype:'application/octet-stream',data:'a'.repeat(Math.ceil(MAX_MEDIA_BYTES/3)*4+4)})).rejects.toThrow('64 MB');
  });
  it.each([['image/jpeg','image','photo.jpg'],['audio/ogg; codecs=opus','ptt','voice.ogg'],['video/mp4','video','video.mp4']])('имя для %s/%s', (mime,type,name) => expect(defaultName(mime,type)).toBe(name));
});

it('ключ нового WhatsApp для downloadMedia/edit/delete восстанавливается до вызова библиотеки', () => {
  const msg={id:{fromMe:false,remote:{user:'224313525416001',server:'lid'},id:'ABC'}};
  expect(ensureSerializedId(msg)).toBe(msg);
  expect((msg.id as typeof msg.id & {_serialized:string})._serialized).toBe('false_224313525416001@lid_ABC');
  ensureSerializedId(msg);expect(ensureSerializedId({id:'already'}).id).toBe('already');
});
