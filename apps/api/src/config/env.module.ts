import { Global, Module } from '@nestjs/common';

import { loadEnv } from './env.js';

/** DI token for the validated {@link Env}. Inject with `@Inject(ENV)`. */
export const ENV = Symbol('ENV');

/**
 * Global so any module injects `ENV` without re-importing. The env is loaded
 * and validated once here at boot; a malformed `.env` fails the process before
 * a socket is opened.
 */
@Global()
@Module({
  providers: [{ provide: ENV, useFactory: () => loadEnv() }],
  exports: [ENV],
})
export class EnvModule {}
