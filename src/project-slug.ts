/**
 * Resolve a session's project from its working directory.
 *
 * Adapters used to send `path.basename(cwd)`. That is wrong in the two cases
 * that dominate this machine, and it fails silently — the webhook simply finds
 * no matching project and writes `project_id = NULL`, so the session is
 * captured but unattributable.
 *
 * Measured 2026-08-12, 24h window: 174 of 276 sessions had no project.
 *   - 74 (43%) were git WORKTREES. `~/Development/.worktrees/sentigen-onboarding-demo`
 *     has basename `sentigen-onboarding-demo`, which is not a project and never
 *     will be. There are ~513 worktrees on this machine, so this is structural,
 *     not incidental.
 *   - ~38 more were real repos whose directory name is not their project slug.
 *   - The rest started outside a repo (`/Users/g`, `~/.claude/plans/…`), which no
 *     cwd heuristic can fix.
 *
 * So resolve git IDENTITY instead of a path segment, in descending order of
 * trustworthiness:
 *
 *   1. `origin` remote  -> `owner/repo`. Stable across worktrees, clones and
 *      renames, and the webhook ALREADY matches on `projects.github_repo`, so
 *      this hits an existing lookup path rather than needing a new one.
 *   2. `--git-common-dir` -> the MAIN repo's `.git`, even when called from a
 *      linked worktree; the canonical checkout is its parent. This is the whole
 *      reason worktrees resolve correctly. A BARE repo is the exception: there
 *      the common dir IS the repository, so the parent would be the containing
 *      folder and every worktree under it would collapse to one wrong slug.
 *   3. `path.basename(cwd)` -> the old behaviour, kept so a non-git directory
 *      degrades to what it did before rather than to nothing. Rejected when it
 *      is degenerate (`path.basename('/')` is '').
 *
 * Never throws: capture must not fail because a directory is not a repo.
 *
 * The same ladder is what `watchtower resolve-project` prints and what every
 * Claude Code session hook calls through `hooks/lib/project-slug.sh`. That
 * matters more than it reads: the hooks previously carried five separate shell
 * copies with neither rung 2 nor the environment scrub, and claude_code is the
 * source of every session captured in the last seven days.
 */

import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';

/**
 * Git answers, keyed by directory.
 *
 * Resolutions are stable per directory and one ingest run touches the same cwd
 * repeatedly, so this is the memo that matters: every entry is up to two git
 * subprocesses not spawned. Caching the FULL ladder on top of this would add
 * only a memoized `path.basename` call, which costs nothing to recompute — and
 * a second cache in front of this one is untestable, because the inner one
 * already answers before the outer one is consulted.
 */
const gitSlugCache = new Map<string, string | undefined>();

/**
 * Git env vars that OVERRIDE `-C` and silently point git at another repo.
 *
 * Capture runs from Claude Code hooks, and a hook is spawned by git with
 * `GIT_DIR` and friends already exported. `git -C /some/dir rev-parse` then
 * answers for the HOOK's repository, not the directory asked about — so a
 * session would be attributed to whatever repo happened to invoke the hook.
 *
 * Found the hard way: the test suite for this file, run under the pre-push
 * hook, had its `git init/add/commit` redirected into the real checkout and
 * wrote a stray commit onto the branch.
 */
const GIT_ENV_OVERRIDES = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_PREFIX',
  // Does not redirect git at another repo — it stops discovery finding one at
  // all. With a ceiling covering the checkout, `git -C <repo>/a rev-parse`
  // exits 128 "not a git repository" with the repo sitting right there, so
  // both rungs return null and every session under it degrades to a basename.
  // Git-aware shell prompts set this to keep themselves off slow mounts, and
  // hooks inherit the login shell's environment.
  'GIT_CEILING_DIRECTORIES',
] as const;

/** A copy of the environment with the repo-pointing variables removed. */
export function envWithoutGitOverrides(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...source };
  for (const key of GIT_ENV_OVERRIDES) {
    delete clean[key];
  }
  return clean;
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): string | null {
  try {
    const out = execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
      // Without this, `-C` is advisory: an inherited GIT_DIR wins.
      env: envWithoutGitOverrides(env),
    });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    // Not a repo, git missing, or slow disk. All mean "fall through".
    return null;
  }
}

