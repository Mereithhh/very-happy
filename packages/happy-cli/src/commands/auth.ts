import chalk from 'chalk';
import { readCredentials, clearCredentials, clearMachineId, readSettings } from '@/persistence';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { configuration } from '@/configuration';
import { existsSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { stopDaemon, checkIfDaemonRunningAndCleanupStaleState } from '@/daemon/controlClient';
import { logger } from '@/ui/logger';
import os from 'node:os';
import { credentialRelayProblem } from '@/ui/authRelay';
import { localMachineIdentityStatus } from '@/ui/authStatusFacts';

const DEFAULT_SERVER_URL = 'https://veryhappy.dev';

export async function handleAuthCommand(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    showAuthHelp();
    return;
  }

  switch (subcommand) {
    case 'login':
      await handleAuthLogin(args.slice(1));
      break;
    case 'logout':
      await handleAuthLogout();
      break;
    case 'status':
      await handleAuthStatus();
      break;
    default:
      console.error(chalk.red(`Unknown auth subcommand: ${subcommand}`));
      showAuthHelp();
      process.exit(1);
  }
}

function showAuthHelp(): void {
  console.log(`
${chalk.bold('very-happy auth')} - Authentication management

${chalk.bold('Usage:')}
  very-happy auth login [--force]    Authenticate with Very Happy
  very-happy auth logout             Remove authentication and machine data
  very-happy auth status             Show authentication status
  very-happy auth help               Show this help message

${chalk.bold('Options:')}
  --force    Clear credentials, machine ID, and stop daemon before re-auth

${chalk.gray('Security: the configured Very Happy server is a trusted relay and account service.')}
${chalk.gray('It can recover account material, access relayed content, and act through capabilities')}
${chalk.gray('exposed by an online daemon. Use a server you trust.')}
`);
}

function printDaemonNextStep(): void {
  console.log(chalk.bold('\nNext: start the machine daemon'));
  if (process.env.HAPPY_SERVER_URL || process.env.HAPPY_WEBAPP_URL) {
    console.log(chalk.yellow('  Keep the same HAPPY_SERVER_URL and HAPPY_WEBAPP_URL environment when starting it.'));
  }
  console.log(`  ${chalk.cyan('very-happy daemon start')}`);
  console.log(chalk.gray('  It starts in the background and keeps this machine available in Web.'));
}

async function handleAuthLogin(args: string[]): Promise<void> {
  const forceAuth = args.includes('--force') || args.includes('-f');

  if (forceAuth) {
    // As per user's request: "--force-auth will clear credentials, clear machine ID, stop daemon"
    console.log(chalk.yellow('Force authentication requested.'));
    console.log(chalk.gray('This will:'));
    console.log(chalk.gray('  • Clear existing credentials'));
    console.log(chalk.gray('  • Clear machine ID'));
    console.log(chalk.gray('  • Stop daemon if running'));
    console.log(chalk.gray('  • Re-authenticate and register machine\n'));

    // Stop daemon if running
    try {
      logger.debug('Stopping daemon for force auth...');
      await stopDaemon();
      console.log(chalk.gray('✓ Stopped daemon'));
    } catch (error) {
      logger.debug('Daemon was not running or failed to stop:', error);
    }

    // Clear credentials
    await clearCredentials();
    console.log(chalk.gray('✓ Cleared credentials'));

    // Clear machine ID
    await clearMachineId();
    console.log(chalk.gray('✓ Cleared machine ID'));

    console.log('');
  }

  // Check if already authenticated (if not forcing)
  if (!forceAuth) {
    const existingCreds = await readCredentials();
    const settings = await readSettings();

    if (existingCreds && settings?.machineId) {
      const relayProblem = credentialRelayProblem(existingCreds.authServerUrl, configuration.serverUrl);
      if (relayProblem) {
        console.log(chalk.red(`✗ ${relayProblem}`));
        console.log(chalk.yellow('  Use a separate HAPPY_HOME_DIR for each relay (recommended),'));
        console.log(chalk.yellow("  or run 'very-happy auth login --force' to replace this home's credentials."));
        process.exitCode = 1;
        return;
      }
      console.log(chalk.green('✓ Already authenticated'));
      console.log(chalk.gray(`  Machine ID: ${settings.machineId}`));
      console.log(chalk.gray(`  Host: ${os.hostname()}`));
      console.log(chalk.gray(`  Use 'very-happy auth login --force' to re-authenticate`));
      printDaemonNextStep();
      return;
    } else if (existingCreds && !settings?.machineId) {
      console.log(chalk.yellow('⚠️  Credentials exist but machine ID is missing'));
      console.log(chalk.gray('  This can happen if --auth flag was used previously'));
      console.log(chalk.gray('  Fixing by setting up machine...\n'));
    }
  }

  // Perform authentication and machine setup
  // "Finally we'll run the auth and setup machine if needed"
  try {
    const result = await authAndSetupMachineIfNeeded();
    console.log(chalk.green('\n✓ Authentication successful'));
    console.log(chalk.gray(`  Machine ID: ${result.machineId}`));
    printDaemonNextStep();
  } catch (error) {
    console.error(chalk.red('Authentication failed:'), error instanceof Error ? error.message : 'Unknown error');
    process.exit(1);
  }
}

