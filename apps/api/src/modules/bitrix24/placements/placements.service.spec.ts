import { PlacementsService } from './placements.service.js';
import type { Bitrix24RestClient } from '../rest/rest-client.js';

function client(bound: { placement: string; handler: string }[], events: { event: string; handler: string }[] = []) {
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  const c = {
    call: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === 'placement.get') return { result: bound };
      if (method === 'event.get') return { result: events };
      if (method === 'placement.bind') {
        bound.push({ placement: String(params!.PLACEMENT), handler: String(params!.HANDLER) });
        return { result: true };
      }
      if (method === 'placement.unbind') {
        bound.splice(0, bound.length, ...bound.filter((b) => b.placement !== params!.PLACEMENT));
        return { result: { count: 1 } };
      }
      if (method === 'event.bind') {
        events.push({ event: String(params!.event), handler: String(params!.handler) });
        return { result: true };
      }
      if (method === 'event.unbind') {
        events.splice(0, events.length, ...events.filter((e) => e.event !== params!.event));
        return { result: { count: 1 } };
      }
      throw new Error(method);
    }),
  };
  return { c: c as unknown as Bitrix24RestClient, calls };
}

describe('PlacementsService', () => {
  const svc = new PlacementsService({ appBaseUrl: 'https://app.example.ru', trustedOAuthHosts: [], readOnly: true, sandbox: null });

  it('reports which placements and call events point at our handlers', async () => {
    const { c } = client(
      [{ placement: 'CRM_DEAL_DETAIL_TAB', handler: 'https://app.example.ru/' }, { placement: 'LEFT_MENU', handler: 'https://old.example/booking-local/app' }],
      [{ event: 'ONVOXIMPLANTCALLSTART', handler: 'https://app.example.ru/api/b24/events' }],
    );
    const st = await svc.status(c);
    expect(st.placements.filter((s) => s.bound).map((s) => s.placement)).toEqual(['CRM_DEAL_DETAIL_TAB']);
    expect(st.events.filter((e) => e.bound).map((e) => e.event)).toEqual(['ONVOXIMPLANTCALLSTART']);
  });

  it('binds only missing placements (incl. the call card) and call events; idempotent; rebind re-creates all', async () => {
    const { c, calls } = client([{ placement: 'CRM_DEAL_DETAIL_TAB', handler: 'https://app.example.ru/' }]);
    const st = await svc.sync(c);
    expect(calls.filter((x) => x.method === 'placement.bind').map((x) => x.params!.PLACEMENT)).toEqual(['CRM_DEAL_DETAIL_TOOLBAR', 'LEFT_MENU', 'CALL_CARD']);
    expect(calls.filter((x) => x.method === 'event.bind').map((x) => x.params!.event)).toEqual([
      'ONVOXIMPLANTCALLINIT',
      'ONVOXIMPLANTCALLSTART',
      'ONVOXIMPLANTCALLEND',
      'ONBOOKINGADD',
      'ONBOOKINGUPDATE',
      'ONBOOKINGDELETE',
      'ONCRMDEALADD',
      'ONCRMDEALUPDATE',
      'ONCRMDEALDELETE',
    ]);
    expect(st.placements.every((s) => s.bound) && st.events.every((e) => e.bound)).toBe(true);
    await svc.sync(c);
    expect(calls.filter((x) => x.method === 'placement.bind')).toHaveLength(3);
    const again = await svc.rebind(c);
    expect(calls.filter((x) => x.method === 'placement.unbind')).toHaveLength(4);
    expect(calls.filter((x) => x.method === 'placement.bind')).toHaveLength(7);
    expect(again.placements.every((s) => s.bound)).toBe(true);
  });
});