/** `git@github.com:owner/repo.git` / `https://github.com/owner/repo` -> `repo`. */
export function repoNameFromRemote(remoteUrl: string): string | null {
  const cleaned = remoteUrl.trim().replace(/\.git$/, '');
  const match = /[/:]([^/:]+)\/([^/]+)$/.exec(cleaned);
  if (match === null) {
    return null;
  }
  const repo = match[2];
  return repo !== undefined && repo.length > 0 ? repo : null;
}

/**
 * Best-effort project slug for a working directory.
 *
 * Returns undefined only when `cwd` is empty, so callers keep the same
 * `string | undefined` contract the adapters already use.
 */
export function resolveProjectSlug(
  cwd: string | null | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (cwd === null || cwd === undefined || cwd.trim() === '') {
    return undefined;
  }
  const key = cwd.trim();

  // Tiers 1a and 1b (origin remote, then --git-common-dir) live in
  // gitDerivedSlug, shared with the content resolver so the two paths can never
  // disagree about what a directory belongs to. It memoizes per directory.
  let slug = gitDerivedSlug(key, env);

  if (slug === undefined) {
    // Same degenerate-result guard rung 2 applies. `path.basename('/')` is ''
    // in Node, and an empty slug is worse than none: ingest assigns it because
    // it is not undefined, and the webhook then substring-matches '' against
    // every row in the projects table.
    const base = path.basename(key);
    slug = base === '' ? undefined : base;
  }

  return slug;
}

/** Test seam; resolutions are cached for the life of the process. */
export function clearProjectSlugCache(): void {
  gitSlugCache.clear();
}

/**
 * The deepest ancestor of `p` that exists and is a directory.
 *
 * A mentioned path is frequently not a directory and frequently does not exist
 * at all: transcripts name files that were deleted, files about to be created,
 * and paths several levels below anything on disk. `git -C` fails outright on
 * every one of those, so asking git about the raw string finds nothing.
 *
 * Walking up with a stat call each step is the cheap half of the resolution —
 * a miss costs a stat, not a subprocess — and it converges to a real directory
 * that git CAN answer for.
 */
