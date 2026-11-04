import { TokenType } from '@openathlete/database';

import { TrainingLoadService } from 'src/modules/core/services/training-load.service';

import { backfillMissingTrimp } from './backfill-trimp';

import { passwordResetUrl } from 'src/modules/auth/helpers/password-reset-url';
import { AccountDeletionService } from 'src/modules/auth/services/account-deletion.service';
import { TokenService } from 'src/modules/auth/services/token.service';
import { PrismaService } from 'src/modules/prisma/services/prisma.service';

export const USAGE = `Usage: openathlete <command>

  list-users                  List the accounts of this instance
  reset-password <email>      Print a link to set a new password (valid 15 minutes)
  delete-user <email> --yes   Delete an account and all its data, for good\n  backfill-trimp <email> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--yes]\n                              Dry-run or add missing historical TRIMP entries`;

export interface CliDeps {
  prisma: PrismaService;
  tokens: TokenService;
  accountDeletion: AccountDeletionService;
  trainingLoad: TrainingLoadService;
  appUrl: string;
}

/**
 * Administration commands for self-hosted instances, run inside the API
 * container: `docker compose exec api openathlete <command>`.
 *
 * @returns the exit code
 */
export async function runCommand(
  args: string[],
  deps: CliDeps,
  out: (line: string) => void,
): Promise<number> {
  const [command, ...rest] = args;
  const email = rest.find((arg) => !arg.startsWith('--'))?.toLowerCase();

  const findUser = async () => {
    if (!email) {
      out(USAGE);
      return null;
    }
    const user = await deps.prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: { userId: true, email: true },
    });
    if (!user) out(`No account with the email ${email}`);
    return user;
  };

  switch (command) {
    case 'list-users': {
      const users = await deps.prisma.user.findMany({
        select: {
          userId: true,
          email: true,
          firstName: true,
          lastName: true,
          roles: true,
          createdAt: true,
        },
        orderBy: { userId: 'asc' },
      });
      for (const user of users) {
        out(
          [
            user.userId,
            user.email,
            `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim(),
            user.roles.join(','),
            user.createdAt.toISOString().slice(0, 10),
          ].join('\t'),
        );
      }
      out(`${users.length} account${users.length === 1 ? '' : 's'}`);
      return 0;
    }

    case 'reset-password': {
      const user = await findUser();
      if (!user) return 1;
      const token = await deps.tokens.createToken(
        { userId: user.userId },
        TokenType.PASSWORD_RESET,
      );
      out(`Send this link to ${user.email}, it is valid 15 minutes:`);
      out(passwordResetUrl(deps.appUrl, token.token));
      return 0;
    }

    case 'backfill-trimp':
      return backfillMissingTrimp(rest, deps, out);

    case 'delete-user': {
      const user = await findUser();
      if (!user) return 1;
      if (!rest.includes('--yes')) {
        out(
          `This deletes ${user.email} and all their data for good. Add --yes to confirm.`,
        );
        return 1;
      }
      await deps.accountDeletion.deleteAccount(user.userId);
      out(`Deleted ${user.email}`);
      return 0;
    }

    default:
      out(USAGE);
      return command && command !== 'help' && command !== '--help' ? 1 : 0;
  }
}
