#!/usr/bin/env npx tsx

/**
 * Watchtower Session Intelligence — Hook Uninstaller
 *
 * Removes Claude Code hooks and env vars installed by install-hooks.ts.
 *
 * What it does:
 *   1. Removes session-ingest.sh and session-track.sh from ~/.claude/hooks/
 *   2. Removes hook registrations from ~/.claude/settings.json
 *   3. Removes WATCHTOWER env vars from shell profile
 *
 * Usage:
 *   npx tsx scripts/watchtower/uninstall-hooks.ts
 *   npx tsx scripts/watchtower/uninstall-hooks.ts --dry-run
 */

import { readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// =============================================================================
// CONFIG
// =============================================================================

const CLAUDE_DIR = join(homedir(), '.claude');
const CLAUDE_HOOKS_DIR = join(CLAUDE_DIR, 'hooks');
const SETTINGS_PATH = join(CLAUDE_DIR, 'settings.json');

const HOOK_FILES = ['session-ingest.sh', 'session-track.sh'];
const HOOK_COMMANDS = [
  'bash $HOME/.claude/hooks/session-ingest.sh',
  'bash $HOME/.claude/hooks/session-track.sh',
];

const DRY_RUN = process.argv.includes('--dry-run');

// =============================================================================
// HELPERS
// =============================================================================

function log(msg: string): void {
  console.log(`  ${msg}`);
}

function logStep(msg: string): void {
  console.log(`\n> ${msg}`);
}

interface HookEntry {
  type: string;
  command: string;
}

interface HookGroup {
  hooks: HookEntry[];
}

interface SettingsJson {
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

// =============================================================================
// STEP 1: REMOVE HOOK FILES
// =============================================================================

async function removeHooks(): Promise<void> {
  logStep('Removing hooks from ~/.claude/hooks/');

  for (const hookFile of HOOK_FILES) {
    const hookPath = join(CLAUDE_HOOKS_DIR, hookFile);
    if (existsSync(hookPath)) {
      if (DRY_RUN) {
        log(`[dry-run] Would remove ${hookFile}`);
      } else {
        await unlink(hookPath);
        log(`Removed ${hookFile}`);
      }
    } else {
      log(`Not found: ${hookFile} (already removed)`);
    }
  }
}

// =============================================================================
// STEP 2: UNPATCH SETTINGS.JSON
// =============================================================================

async function unpatchSettings(): Promise<void> {
  logStep('Removing hook registrations from settings.json');

  if (!existsSync(SETTINGS_PATH)) {
    log('No settings.json found — nothing to unpatch');
    return;
  }

  const raw = await readFile(SETTINGS_PATH, 'utf-8');
  const settings = JSON.parse(raw) as SettingsJson;

  if (settings.hooks === undefined) {
    log('No hooks section in settings.json');
    return;
  }

  let modified = false;

  for (const eventName of Object.keys(settings.hooks)) {
    const eventHooks = settings.hooks[eventName];
    for (const group of eventHooks) {
      const before = group.hooks.length;
      group.hooks = group.hooks.filter((h) => !HOOK_COMMANDS.includes(h.command));
      if (group.hooks.length < before) {
        modified = true;
        log(`Removed watchtower hooks from ${eventName}`);
      }
    }

    // Clean up empty groups
    settings.hooks[eventName] = eventHooks.filter((g) => g.hooks.length > 0);

    // Clean up empty event entries
    if (settings.hooks[eventName].length === 0) {
      delete settings.hooks[eventName];
    }
  }

  if (!modified) {
    log('No watchtower hooks found in settings.json');
    return;
  }

  if (DRY_RUN) {
    log('[dry-run] Would write settings.json');
  } else {
    await writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
    log('Updated settings.json');
  }
}

// =============================================================================
// STEP 3: REMOVE ENV VARS
// =============================================================================

async function removeEnvVars(): Promise<void> {
  logStep('Removing environment variables from shell profile');

  const shell = process.env.SHELL;
  let profilePath: string;

  if (shell !== undefined && shell.includes('zsh')) {
    profilePath = join(homedir(), '.zshrc');
  } else if (shell !== undefined && shell.includes('bash')) {
    profilePath = join(homedir(), '.bashrc');
  } else {
    profilePath = join(homedir(), '.profile');
  }

  if (!existsSync(profilePath)) {
    log(`${profilePath} not found — nothing to clean`);
    return;
  }

  const content = await readFile(profilePath, 'utf-8');
  const lines = content.split('\n');
  const filtered: string[] = [];
  let removed = 0;
  let skipComment = false;

  for (const line of lines) {
    // Remove the comment header
    if (line === '# Watchtower Session Intelligence — auto-ingest Claude Code sessions') {
      skipComment = true;
      removed++;
      continue;
    }

    // Remove watchtower env vars
    if (line.startsWith('export WATCHTOWER_SESSION_WEBHOOK_URL=') ||
        line.startsWith('export WATCHTOWER_SESSION_START_URL=')) {
      removed++;
      continue;
    }

    skipComment = false;
    filtered.push(line);
  }

  if (removed === 0) {
    log('No watchtower env vars found');
    return;
  }

  // Clean up trailing blank lines
  while (filtered.length > 0 && filtered[filtered.length - 1] === '') {
    filtered.pop();
  }
  filtered.push('');

  if (DRY_RUN) {
    log(`[dry-run] Would remove ${removed} lines from ${profilePath}`);
  } else {
    await writeFile(profilePath, filtered.join('\n'));
    log(`Removed ${removed} lines from ${profilePath}`);
  }
}

// =============================================================================
// MAIN
// =============================================================================

async function main(): Promise<void> {
  console.log('Watchtower Session Intelligence — Uninstaller');
  console.log('==============================================');
  if (DRY_RUN) {
    console.log('[DRY RUN — no changes will be made]');
  }

  await removeHooks();
  await unpatchSettings();
  await removeEnvVars();

  console.log('\n==============================================');
  console.log('Uninstall complete.');
  console.log('');
  console.log('Restart your terminal or run: source ~/.zshrc');
}

main().catch((err) => {
  console.error('Uninstall failed:', err);
  process.exit(1);
});
