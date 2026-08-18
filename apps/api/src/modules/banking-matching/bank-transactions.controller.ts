import { Controller, Get, HttpCode, HttpStatus, Inject, Query } from '@nestjs/common';

import { listBankTransactionsQueryParams } from '@neoting/contracts/zod';

import { REQUEST_CONTEXT } from '../../common/context/context.module.js';
import type { RequestContext } from '../../common/context/request-context.js';
import { parseBoundary } from '../../common/validation/parse-boundary.js';
import { coerceQuery } from '../../common/validation/query-coercion.js';
import type { BankTransactionsService } from './bank-transactions.service.js';
import { BANK_TRANSACTIONS_SERVICE } from './tokens.js';

/**
 * `GET /v1/bank-transactions` — the normalised feed (METH Stage 11).
 *
 * One GET, no `Idempotency-Key`: the operation is `x-nt-side-effect: none`, and
 * `check-contract.mjs` requires the header only where it is not. Thin by design
 * (`apps/api/CLAUDE.md`, 200-line cap): parse with the generated schema, take
 * the request context, call ONE service method, return it.
 *
 * There is no POST, PATCH or DELETE here and none may be added. Confirming a
 * match is a `bank.confirm-match` proposal through `/v1/action-proposals` —
 * the single Approve operation is the only side-effect door in the API
 * (Governance §10).
 */
@Controller('bank-transactions')
export class BankTransactionsController {
  constructor(
    @Inject(REQUEST_CONTEXT) private readonly context: RequestContext,
    @Inject(BANK_TRANSACTIONS_SERVICE) private readonly service: BankTransactionsService,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async list(@Query() query: unknown) {
    // `coerceQuery` first: Express delivers every query value as a string, and
    // a once-given repeatable filter as a bare value, while the generated
    // schema types `limit` as a number and `matchState` as an array. Without
    // it `?limit=100&matchState=UNMATCHED` — exactly what the Bank screen
    // sends — is a 400. Schema-driven, so it cannot drift from the contract.
    const parsed = parseBoundary(
      listBankTransactionsQueryParams,
      coerceQuery(listBankTransactionsQueryParams, query),
      'query parameters',
    );
    // `require()` resolves the context inside Nest's pipeline, so a bad one
    // leaves as a 401 problem+json rather than an Express-level crash (#75).
    return this.service.listBankTransactions(await this.context.require(), parsed);
  }
}
