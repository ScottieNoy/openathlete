import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { ApiEnvSchemaType } from '@openathlete/shared';

import { CliDeps, runCommand } from './cli/commands';
import { validateEnv } from './common/config/validate-env';
import { CaslAbilityFactory } from './modules/auth/services/casl-ability.factory';
import { AccountDeletionService } from './modules/auth/services/account-deletion.service';
import { TokenService } from './modules/auth/services/token.service';
import { TrainingLoadService } from './modules/core/services/training-load.service';
import { PrismaService } from './modules/prisma/services/prisma.service';
import { StripeService } from './modules/subscription/services/stripe.service';

/** Only what the commands need: no HTTP server, queues or listeners. */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      validationOptions: { allowUnknown: false, abortEarly: false },
    }),
  ],
  providers: [
    PrismaService,
    TokenService,
    StripeService,
    AccountDeletionService,
    CaslAbilityFactory,
    TrainingLoadService,
  ],
})
class CliModule {}

async function main() {
  const app = await NestFactory.createApplicationContext(CliModule, {
    // Startup notices ("billing is disabled"...) would mix with the output
    logger: ['error'],
  });
  const deps: CliDeps = {
    prisma: app.get(PrismaService),
    tokens: app.get(TokenService),
    accountDeletion: app.get(AccountDeletionService),
    trainingLoad: app.get(TrainingLoadService),
    appUrl: app
      .get<ConfigService<ApiEnvSchemaType, true>>(ConfigService)
      .get('APP_URL'),
  };
  try {
    process.exitCode = await runCommand(process.argv.slice(2), deps, (line) =>
      process.stdout.write(`${line}\n`),
    );
  } finally {
    await app.close();
  }
}

void main();
