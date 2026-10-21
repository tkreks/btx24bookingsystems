import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { ExecutionContext } from '@nestjs/common';
import { AppAdminGuard } from '../access/app-admin.guard.js';
import type { AccessService } from '../access/access.service.js';
import { B24AuthGuard } from '../bitrix24/auth/b24-auth.guard.js';
import { GroupsAdminController } from './groups.controller.js';

describe('group administration authorization', () => {
  it('requires authentication followed by app admin authorization for every admin route', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, GroupsAdminController)).toEqual([B24AuthGuard, AppAdminGuard]);
  });
  it('rejects an authenticated employee who is not an app admin', async () => {
    const access = { resolve: vi.fn(async () => ({ isAppAdmin: false, groups: [] })) } as unknown as AccessService;
    const context = {
      switchToHttp: () => ({ getRequest: () => ({ b24: { portal: { id: 'p1' }, userId: 42 } }) }),
    } as unknown as ExecutionContext;
    await expect(new AppAdminGuard(access).canActivate(context)).rejects.toMatchObject({ status: 403 });
  });
});
