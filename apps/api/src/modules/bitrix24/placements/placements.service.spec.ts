import { PlacementsService } from './placements.service.js';
import type { Bitrix24RestClient } from '../rest/rest-client.js';

function client(bound: { placement: string; handler: string }[]) {
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  const c = {
    call: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === 'placement.get') return { result: bound };
      if (method === 'placement.bind') {
        bound.push({ placement: String(params!.PLACEMENT), handler: String(params!.HANDLER) });
        return { result: true };
      }
      throw new Error(method);
    }),
  };
  return { c: c as unknown as Bitrix24RestClient, calls };
}

describe('PlacementsService', () => {
  const svc = new PlacementsService({ appBaseUrl: 'https://app.example.ru', trustedOAuthHosts: [], readOnly: true });

  it('reports which placements point at our handler', async () => {
    const { c } = client([{ placement: 'CRM_DEAL_DETAIL_TAB', handler: 'https://app.example.ru/' }, { placement: 'LEFT_MENU', handler: 'https://old.example/booking-local/app' }]);
    const st = await svc.status(c);
    expect(st.filter((s) => s.bound).map((s) => s.placement)).toEqual(['CRM_DEAL_DETAIL_TAB']);
  });

  it('binds only missing placements and is idempotent', async () => {
    const { c, calls } = client([{ placement: 'CRM_DEAL_DETAIL_TAB', handler: 'https://app.example.ru/' }]);
    const st = await svc.sync(c);
    expect(calls.filter((x) => x.method === 'placement.bind').map((x) => x.params!.PLACEMENT)).toEqual(['CRM_DEAL_DETAIL_TOOLBAR', 'LEFT_MENU']);
    expect(st.every((s) => s.bound)).toBe(true);
    await svc.sync(c);
    expect(calls.filter((x) => x.method === 'placement.bind')).toHaveLength(2);
  });
});