async function handleAuthLogout(): Promise<void> {
  // Logout clears the local private key created by the Web approval flow.
  const happyDir = configuration.happyHomeDir;

  // Check if authenticated
  const credentials = await readCredentials();
  if (!credentials) {
    console.log(chalk.yellow('Not currently authenticated'));
    return;
  }

  console.log(chalk.blue('This will log you out of Happy'));
  console.log(chalk.yellow('⚠️  You will need to re-authenticate to use Happy again'));

  // Ask for confirmation
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const answer = await new Promise<string>((resolve) => {
    rl.question(chalk.yellow('Are you sure you want to log out? (y/N): '), resolve);
  });

  rl.close();

  if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
    try {
      // Stop daemon if running
      try {
        await stopDaemon();
        console.log(chalk.gray('Stopped daemon'));
      } catch { }

      // Remove entire happy directory (as current logout does)
      if (existsSync(happyDir)) {
        rmSync(happyDir, { recursive: true, force: true });
      }

      console.log(chalk.green('✓ Successfully logged out'));
      console.log(chalk.gray('  Run "very-happy auth login" to authenticate again'));
    } catch (error) {
      throw new Error(`Failed to logout: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  } else {
    console.log(chalk.blue('Logout cancelled'));
  }
}

async function handleAuthStatus(): Promise<void> {
  const credentials = await readCredentials();
  const settings = await readSettings();

  console.log(chalk.bold('\nAuthentication Status\n'));

  if (!credentials) {
    console.log(chalk.red('✗ Not authenticated'));
    console.log(chalk.gray('  Run "very-happy auth login" to authenticate'));
    return;
  }

  const relayProblem = credentialRelayProblem(credentials.authServerUrl, configuration.serverUrl);
  if (relayProblem) {
    console.log(chalk.red(`✗ Credentials found, but not valid for the configured relay: ${relayProblem}`));
    console.log(chalk.gray("  Use another HAPPY_HOME_DIR or run 'very-happy auth login --force'."));
  } else {
    console.log(chalk.green('✓ Authenticated to the configured relay'));
    console.log(chalk.gray(`  Relay: ${credentials.authServerUrl ?? DEFAULT_SERVER_URL}`));
  }

  // A local machineId is not evidence that the relay currently has a matching
  // record. Keep auth status honest without making a network call.
  const machineIdentity = localMachineIdentityStatus(settings?.machineId);
  if (machineIdentity.configured) {
    console.log(chalk.green(`✓ ${machineIdentity.label}`));
    console.log(chalk.gray(`  Machine ID: ${settings.machineId}`));
    console.log(chalk.gray(`  Host: ${os.hostname()}`));
  } else {
    console.log(chalk.yellow(`⚠️  ${machineIdentity.label}`));
    console.log(chalk.gray(`  ${machineIdentity.nextStep}`));
  }

  // Data location
  console.log(chalk.gray(`\n  Data directory: ${configuration.happyHomeDir}`));

  // Daemon status
  try {
    const running = await checkIfDaemonRunningAndCleanupStaleState();
    if (running) {
      console.log(chalk.green('✓ Daemon running'));
    } else {
      console.log(chalk.gray('✗ Daemon not running'));
    }
  } catch {
    console.log(chalk.gray('✗ Daemon not running'));
  }
}
