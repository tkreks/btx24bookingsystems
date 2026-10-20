import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { GroupsAdminController, MyGroupsController } from './groups.controller.js';
import { GroupsService } from './groups.service.js';

@Module({
  imports: [AccessModule],
  controllers: [MyGroupsController, GroupsAdminController],
  providers: [GroupsService],
})
export class GroupsModule {}
