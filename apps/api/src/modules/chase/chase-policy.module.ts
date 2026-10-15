import { Controller, Get, HttpCode, HttpStatus, Inject, Module } from '@nestjs/common';

import { REQUEST_CONTEXT } from '../../common/context/context.module.js';
import type { RequestContext } from '../../common/context/request-context.js';
import { getPrismaClient, type PrismaClient } from '../../common/db/prisma.js';
import { readChasePolicy } from './chase-policy.js';

const CHASE_POLICY_PRISMA = Symbol('CHASE_POLICY_PRISMA');

/**
 * `GET /v1/chase-policy` — the practice's chasing schedule (rush/chase-scheduler).
 *
 * READ ONLY, and that is structural: the schedule is written exclusively by an
 * approved `policy.activate` proposal carrying `chasePolicy`
 * (`validation-dedupe/proposals/activate-policy.ts`), so there is no PUT here
 * to hide a side-effect path on. Its own module so the chase module's file
 * stays untouched by this lane.
 */
@Controller()
export class ChasePolicyController {
  constructor(
    @Inject(REQUEST_CONTEXT) private readonly context: RequestContext,
    @Inject(CHASE_POLICY_PRISMA) private readonly prisma: PrismaClient,
  ) {}

  @Get('chase-policy')
  @HttpCode(HttpStatus.OK)
  async getChasePolicy() {
    return readChasePolicy(this.prisma, await this.context.require());
  }
}

@Module({
  controllers: [ChasePolicyController],
  providers: [{ provide: CHASE_POLICY_PRISMA, useFactory: () => getPrismaClient() }],
})
export class ChasePolicyModule {}
