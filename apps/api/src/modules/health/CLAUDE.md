# health

**Source of Truth:** runbook §6.4 (liveness/readiness) · **Added by:** issue #9

## Purpose

The two probes the platform is checked by:

- **`GET /healthz`** — liveness. "Is this process able to serve?" Returns 200
  with no dependency calls. The staging ALB target group probes exactly this
  (`infra/envs/staging/alb.tf`), so it must stay dependency-free — a dependency
  blip must never deregister the whole service.
- **`GET /readyz`** — readiness. "Can it reach its dependencies?" Intended for
  the deploy gate and synthetic checks, **never** the target-group probe.

## Invariants

- `/healthz` never calls a dependency and never returns non-200 while the
  process is up.
- `/readyz` must not gate on a dependency in a way that would take the whole
  service out of rotation.

## Current state

Both endpoints return 200. `/readyz` reports `{ status: 'ready', checks: {} }`
with **no real dependency checks yet** — deliberately honest rather than faked
(there is no Postgres/Redis wiring in issue #9 scope).

## TODO

- [ ] Wire real `/readyz` checks (Postgres + Redis reachability) once those land,
      returning 503 when a dependency is down. Tracked with the data-layer work.

## Tests

```bash
pnpm --filter @neoting/api test
```
