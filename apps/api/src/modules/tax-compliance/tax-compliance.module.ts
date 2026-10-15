import { Module } from '@nestjs/common';

import { getPrismaClient } from '../../common/db/prisma.js';
import { InMemoryIdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import { selectVatNumberChecker } from '../../common/tax/vat-number-checker.js';
import { ENV } from '../../config/env.module.js';
import type { Env } from '../../config/env.js';
import { CompaniesHouseClient } from './companies-house-client.js';
import { TaxComplianceController } from './tax-compliance.controller.js';
import { TaxComplianceService } from './tax-compliance.service.js';
import { COMPANIES_HOUSE, TAX_COMPLIANCE_SERVICE } from './tokens.js';

/** rush/tax-compliance — VAT checks, Companies House, deadlines, capitalisation threshold. */
@Module({
  controllers: [TaxComplianceController],
  providers: [
    {
      provide: TAX_COMPLIANCE_SERVICE,
      useFactory: (env: Env) => new TaxComplianceService(getPrismaClient(), new InMemoryIdempotencyStore(), selectVatNumberChecker(env)),
      inject: [ENV],
    },
    {
      provide: COMPANIES_HOUSE,
      useFactory: (env: Env) => new CompaniesHouseClient(env.COMPANIES_HOUSE_API_KEY ?? ''),
      inject: [ENV],
    },
  ],
})
export class TaxComplianceModule {}
