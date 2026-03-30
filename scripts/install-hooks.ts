#!/usr/bin/env npx tsx

/**
 * Watchtower Session Intelligence — Hook Installer
 *
 * Installs Claude Code hooks that automatically log coding sessions
 * to Watchtower for AI analysis, semantic search, and agent recall.
 *
 * What it does:
 *   1. Copies session-ingest.sh and session-track.sh to ~/.claude/hooks/
 *   2. Patches ~/.claude/settings.json to register both hooks
 *   3. Adds WATCHTOWER_SESSION_WEBHOOK_URL to your shell profile
 *
 * Usage:
 *   npx tsx scripts/watchtower/install-hooks.ts
 *   npx tsx scripts/watchtower/install-hooks.ts --url https://custom-watchtower.example.com
 *   npx tsx scripts/watchtower/install-hooks.ts --dry-run
 */

import { readFile, writeFile, copyFile, mkdir, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

// =============================================================================
// CONFIG
// =============================================================================

const DEFAULT_WEBHOOK_URL = 'http://localhost:5003/webhooks/session';
const DEFAULT_START_URL = 'http://localhost:5003/webhooks/session-start';

const HOOKS_SOURCE_DIR = join(dirname(new URL(import.meta.url).pathname), '..', 'hooks');
const CLAUDE_DIR = join(homedir(), '.claude');
const CLAUDE_HOOKS_DIR = join(CLAUDE_DIR, 'hooks');
const SETTINGS_PATH = join(CLAUDE_DIR, 'settings.json');

const HOOK_FILES = [
  { src: 'session-ingest.sh', desc: 'Stop hook — auto-ingests session on end' },
  { src: 'session-track.sh', desc: 'SessionStart hook — tracks active sessions' },
];

const DRY_RUN = process.argv.includes('--dry-run');
const CUSTOM_URL = (() => {
  const idx = process.argv.indexOf('--url');
  if (idx !== -1 && process.argv[idx + 1] !== undefined) {
    return process.argv[idx + 1];
  }
  return null;
})();

const webhookUrl = CUSTOM_URL !== null ? CUSTOM_URL : DEFAULT_WEBHOOK_URL;
const startUrl = CUSTOM_URL !== null ? `${CUSTOM_URL.replace(/\/webhooks\/session$/, '')}/webhooks/session-start` : DEFAULT_START_URL;

// =============================================================================
// HELPERS
// =============================================================================

function log(msg: string): void {
  console.log(`  ${msg}`);
}

function logStep(msg: string): void {
  console.log(`\n> ${msg}`);
}

interface SettingsJson {
  hooks?: Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>>;
  [key: string]: unknown;
}

// =============================================================================
// STEP 1: COPY HOOKS
// =============================================================================

async function copyHooks(): Promise<void> {
  logStep('Copying hooks to ~/.claude/hooks/');

  if (!existsSync(CLAUDE_DIR)) {
    if (DRY_RUN) {
      log('[dry-run] Would create ~/.claude/');
    } else {
      await mkdir(CLAUDE_DIR, { recursive: true });
      log('Created ~/.claude/');
    }
  }

  if (!existsSync(CLAUDE_HOOKS_DIR)) {
    if (DRY_RUN) {
      log('[dry-run] Would create ~/.claude/hooks/');
    } else {
      await mkdir(CLAUDE_HOOKS_DIR, { recursive: true });
      log('Created ~/.claude/hooks/');
    }
  }

  for (const hook of HOOK_FILES) {
    const srcPath = join(HOOKS_SOURCE_DIR, hook.src);
    const destPath = join(CLAUDE_HOOKS_DIR, hook.src);

    if (!existsSync(srcPath)) {
      console.error(`  ERROR: Source hook not found: ${srcPath}`);
      process.exit(1);
    }

    if (existsSync(destPath)) {
      log(`Overwriting ${hook.src} (${hook.desc})`);
    } else {
      log(`Installing ${hook.src} (${hook.desc})`);
    }

    if (!DRY_RUN) {
      await copyFile(srcPath, destPath);
      await chmod(destPath, 0o755);
    }
  }
}

// =============================================================================
// STEP 2: PATCH SETTINGS.JSON
// =============================================================================

async function patchSettings(): Promise<void> {
  logStep('Patching ~/.claude/settings.json');

  let settings: SettingsJson = {};

  if (existsSync(SETTINGS_PATH)) {
    const raw = await readFile(SETTINGS_PATH, 'utf-8');
    settings = JSON.parse(raw) as SettingsJson;
    log('Read existing settings.json');
  } else {
    log('No existing settings.json — creating new one');
  }

  if (settings.hooks === undefined) {
    settings.hooks = {};
  }

  // Helper: check if a hook command already exists in a hook event
  function hasHookCommand(eventHooks: Array<{ hooks: Array<{ type: string; command: string }> }>, command: string): boolean {
    for (const entry of eventHooks) {
      for (const hook of entry.hooks) {
        if (hook.command === command) {
          return true;
        }
      }
    }
    return false;
  }

  // Helper: add a hook command to an event
  function addHookCommand(event: string, command: string): void {
    if (settings.hooks === undefined) {
      settings.hooks = {};
    }

    if (settings.hooks[event] === undefined) {
      settings.hooks[event] = [{ hooks: [] }];
    }

    const eventHooks = settings.hooks[event];
    if (hasHookCommand(eventHooks, command)) {
      log(`Already registered: ${command}`);
      return;
    }

    // Add to the first entry's hooks array
    if (eventHooks.length === 0) {
      eventHooks.push({ hooks: [] });
    }
    eventHooks[0].hooks.push({ type: 'command', command });
    log(`Registered: ${command}`);
  }

  // Register Stop hook (session-ingest.sh)
  addHookCommand('Stop', 'bash $HOME/.claude/hooks/session-ingest.sh');

  // Register SessionStart hook (session-track.sh)
  addHookCommand('SessionStart', 'bash $HOME/.claude/hooks/session-track.sh');

  if (DRY_RUN) {
    log('[dry-run] Would write settings.json:');
    console.log(JSON.stringify(settings, null, 2));
  } else {
    await writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
    log('Written settings.json');
  }
}

// =============================================================================
// STEP 3: SET ENV VARS
// =============================================================================

async function setEnvVars(): Promise<void> {
  logStep('Setting environment variables');

  // Detect shell profile
  const shell = process.env.SHELL;
  let profilePath: string;

  if (shell !== undefined && shell.includes('zsh')) {
    profilePath = join(homedir(), '.zshrc');
  } else if (shell !== undefined && shell.includes('bash')) {
    profilePath = join(homedir(), '.bashrc');
  } else {
    profilePath = join(homedir(), '.profile');
  }

  log(`Shell profile: ${profilePath}`);

  let profileContent = '';
  if (existsSync(profilePath)) {
    profileContent = await readFile(profilePath, 'utf-8');
  }

  const envLines: string[] = [];

  // Check and add WATCHTOWER_SESSION_WEBHOOK_URL
  if (profileContent.includes('WATCHTOWER_SESSION_WEBHOOK_URL')) {
    log('WATCHTOWER_SESSION_WEBHOOK_URL already set');
  } else {
    envLines.push(`export WATCHTOWER_SESSION_WEBHOOK_URL="${webhookUrl}"`);
    log(`Adding WATCHTOWER_SESSION_WEBHOOK_URL=${webhookUrl}`);
  }

  // Check and add WATCHTOWER_SESSION_START_URL
  if (profileContent.includes('WATCHTOWER_SESSION_START_URL')) {
    log('WATCHTOWER_SESSION_START_URL already set');
  } else {
    envLines.push(`export WATCHTOWER_SESSION_START_URL="${startUrl}"`);
    log(`Adding WATCHTOWER_SESSION_START_URL=${startUrl}`);
  }

  if (envLines.length === 0) {
    log('All env vars already configured');
    return;
  }

  const block = [
    '',
    '# Watchtower Session Intelligence — auto-ingest Claude Code sessions',
    ...envLines,
  ].join('\n');

  if (DRY_RUN) {
    log(`[dry-run] Would append to ${profilePath}:`);
    console.log(block);
  } else {
    await writeFile(profilePath, profileContent + block + '\n');
    log(`Appended to ${profilePath}`);
  }
}

// =============================================================================
// MAIN
// =============================================================================

async function main(): Promise<void> {
  console.log('Watchtower Session Intelligence — Installer');
  console.log('============================================');
  if (DRY_RUN) {
    console.log('[DRY RUN — no changes will be made]');
  }

  await copyHooks();
  await patchSettings();
  await setEnvVars();

  console.log('\n============================================');
  console.log('Installation complete!');
  console.log('');
  console.log('What happens now:');
  console.log('  - Every Claude Code session start is tracked');
  console.log('  - Every Claude Code session end is auto-ingested');
  console.log('  - Sessions are AI-analyzed (title, summary, decisions)');
  console.log('  - Ora agents can search your coding history');
  console.log('');
  console.log('To activate, either:');
  console.log('  1. Open a new terminal, or');
  console.log('  2. Run: source ~/.zshrc');
  console.log('');
  console.log('To uninstall:');
  console.log('  npx tsx scripts/watchtower/uninstall-hooks.ts');
}

main().catch((err) => {
  console.error('Installation failed:', err);
  process.exit(1);
});
