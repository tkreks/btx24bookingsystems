import { MediaLinks, MEDIA_LINK_TTL_S } from './media-links.js';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
const config = { get: () => Buffer.alloc(32,7).toString('base64') } as unknown as ConfigService<Env,true>;
describe('Подписанные вложения', () => {
  it('подпись привязана к номеру/файлу/сроку, валидна сутки', () => {
    const links = new MediaLinks(config,{appBaseUrl:'https://app.test/'} as never);
    const now=1800000000000; const url=new URL(links.url('m1','f1',now)!); const exp=url.searchParams.get('exp')!,sig=url.searchParams.get('sig')!;
    expect(Number(exp)).toBe(now/1000+MEDIA_LINK_TTL_S);
    expect(links.valid('m1','f1',exp,sig,now)).toBe(true);
    expect(links.valid('m2','f1',exp,sig,now)).toBe(false);
    expect(links.valid('m1','f2',exp,sig,now)).toBe(false);
    expect(links.valid('m1','f1',Number(exp)+1,sig,now)).toBe(false);
    expect(links.valid('m1','f1',exp,'forged',now)).toBe(false);
    expect(links.valid('m1','f1',exp,sig,now+MEDIA_LINK_TTL_S*1000)).toBe(false);
    for(const value of ['NaN','Infinity','1.2',-1])expect(links.valid('m1','f1',value,sig,now)).toBe(false);
    expect(new MediaLinks(config,{} as never).url('m1','f1')).toBeNull();
  });
});
