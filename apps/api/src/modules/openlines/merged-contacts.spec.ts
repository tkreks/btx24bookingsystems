import { describe, expect, it } from 'vitest';
import { followMergedContacts } from './merged-contacts.js';

const prisma = (deleted: number[], deals: { dealId: number; contactId: number | null }[]) =>
  ({
    crmEntity: { findMany: async ({ where }: { where: { entityId: { in: number[] } } }) => deleted.filter((id) => where.entityId.in.includes(id)).map((entityId) => ({ entityId })) },
    crmDeal: { findMany: async ({ where }: { where: { dealId: { in: number[] } } }) => deals.filter((d) => where.dealId.in.includes(d.dealId)) },
  }) as unknown as Parameters<typeof followMergedContacts>[0];
const links = (contactId: number | null, dealId: number | null) => ({ leadId: null, contactId, companyId: null, dealId });

describe('followMergedContacts', () => {
  it('replaces a merged (deleted) contact with the deal contact', async () => {
    const l = links(54984, 40144);
    await followMergedContacts(prisma([54984], [{ dealId: 40144, contactId: 54982 }]), 'p', [l]);
    expect(l.contactId).toBe(54982);
  });

  it('keeps live contacts, deal-less chats and deals not yet moved', async () => {
    const live = links(54982, 40144);
    const noDeal = links(54984, null);
    const notMoved = links(54990, 40150);
    await followMergedContacts(prisma([54984, 54990], [{ dealId: 40144, contactId: 54982 }, { dealId: 40150, contactId: 54990 }]), 'p', [live, noDeal, notMoved]);
    expect([live.contactId, noDeal.contactId, notMoved.contactId]).toEqual([54982, 54984, 54990]);
  });
});