function deepestExistingDir(p: string): string | null {
  let current = p;
  // Depth is bounded by the path itself; the guard is against a pathological
  // string that dirname cannot shorten, which would otherwise spin forever.
  for (let i = 0; i < 64 && current.length > 1; i += 1) {
    const stat = statSync(current, { throwIfNoEntry: false });
    if (stat !== undefined) {
      return stat.isDirectory() ? current : path.dirname(current);
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
  return null;
}

/**
 * Absolute POSIX paths mentioned in text. Trailing punctuation is stripped so a
 * path at the end of a sentence, in quotes, or in a shell command still parses.
 */
const ABSOLUTE_PATH = /\/(?:Users|home|opt|srv|var|private)\/[^\s'"`,;:)\]}]+/g;

/**
 * Resolve a project from paths a session MENTIONED, for sessions whose own cwd
 * is not a repository.
 *
 * A session started in `/Users/g` or `~/.claude/plans` and then spending six
 * hours inside a repo is the single largest remaining attribution gap; the cwd
 * ladder cannot see it, but the work leaves paths all over the transcript.
 *
 * Deliberately reuses `resolveProjectSlug` on the discovered directory rather
 * than pattern-matching the path itself. Parsing `/…/.worktrees/<name>` yields
 * the WORKTREE name, which is not the project — asking git about the directory
 * is what makes worktrees, subdirectories and renamed clones all resolve to the
 * same answer as tier 1. One resolver, applied to a better guess at the cwd.
 *
 * Ranked by mention count so a stray reference to another repo does not outvote
 * where the work actually happened. Returns undefined rather than a weak guess
 * when nothing resolves.
 */
export function resolveProjectSlugFromContent(
  texts: readonly string[],
  env: NodeJS.ProcessEnv,
  options: { maxCandidates?: number } = {},
): string | undefined {
  const maxCandidates = options.maxCandidates ?? 12;
  const counts = new Map<string, number>();

  for (const text of texts) {
    if (typeof text !== 'string' || text.length === 0) {
      continue;
    }
    const matches = text.match(ABSOLUTE_PATH);
    if (matches === null) {
      continue;
    }
    for (const raw of matches) {
      // Prose puts punctuation against paths ("see /a/b." / "(/a/b)"), and the
      // character class cannot exclude a dot outright because directories
      // legitimately contain them — `guardnil.com` is a repo.
      const cleaned = raw.replace(/[.,;:!?)\]}'"`]+$/, '').replace(/\/+$/, '');
      if (cleaned.length <= 1) {
        continue;
      }
      // Count DIRECTORIES, not raw strings. Twenty files edited in one repo are
      // twenty votes for that repo; counting the strings would make them twenty
      // separate candidates each with one vote, and a single passing mention of
      // another repo would tie with all of them.
      const dir = deepestExistingDir(cleaned);
      if (dir === null) {
        continue;
      }
      counts.set(dir, (counts.get(dir) ?? 0) + 1);
    }
  }

  if (counts.size === 0) {
    return undefined;
  }

  const ranked = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxCandidates);

  for (const [dir] of ranked) {
    // Only a git-derived answer counts. The basename fallback inside
    // resolveProjectSlug is right for a real cwd but wrong here: it would
    // happily return `plans` for `~/.claude/plans`, inventing a project.
    const slug = gitDerivedSlug(dir, env);
    if (slug !== undefined) {
      return slug;
    }
  }
  return undefined;
}

/**
 * Is this directory inside a git repository at all?
 *
 * Lets a caller tell "the cwd resolved to a project" from "the cwd was not a
 * repo and resolveProjectSlug fell back to its basename" — the two are
 * indistinguishable in the return value, and acting on the fallback as though
 * it were an answer is what would let a mentioned path lose to `plans`.
 */
export function cwdIsRepo(
  cwd: string | null | undefined,
  env: NodeJS.ProcessEnv,
): boolean {
  if (cwd === null || cwd === undefined || cwd.trim() === '') {
    return false;
  }
  return gitDerivedSlug(cwd.trim(), env) !== undefined;
}

/** The git half of the ladder, with no basename fallback. */
function gitDerivedSlug(dir: string, env: NodeJS.ProcessEnv): string | undefined {
  if (gitSlugCache.has(dir)) {
    return gitSlugCache.get(dir);
  }
  const slug = gitDerivedSlugUncached(dir, env);
  gitSlugCache.set(dir, slug);
  return slug;
}

function gitDerivedSlugUncached(dir: string, env: NodeJS.ProcessEnv): string | undefined {
  const remote = git(dir, ['remote', 'get-url', 'origin'], env);
  if (remote !== null) {
    const fromRemote = repoNameFromRemote(remote);
    if (fromRemote !== null) {
      return fromRemote;
    }
  }
  const commonDir = git(dir, ['rev-parse', '--git-common-dir'], env);
  if (commonDir !== null) {
    const absolute = path.isAbsolute(commonDir) ? commonDir : path.resolve(dir, commonDir);
    // For a normal checkout the common dir is `<repo>/.git`, so the repository
    // is its PARENT. For a bare repo — the `clone --bare` + linked-worktrees
    // layout — the common dir IS the repository, and taking the parent yields
    // the containing folder instead. That is worse than no answer: every
    // worktree under one parent collapses to the same wrong slug, silently
    // merging unrelated projects rather than failing to match.
    const repoDir = path.basename(absolute) === '.git' ? path.dirname(absolute) : absolute;
    // A bare repo is conventionally `myproj.git`; the project is `myproj`.
    const base = path.basename(repoDir).replace(/\.git$/, '');
    if (base !== '' && base !== '.' && base !== '/') {
      return base;
    }
  }
  return undefined;
}
