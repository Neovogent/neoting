import { Controller, Get } from '@nestjs/common';

/**
 * Liveness and readiness (runbook §6.4).
 *
 * The staging ALB target group probes `/healthz` (infra/envs/staging/alb.tf),
 * so it must return 200 as soon as the process can serve, with NO dependency
 * calls. `/readyz` is for the deploy gate and synthetic checks — never the
 * target-group probe — so it must not gate on a dependency whose blip would
 * deregister the whole service.
 */
@Controller()
export class HealthController {
  @Get('healthz')
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('readyz')
  readiness(): { status: 'ready'; checks: Record<string, string> } {
    // TODO(readiness): once Postgres and Redis are wired, check reachability
    // here and return 503 when a dependency is down. Reporting `ready` for now
    // is deliberate — faking dependency checks would be worse than declaring
    // there are none yet.
    return { status: 'ready', checks: {} };
  }
}
