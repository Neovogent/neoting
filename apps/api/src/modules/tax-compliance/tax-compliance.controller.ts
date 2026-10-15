import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Inject, Param, Post, Put, Query } from '@nestjs/common';

import {
  checkVatNumberQueryParams,
  createObligationBody,
  createObligationHeader,
  getCompanyProfileParams,
  getTaxProfileParams,
  listObligationsQueryParams,
  regenerateObligationsBody,
  regenerateObligationsHeader,
  replaceCapitalisationPolicyBody,
  replaceCapitalisationPolicyHeader,
  replaceTaxProfileBody,
  replaceTaxProfileHeader,
  searchCompaniesQueryParams,
  setObligationCompletionBody,
  setObligationCompletionHeader,
} from '@neoting/contracts/zod';

import { REQUEST_CONTEXT } from '../../common/context/context.module.js';
import type { RequestContext } from '../../common/context/request-context.js';
import { AppException } from '../../common/problem/problem.js';
import { parseBoundary, parseIdempotencyKey } from '../../common/validation/parse-boundary.js';
import { coerceQuery } from '../../common/validation/query-coercion.js';
import { type CompaniesHouseClient, CompaniesHouseNotConfigured } from './companies-house-client.js';
import type { TaxComplianceService } from './tax-compliance.service.js';
import { COMPANIES_HOUSE, TAX_COMPLIANCE_SERVICE } from './tokens.js';

/**
 * rush/tax-compliance — every route here is `none` or `ingest` in the
 * contract: VAT/Companies House reads, the client's tax profile, a deadline
 * checklist, and one practice setting. Nothing reaches a client's books.
 * Thin by the house rule: parse, take the context, call one service method.
 */
@Controller()
export class TaxComplianceController {
  constructor(
    @Inject(REQUEST_CONTEXT) private readonly context: RequestContext,
    @Inject(TAX_COMPLIANCE_SERVICE) private readonly service: TaxComplianceService,
    @Inject(COMPANIES_HOUSE) private readonly companiesHouse: CompaniesHouseClient,
  ) {}

  @Get('vat-number-checks')
  async checkVat(@Query() query: unknown) {
    const parsed = parseBoundary(checkVatNumberQueryParams, query, 'query parameters');
    await this.context.require();
    return this.service.checkVatNumber(parsed.vatNumber);
  }

  @Get('companies-house/companies')
  async searchCompanies(@Query() query: unknown) {
    const parsed = parseBoundary(searchCompaniesQueryParams, query, 'query parameters');
    await this.context.require();
    return { items: await this.companies(() => this.companiesHouse.search(parsed.q)) };
  }

  @Get('companies-house/companies/:companyNumber')
  async companyProfile(@Param('companyNumber') companyNumber: string) {
    const params = parseBoundary(getCompanyProfileParams, { companyNumber }, 'companyNumber');
    await this.context.require();
    const profile = await this.companies(() => this.companiesHouse.profile(params.companyNumber));
    if (profile === null) {
      throw new AppException('NT-VAL-001', HttpStatus.NOT_FOUND, 'Not found', 'Companies House has no company with that number.');
    }
    return profile;
  }

  @Get('businesses/:businessId/tax-profile')
  async getTaxProfile(@Param('businessId') businessId: string) {
    const params = parseBoundary(getTaxProfileParams, { businessId }, 'businessId');
    return this.service.getTaxProfile(await this.context.require(), params.businessId);
  }

  @Put('businesses/:businessId/tax-profile')
  async replaceTaxProfile(
    @Param('businessId') businessId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    const params = parseBoundary(getTaxProfileParams, { businessId }, 'businessId');
    const parsed = parseBoundary(replaceTaxProfileBody, body, 'body');
    const key = parseIdempotencyKey(replaceTaxProfileHeader, idempotencyKey);
    return this.service.replaceTaxProfile(await this.context.require(), params.businessId, parsed, key);
  }

  @Get('obligations')
  async listObligations(@Query() query: unknown) {
    const parsed = parseBoundary(listObligationsQueryParams, coerceQuery(listObligationsQueryParams, query), 'query parameters');
    return this.service.listObligations(await this.context.require(), parsed);
  }

  @Post('obligations')
  @HttpCode(HttpStatus.CREATED)
  async createObligation(@Body() body: unknown, @Headers('idempotency-key') idempotencyKey: string | undefined) {
    const parsed = parseBoundary(createObligationBody, body, 'body');
    const key = parseIdempotencyKey(createObligationHeader, idempotencyKey);
    return this.service.createObligation(await this.context.require(), parsed, key);
  }

  @Post('obligations/regeneration')
  @HttpCode(HttpStatus.OK)
  async regenerate(@Body() body: unknown, @Headers('idempotency-key') idempotencyKey: string | undefined) {
    const parsed = parseBoundary(regenerateObligationsBody, body ?? {}, 'body');
    parseIdempotencyKey(regenerateObligationsHeader, idempotencyKey);
    return this.service.regenerate(await this.context.require(), parsed.businessId);
  }

  @Post('obligations/:obligationId/completion')
  @HttpCode(HttpStatus.OK)
  async setCompletion(
    @Param('obligationId') obligationId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    const parsed = parseBoundary(setObligationCompletionBody, body, 'body');
    parseIdempotencyKey(setObligationCompletionHeader, idempotencyKey);
    return this.service.setCompletion(await this.context.require(), obligationId, parsed.done);
  }

  @Get('practice-settings/capitalisation')
  async getCapitalisation() {
    return this.service.getCapitalisationPolicy(await this.context.require());
  }

  @Put('practice-settings/capitalisation')
  async replaceCapitalisation(@Body() body: unknown, @Headers('idempotency-key') idempotencyKey: string | undefined) {
    const parsed = parseBoundary(replaceCapitalisationPolicyBody, body, 'body');
    parseIdempotencyKey(replaceCapitalisationPolicyHeader, idempotencyKey);
    return this.service.replaceCapitalisationPolicy(await this.context.require(), parsed.thresholdPence);
  }

  /** An unconfigured or unreachable register is a sentence, not a 500 with a stack. */
  private async companies<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof CompaniesHouseNotConfigured) {
        throw new AppException('NT-SRV-001', HttpStatus.SERVICE_UNAVAILABLE, 'Companies House lookup is not set up', 'Companies House lookup is not configured on this deployment (COMPANIES_HOUSE_API_KEY). Type the details in by hand.');
      }
      throw new AppException('NT-SRV-001', HttpStatus.BAD_GATEWAY, 'Companies House could not be reached', 'Companies House did not answer just now. Try again in a moment, or type the details in by hand.');
    }
  }
}
