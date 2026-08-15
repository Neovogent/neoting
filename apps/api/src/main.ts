import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from './app.module.js';
import { loadEnv } from './config/env.js';
import { API_PREFIX, UNVERSIONED_ROUTES } from './config/routing.js';

/**
 * Bootstrap on port 3000 — pinned by infra/envs/staging (the ALB target group
 * and app security group open exactly 3000). `rawBody: true` keeps the built-in
 * JSON body parser AND stashes the untouched bytes on `req.rawBody`, which the
 * WhatsApp signature guard needs to verify Meta's HMAC. Do NOT set
 * `bodyParser: false` — that drops `req.rawBody`.
 */
async function bootstrap(): Promise<void> {
  const env = loadEnv(); // validate the environment before opening a socket
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  app.setGlobalPrefix(API_PREFIX, { exclude: UNVERSIONED_ROUTES });
  await app.listen(env.PORT);
  new Logger('Bootstrap').log(`Neoting API listening on :${env.PORT}/${API_PREFIX}`);
}

void bootstrap();
