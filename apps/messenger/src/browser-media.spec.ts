import { cachedMediaFromBrowser } from './browser-media.js';
afterEach(()=>vi.unstubAllGlobals());
it('берёт уже расшифрованный Blob, сохраняет MIME сообщения и имя',async()=>{
  vi.stubGlobal('require',()=>({Msg:{get:()=>({mimetype:'video/mp4',filename:'Видео.mp4',mediaData:{mediaBlob:{getBlob:()=>new Blob(['video'],{type:'application/octet-stream'})}}})}}));
  vi.stubGlobal('WWebJS',{arrayBufferToBase64Async:async(b:ArrayBuffer)=>Buffer.from(b).toString('base64')});
  expect(await cachedMediaFromBrowser('msg',64)).toEqual({mimetype:'video/mp4',filename:'Видео.mp4',data:Buffer.from('video').toString('base64')});
  await expect(cachedMediaFromBrowser('msg',1)).rejects.toThrow('64 МБ');
});
it('не готовое вложение возвращает null',async()=>{
  vi.stubGlobal('require',()=>({Msg:{get:()=>undefined}}));expect(await cachedMediaFromBrowser('msg',64)).toBeNull();
});

it('некэшированное фото скачивается с явным MIME, которого не хватает библиотеке',async()=>{
  const download=vi.fn(async()=>new Uint8Array([255,216,255]).buffer);
  vi.stubGlobal('require',(name:string)=>name==='WAWebCollections'?{Msg:{get:()=>({mimetype:'image/jpeg',type:'image',size:3,mediaKey:'test-key'})}}:{downloadManager:{downloadAndMaybeDecrypt:download}});
  vi.stubGlobal('WWebJS',{arrayBufferToBase64Async:async(b:ArrayBuffer)=>Buffer.from(b).toString('base64')});
  expect(await cachedMediaFromBrowser('msg',64)).toMatchObject({mimetype:'image/jpeg',data:'/9j/'});
  expect(download).toHaveBeenCalledWith(expect.objectContaining({mimetype:'image/jpeg',type:'image',mediaKey:'test-key'}));
});
