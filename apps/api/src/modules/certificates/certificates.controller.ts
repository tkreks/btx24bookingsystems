import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import type { CertificateDetailsDto, CertificateListDto, SellCertificateResultDto } from '@btx24/shared';
import { B24AuthGuard, B24User } from '../bitrix24/auth/b24-auth.guard.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { CertificatesService } from './certificates.service.js';

/** Сертификаты портала: список и карточка, выпуск, изменение срока, погашение. */
@Controller('certificates')
@UseGuards(B24AuthGuard)
export class CertificatesController {
  constructor(private readonly certificates: CertificatesService) {}

  @Get()
  list(@B24User() user: B24UserContext, @Query() query: Record<string, unknown>): Promise<CertificateListDto> {
    return this.certificates.list(user, query);
  }

  @Get(':id')
  get(@B24User() user: B24UserContext, @Param('id') id: string): Promise<CertificateDetailsDto> {
    return this.certificates.get(user, id);
  }

  @Post()
  issue(@B24User() user: B24UserContext, @Body() body: unknown): Promise<CertificateDetailsDto> {
    return this.certificates.issue(user, body);
  }

  /** «Покупка сертификата» из мастера брони: сделка + сертификат. */
  @Post('sale')
  sell(@B24User() user: B24UserContext, @Body() body: unknown): Promise<SellCertificateResultDto> {
    return this.certificates.sell(user, body);
  }

  @Put(':id')
  change(@B24User() user: B24UserContext, @Param('id') id: string, @Body() body: unknown): Promise<CertificateDetailsDto> {
    return this.certificates.change(user, id, body);
  }

  @Post(':id/redeem')
  @HttpCode(200)
  redeem(@B24User() user: B24UserContext, @Param('id') id: string, @Body() body: unknown): Promise<CertificateDetailsDto> {
    return this.certificates.redeem(user, id, body);
  }
}
