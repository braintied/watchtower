#!/usr/bin/env node
// Harness standard element 6: guards are executable rules.
//
// This is the FLEET guard set: rules distilled from Watchtower's
// high-confidence `warning` rows, each one written after a real incident in
// a Braintied repo. Every rule below cites the lesson it came from. Adding a
// rule here propagates the fix to all 63 repos instead of one.
//
// Design: ONE scanner driven by a declarative manifest, not N near-identical
// scripts (house standard: no copy-paste, extract to a shared utility).
//
// Adoption is ratcheted like check-doc-links.mjs: existing violations are
// recorded in .fleet-guards-baseline and the count may only decrease. A repo
// can adopt today without a big-bang cleanup, and cannot regress.
//
// THE GATE JUDGES YOUR BRANCH, NOT THE TREE (2026-07-31)
//
// The first version compared a WHOLE-TREE count against one aggregate integer.
// In a repo whose default branch merges every 2-3 minutes that gate is
// unwinnable, and the measurement is on the record: a guards-tooling branch in
// Sentigen was rejected three times in one evening — once because a rebase let
// main gain a violation between measuring and pushing, and once on two rules
// (`hardcoded design values`, `un-scoped localStorage key`) from a UI commit
// that landed WHILE the 231-second scan was running. Neither had anything to do
// with the branch. A branch cannot win that race, so everyone learns to pass
// --no-verify, and then the ratchet protects nothing.
//
// Two changes, and the pair is what makes it winnable:
//
//   1. PER-RULE baselines. The baseline may be `{ "count": N, "buckets": {...} }`
//      instead of a bare integer, and a rule regresses only if THAT rule's count
//      rose. A design-token violation can no longer block a metering branch, and
//      a cleanup in one rule can no longer pay for new debt in another. A bare
//      integer is still accepted and still works, so no adopter breaks on
//      upgrade.
//
//   2. MERGE-BASE comparison. When git can answer, the gate scans the files this
//      branch touched (`git diff` against `git merge-base HEAD origin/<default>`)
//      and compares each file's per-rule count against the SAME file at the merge
//      base. A violation you added fails; a violation main gained in a file you
//      never opened does not. This is strictly stronger than the whole-tree
//      count, not weaker: it still fails when your branch adds a violation that
//      an unrelated cleanup would have cancelled out in the aggregate.
//
// Every git query degrades to the whole-tree comparison rather than crashing or
// silently passing: no .git (Vercel builds and CLI runs have none), no
// origin/<default> ref, an unborn HEAD, unrelated histories, or a shallow clone
// with no common ancestor all fall back.
//
// Usage: node scripts/checks/check-fleet-guards.mjs [repoRoot] [flags]
//   default:            gate. Fails on a regression THIS BRANCH introduced,
//                       falling back to the whole-tree baseline comparison when
//                       git cannot identify a merge base.
//                       Writes the FIRST baseline if none exists.
//   --update-baseline:  tighten the ratchet after fixing violations. Whole-tree,
//                       and refuses if any rule rose.
//   --rebaseline:       recompute and overwrite, accepting an increase.
//                       The deliberate escape hatch; exits 0.
//   --whole-tree:       ignore git and gate on the whole-tree baseline. What
//                       every run did before 2026-07-31.
//   --base=<ref>:       compare against this ref instead of origin/<default>.
//   --json:             machine-readable findings.
//   --list:             print the rule manifest and exit.
//
// Per-line escape hatch (STANDARD.md element 6):
//   // ci-allow: <rule-id> <reason>
// on the offending line or the line directly above it.

import { execFileSync } from 'node:child_process';
import {
  readFileSync, readdirSync, statSync, existsSync, writeFileSync,
  openSync, readSync, closeSync,
} from 'node:fs';
import { join, relative, extname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const BASELINE_FILE = '.fleet-guards-baseline';
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

// Files that are not code but routinely carry credentials. The 2026-07-26 audit
// found leaks in exactly these: `.claude/settings.local.json` (the permission
// allowlist records approved Bash commands verbatim), `.codex/config.toml`
// (inline MCP env), and agent-authored `.md` runbooks that pasted a working
// value instead of a placeholder.
//
// This set is scanned ONLY by rules that opt in via `extensions`. The
// AST-shaped rules (silent-catch, ts-escape-hatch, boundary-cast) stay on code
// files, where their line heuristics mean something.
const CREDENTIAL_SCAN_EXTENSIONS = new Set([
  ...CODE_EXTENSIONS,
  '.json', '.jsonc', '.toml', '.yaml', '.yml',
  '.md', '.mdx', '.txt', '.sh', '.bash', '.zsh', '.env', '.example',
  // .py: a repo's Python microservices call the same paid inference hosts as
  // its TypeScript, and `raw-ai-fetch` opts into them. collectFiles is the hard
  // prefilter -- a rule's own `extensions` can only NARROW what reaches it,
  // never widen past what was collected -- so the type has to be added here,
  // not just on the rule. Every other rule stays TS/JS-only.
  '.py',
]);
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'out', 'coverage',
  '.turbo', '.vercel', 'vendor', 'third_party', '.harness', 'supabase/.temp',
  // Vercel build machines materialize the package store INSIDE the checkout;
  // scanning it flagged a dependency's content-addressed blob as a "literal
  // credential" and failed a 2026-07-31 production deploy. Package contents
  // are third-party code, same class as node_modules.
  '.pnpm-store',
  // Python's node_modules. Collecting `.py` (see CREDENTIAL_SCAN_EXTENSIONS)
  // put installed dependency code in scope for the first time: librarian's
  // .venv/lib/python3.12/site-packages/huggingface_hub declares an OpenAI base
  // URL and was reported as that repo's unmetered spend. Third-party code is
  // not actionable source in any language.
  '.venv', 'venv', 'site-packages', '__pycache__',
  '.tox', '.mypy_cache', '.pytest_cache', '.ruff_cache',
  // Agent/dev worktrees carry a full duplicate (and usually stale) copy of the
  // tree. Scanning them double-counts every violation and buries the real
  // findings. Swishh had .claude/worktrees/agent-* doing exactly that.
  'worktrees', '.worktrees',
  // Build artifacts. Bundled output is machine-written, frequently minified,
  // and full of patterns that look like violations but are not source. Parlor's
  // sites/ranue/.wrangler/dry-run-*/worker.js alone produced 1,380 phantom
  // silent-catch hits, two thirds of that repo's entire finding count.
  '.wrangler', '.output', '.open-next', '.astro', '.svelte-kit', '.cache',
  '.parcel-cache', 'storybook-static', '.serverless', '.nuxt',
  // Archived code (archive/ora-gateway-*, …) is frozen historical reference.
  // It is never edited, so scanning it only burns the ratchet baseline and
  // trains people to bypass the gate. The ratchet exists to stop NEW debt in
  // LIVE code; archive/ora-gateway-2026-03-05 alone produced 951 phantom hits.
  'archive',
]);

// Bundled/minified files can also sit outside a known build dir. Machine-written
// code is not actionable source, so detect it structurally rather than by path.
function looksBundled(text) {
  if (/^\/\/# sourceMappingURL=/m.test(text)) return true;
  const sample = text.split('\n', 60);
  if (sample.length < 3) return false;
  const avg = sample.reduce((n, l) => n + l.length, 0) / sample.length;
  return avg > 220;
}

// Packages that must be reached through an internal abstraction rather than
// imported directly across the codebase. Extend per repo via --deny-import.
const ABSTRACTION_ONLY_PACKAGES = ['sonner'];

// ---------------------------------------------------------------------------
// VENDORED COPY IDENTITY
// ---------------------------------------------------------------------------
//
// Adopters vendor this file into their own repo, so a fix here does NOT reach
// them: they keep running whatever they copied on adoption day. That fails
// OPEN and silently, because a repo missing a rule reports the same clean
// "guards ok" as a repo that passes it. Measured 2026-08-03: `librarian` was
// 1006 lines behind and missing `raw-ai-fetch`, the rule that keeps AI spend
// on the metered path, while its gate reported green.
//
// GUARDS_VERSION makes drift detectable. `harness guards` compares each
// adopter's version and rule set against the template and `--sync` updates
// them. Bump this whenever RULES changes; `harness guards --verify` fails if
// the declared rule count does not match the manifest, so it cannot be
// forgotten quietly.
// `unscannable-file` is deliberately NOT counted here: the scanner emits it
// itself rather than from a manifest entry, so it is not in RULES.
export const GUARDS_VERSION = '2026.08.11.1';
export const GUARDS_RULE_COUNT = 26;

// The repo-level rules, declared here purely so they are COUNTABLE.
//
// They are implemented as functions rather than RULES entries, because each
// asks about a relationship between files rather than about a line. That put
// them outside `harness guards`, which finds rules by grepping for `id:` — so
// the three that already existed could go missing from an adopter's vendored
// copy and nothing would say so, which is the exact fail-open this file's
// header describes for `raw-ai-fetch`. Naming them closes that hole for all
// five. Keep this list in step with REPO_LEVEL_RULES below.
export const REPO_LEVEL_RULE_MANIFEST = [
  {
    id: 'migration-type-drift',
    lesson: 'A migration that changed the schema without regenerating types leaves every consumer compiling against a database that no longer exists.',
  },
  {
    id: 'package-manager-drift',
    lesson: 'Swishh 2026-07-30: package.json pinned pnpm beside a pnpm-lock.yaml while .localci.sh ran npm ci, so a fresh clone ignored the lockfile and produced 10 phantom typecheck errors.',
  },
  {
    id: 'layer-violation',
    lesson: 'A package depending across a tier boundary makes every consumer inherit a dependency the layer law says it must not have.',
  },
  {
    id: 'comment-cites-missing',
    lesson: 'Mirror 2026-08-10: a comment pointed at a duration ceiling constant that had never existed in the repo, so anyone checking whether a ceiling was enforced followed the pointer, found nothing, and stopped looking. Nothing enforced one, and over-long recordings were accepted and then failed forever.',
  },
  {
    id: 'duplicate-risk-constant',
    lesson: 'Mirror 2026-08-03/09: two files each declared REQUEST_TIMEOUT_MS against a wall clock it exceeded. One was fixed and carefully commented; the other kept the broken value for six more days while owning the longest external call in the system, and CLAUDE.md recorded the lesson as learned the whole time.',
  },
];

// ---------------------------------------------------------------------------
// Rule manifest. Each rule states its provenance so the "why" survives.
// ---------------------------------------------------------------------------

const RULES = [
  {
    id: 'inngest-admin-client',
    lesson: 'Inngest functions must use getAdminClient() not createClient(): createClient() calls Next.js cookies() and crashes outside a request context. All six Inngest functions were wrong at once.',
    appliesTo: (rel) => /inngest|worker|\/jobs?\/|cron/i.test(rel),
    // The dangerous form is the REQUEST-CONTEXT client: createClient() with no
    // args (it reads cookies()), or one imported from a supabase/server|ssr
    // helper. `createClient(url, key)` from @supabase/supabase-js is the
    // correct admin pattern and must NOT be flagged: proven against
    // SilverDollar's packages/inngest, where all 5 hits were correct code.
    test: (line, i, lines) => {
      if (/\bcreateClient\s*\(\s*\)/.test(line)) return true;
      if (!/\bcreateClient\s*\(/.test(line)) return false;
      const importsRequestClient = lines.some((l) =>
        /import[^;]*\bcreateClient\b[^;]*from\s+['"][^'"]*(supabase\/server|supabase\/ssr|\/ssr)['"]/.test(l));
      return importsRequestClient;
    },
    message: 'request-context createClient() inside background-job code; use the service-role admin client',
  },
  {
    id: 'silent-catch',
    lesson: 'Anti-Pattern: Silent Error Swallowing. uspto.ts and ip-monitor-cron.ts swallowed raw provider errors, producing false-positive IP clearance memos.',
    appliesTo: () => true,
    // catch with an empty body, or a catch that only logs.
    test: (line, i, lines) => {
      if (!/\bcatch\s*(\([^)]*\))?\s*\{\s*$/.test(line) && !/\bcatch\s*(\([^)]*\))?\s*\{\s*\}/.test(line)) return false;
      if (/\bcatch\s*(\([^)]*\))?\s*\{\s*\}/.test(line)) return true;
      const body = [];
      for (let k = i + 1; k < Math.min(i + 5, lines.length); k += 1) {
        const t = lines[k].trim();
        if (t === '}') break;
        if (t !== '') body.push(t);
      }
      if (body.length === 0) return true;
      return body.every((t) => /^console\.(log|warn|error|debug)\(/.test(t) || /^return (null|undefined|\[\]|\{\});?$/.test(t));
    },
    message: 'error swallowed (empty catch, or catch that only logs and returns a default); propagate with context',
  },
  {
    id: 'boundary-cast',
    lesson: 'Avoid Implicit Type Assumptions in Pipelines: signal-evaluator-batch failed downstream and untraceably because the incoming JSON schema was never validated at the entry point.',
    appliesTo: () => true,
    // `as unknown` is the SAFE direction (it forces validation downstream);
    // only a cast to a concrete type is the violation.
    test: (line) => {
      if (/\bas\s+unknown\b/.test(line)) return false;
      return /(await\s+)?(request|req)\.json\(\)\s*(as\s|<)/.test(line)
        || /JSON\.parse\([^)]*\)\s+as\s/.test(line);
    },
    message: 'external payload type-asserted instead of validated; parse it through a Zod schema',
  },
  {
    id: 'env-fail-open',
    lesson: 'Environment Variable Corruption Warning + ~1,800 live failures in 14 days from absent config (DROPBOX_LIB_FOLDER_URL, COMMERCE_CANARY_*, festival_photo_sync_config). Missing credentials must fail closed with a named error, never silently default.',
    appliesTo: () => true,
    test: (line) => /process\.env\.[A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD|URL|DSN|CREDENTIAL)[A-Z0-9_]*\s*(\|\||\?\?)\s*['"`]/.test(line),
    message: 'credential/config env var silently defaults; throw a named error instead so it fails closed',
  },
  {
    id: 'client-secret-exposure',
    lesson: 'Sensitive Data Exposure Warning: secrets and PII must never reach a client bundle or public route.',
    appliesTo: () => true,
    test: (line) => /NEXT_PUBLIC_[A-Z0-9_]*(SECRET|PRIVATE|SERVICE_ROLE|PASSWORD)[A-Z0-9_]*/.test(line),
    message: 'secret-shaped value exposed under NEXT_PUBLIC_ and shipped to the browser',
  },
  {
    id: 'literal-credential',
    lesson:
      'Fleet credential audit 2026-07-26: a scan of tracked files across every repo found real ' +
      'credentials in ~39 distinct places — Supabase account-level PATs, a LIVE GitHub PAT, ' +
      'Stripe live secrets, service-role JWTs. Three mechanisms put them there, and none was ' +
      'someone typing a secret into source: (1) Claude Code persists approved Bash commands ' +
      'VERBATIM into settings.local.json, so `export SUPABASE_ACCESS_TOKEN=sbp_...` became a ' +
      'committed literal; (2) agent-authored runbooks pasted the working value instead of a ' +
      'placeholder; (3) `git add -A` swept untracked config into a feature commit. gitignore ' +
      'closes (1) and (3) for files it covers — this rule catches the value wherever it lands.',
    // Scans config, docs and shell as well as code. The first version of this
    // rule inherited CODE_EXTENSIONS and was therefore blind to every file type
    // its own lesson text names -- settings.local.json, .codex/config.toml, and
    // .md runbooks. It was "verified" against a .ts file, the one substrate
    // where the leak never happened.
    extensions: CREDENTIAL_SCAN_EXTENSIONS,
    // A credential in a comment is still a credential.
    scanComments: true,
    // Never absorbed by the ratchet. The baseline is a single integer and the
    // gate is `count > baseline`, so in a repo like Sentigen-App (baseline 857)
    // a new secret is cancelled out by any commit that removes an `any`
    // elsewhere. Credentials are not debt to amortise: any hit fails.
    alwaysFail: true,
    // Only git can publish a file. A gitignored .env is where a secret is
    // SUPPOSED to live -- flagging it fails every push over correct practice
    // and gets the whole gate switched off. See trackedFiles().
    trackedOnly: true,
    appliesTo: () => true,
    test: (line) => {
      // Vendor-prefixed shapes only. A generic "long random string" test would
      // fire on hashes, UUIDs, and minified code, and a guard that cries wolf
      // gets bypassed — which is worse than no guard.
      const m = line.match(
        /\b(?:sbp_[A-Za-z0-9_-]{20,}|sb_secret_[A-Za-z0-9_-]{16,}|(?:sk|rk)_live_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9]{16,}|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-ant-[A-Za-z0-9_-]{20,}|sk-proj-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{16,}|npm_[A-Za-z0-9]{30,}|fm[12]a?_[A-Za-z0-9+/=]{30,})\b/
      );
      if (m === null) return false;
      // Fixtures and docs legitimately carry the SHAPE. The audit's first pass
      // reported 283 hits; half were Slack-bot-shaped test fixtures (the
      // `xoxb-` prefix followed by digits).
      // Excluding them is what makes the remainder worth acting on.
      // `YOUR_` alone missed the far more common hyphenated form: an
      // .env.example carrying an Anthropic-shaped `your-...-api-key` stub is a
      // placeholder,
      // and flagging it teaches people the guard is noise. `_here` catches the
      // other house style, `your_token_here`.
      return !/EXAMPLE|FAKE|PLACEHOLDER|\byour[-_]|[-_]here\b|REDACTED|xxxx|changeme|dummy|sample|\btest\b|\bmock\b|<[a-z-]+>/i.test(
        line
      );
    },
    message:
      'literal credential in a tracked file — move it to the environment or the vault, and rotate it (git history is permanent)',
  },
  {
    id: 'abstraction-bypass',
    lesson: "Avoid 'Sonner' Direct Dependency: importing it throughout the codebase created tight coupling that made global styling and behavior changes impossible.",
    appliesTo: () => true,
    test: (line, i, lines, ctx) => {
      const m = line.match(/from\s+['"]([^'"]+)['"]/);
      if (m === null) return false;
      if (!ctx.denyImports.includes(m[1])) return false;
      // The abstraction module itself is allowed to import the package.
      return !/providers?\/|lib\/(toast|notify|notification)|components\/ui\//i.test(ctx.rel);
    },
    message: 'third-party package imported directly; route it through the internal abstraction',
  },
  {
    id: 'ts-escape-hatch',
    // ci-allow: ts-escape-hatch rule manifest text describing the pattern, not code doing it
    lesson: 'House type-safety standard: no any, no as assertions, no non-null !, no @ts-ignore. Fix the type rather than silencing it.',
    appliesTo: (rel) => !/\.d\.ts$/.test(rel),
    test: (line) => /@ts-(ignore|expect-error)/.test(line) || /\bas\s+any\b/.test(line) || /:\s*any\b/.test(line),
    // ci-allow: ts-escape-hatch rule manifest text describing the pattern, not code doing it
    message: 'TypeScript escape hatch (any / @ts-ignore); fix the underlying type',
  },
  {
    id: 'arbitrary-type-scale',
    lesson:
      "Nusa's chrome reached 100 arbitrary font sizes across five values — `text-[11px]` alone 55 times — so the type scale lived in a hundred class strings and could not be retuned anywhere. Naming the sizes by role (meta, label, caption) also made the class say what the number is FOR.",
    appliesTo: (rel) => /\.(tsx|jsx)$/.test(rel),
    test: (line) => /\btext-\[[0-9.]+(px|rem|em)\]/.test(line),
    message: 'arbitrary font size; add it to the theme type scale and name it by role',
  },
  {
    id: 'font-escape-hatch',
    lesson:
      '`font-[family-name:var(--font-mono)]` appeared 32 times in one repo purely because nobody checked that the theme already exposed `font-mono`. The arbitrary-value escape hatch was never needed, and it hides the fact that a family IS themed.',
    appliesTo: (rel) => /\.(tsx|jsx)$/.test(rel),
    test: (line) => /font-\[family-name:/.test(line),
    message: 'font escape hatch; register the family in the theme and use the plain utility',
  },
  {
    id: 'hardcoded-theme-color',
    lesson:
      'A colour literal in a component cannot follow a theme. Nusa defined a full light environment that had never rendered, and 65 literal `white/N` utilities plus 14 inline rgba() would each have had to be found by hand the day someone wired the toggle. Tokens are what let one component serve both environments.',
    appliesTo: (rel) => /\.(tsx|jsx)$/.test(rel) && !/\.(test|spec)\./.test(rel),
    test: (line) => {
      // Documentation frequently quotes the values it is warning about, so
      // comment lines are not findings — flagging them teaches people to stop
      // explaining their colour decisions.
      const code = line.trim();
      if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return false;
      if (/#[0-9a-fA-F]{6}\b/.test(code)) return true;
      return /\brgba?\(\s*\d/.test(code);
    },
    message: 'hardcoded colour in a component; move it to a theme token so it can follow the theme',
  },
  {
    id: 'handrolled-cortex-auth',
    lesson:
      'Cortex agent-token validation was copy-pasted into four products (Parlor, Comfy, Swishh, ora-ai) from a file whose own header read "Drop this file into any product". They drifted independently, and two of them shipped the same fail-open product_access bug for months. @braintied/agent-auth is the one implementation.',
    appliesTo: (rel) => !/node_modules|\.test\.|\.spec\./.test(rel),
    test: (line, i, lines, ctx) => {
      // Querying Cortex's token table directly is the tell. Only the shared
      // package (and Cortex's own repo) should ever touch it.
      // ci-allow: handrolled-cortex-auth rule manifest text describing the pattern, not a query
      if (!/agent_api_tokens/.test(line)) return false;
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return false;
      // The package itself, and SQL/migration files, are the legitimate owners.
      return !/packages\/agent-auth\/|supabase\/migrations\/|\.sql$/.test(ctx.rel);
    },
    message:
      // ci-allow: handrolled-cortex-auth rule manifest text describing the pattern, not a query
      'agent_api_tokens queried directly; use @braintied/agent-auth (createCortexTokenValidator / CortexAgentAuthenticator / createAgentAuth)',
  },
  {
    id: 'product-access-fail-open',
    lesson:
      // ci-allow: product-access-fail-open rule manifest text describing the pattern, not authorization code
      'Parlor and Comfy both gated on `productAccess.length > 0 && !includes(productId)`, so a token with an EMPTY product_access array was granted access to EVERY product. No live token had an empty array, so it went unnoticed — a latent fleet-wide grant one UPDATE away from being real.',
    appliesTo: (rel) => !/node_modules/.test(rel),
    test: (line) => {
      // Prose describing the bug is not the bug. Without this, the doc comment
      // in a migrated file explaining what was fixed re-trips the rule forever.
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return false;
      return /(product_?[Aa]ccess|scopes|permissions|allowed[A-Za-z]*)\s*\.length\s*>\s*0\s*&&\s*!/.test(
        line
      );
    },
    message:
      'authorization list gated on being non-empty, so an empty list grants everything; require membership outright',
  },
  {
    id: 'direct-research-provider',
    lesson:
      'Sentigen carried five files calling Tavily/Perplexity/Firecrawl/Jina endpoints directly, and had a guard for it. No other repo did — so while Sentigen was consolidating onto @braintied/research, Cortex quietly accumulated 17 direct-provider files, Swishh 5, Parlor 2. A guard that lives in one repo only protects one repo. ' +
      'The cause is almost never laziness: it is a missing package primitive. Every host that needed "query in, answer out" kept its own fetch because the package had no full-answer API, and migrating onto search() would have silently truncated the answer to 500 chars. The fix was one primitive added to the package, not N call-site rewrites. ' +
      'Two of the four Jina call sites were invisible for a week because the pattern only matched Tavily/Perplexity/Firecrawl — a check narrower than the rule it claims to enforce is worse than none, because it reads as proof.',
    // Three narrow exclusions, each verified against a real fleet repo rather
    // than guessed. Keep them narrow: the original Sentigen pattern hid two
    // live Jina calls for a week precisely by being broader than it looked.
    //   next.config.*  — Parlor lists these hosts in a CSP domain allowlist.
    //                    Declaring a host is permitted is not calling it.
    //   *-dist/, dist/ — ora-ai's plugins-dist/*.cjs are build artifacts of
    //                    plugins/*.ts, so every hit is double-counted.
    //   _archived/     — dead code kept for reference; migrating it is pointless.
    appliesTo: (rel) =>
      !/node_modules|\.test\.|\.spec\./.test(rel)
      && !/(^|\/)next\.config\.[cm]?[jt]s$/.test(rel)
      && !/(^|\/)([a-z0-9-]*-)?dist\//.test(rel)
      && !/(^|\/)_archived\//.test(rel),
    test: (line, i, lines, ctx) => {
      // Prose about the rule is not a violation of it. This guard has tripped
      // on its own explanatory comments before.
      if (/^\s*(\/\/|\*|\/\*|#)/.test(line)) return false;
      // r.jina.ai = Reader, s.jina.ai = Search. Both are provider mechanics the
      // package owns. crawl4ai cannot replace Jina SEARCH: it fetches a URL you
      // already have, it does not find pages for a query.
      if (!/api\.tavily\.com|api\.perplexity\.ai|@mendable\/firecrawl|api\.firecrawl\.dev|[rs]\.jina\.ai|api\.jina\.ai/.test(line)) {
        return false;
      }
      // The research package itself is the legitimate owner of these endpoints.
      return !/packages\/research\//.test(ctx.rel);
    },
    message:
      'research provider called directly; use @braintied/research (perplexityAnswer / tavilyAnswer / crawlUrl / redditProvider / youtubeProvider). If the primitive you need is missing, ADD IT TO THE PACKAGE rather than reaching past it',
  },
  {
    id: 'misleading-model-tier',
    lesson:
      "The tier ladder is not monotonic and the names imply it is. In Sentigen's models.ts, NANO, MICRO and MID all resolve to the SAME model (gemini-3.1-flash-lite); STANDARD is the first real step up. So `modelTier: 'MID'`, chosen because it sounds like a middle option, gets you the smallest model there is. Research-program comprehension ran a 120K-character transcript into a ten-field structured object on MID: it worked six times, then on identical input produced a 6,000-token runaway once and an empty object (situation:\"\", zero organizations) once. Same everything, different outcomes — a model at its capability edge, which reads like flaky infrastructure rather than a wrong tier. CLAUDE.md already said MICRO/MID are for extraction and STANDARD+ for explicit reasoning; nothing enforced it. A related trap: the `model` column on an admin.ai_prompts row is DECORATIVE when the caller passes a modelTier, so that row said gemini-2.5-flash and never ran.",
    appliesTo: (rel) => /\.(ts|tsx)$/.test(rel),
    test: (line, i, lines) => {
      if (!/modelTier:\s*['\"](MID|MICRO|NANO)['\"]/.test(line)) return false;
      // Heavy call? A big output budget is the cheapest available proxy for
      // "this is reasoning, not field extraction". Deliberately narrow: a
      // small-output MID call is exactly what the tier is for, and a rule that
      // fires on those would be ignored within a week.
      for (let j = Math.max(0, i - 20); j < Math.min(lines.length, i + 20); j += 1) {
        const m = lines[j].match(/maxOutputTokens:\s*([0-9_]+)/);
        if (m !== null && Number(m[1].replace(/_/g, '')) >= 4000) return true;
      }
      return false;
    },
    message:
      'MID/MICRO/NANO all resolve to the SAME smallest model, and this call asks for a large structured output. If it reasons rather than extracts, use STANDARD or above; the failure mode is intermittent garbage, not a clean error',
  },
  {
    id: 'raw-ai-fetch',
    lesson:
      'A raw HTTP call to a paid inference host bypasses the tracked wrapper and spends tokens that never reach the cost ledger. Sentigen banned this in CLAUDE.md and wrote the enforcement (scripts/check-no-raw-ai-fetch.sh), but wired it into a GitHub Actions workflow only -- and Actions on that repo is billing-disabled/advisory ("CI is local"), so the rule read as enforced in the docs and CI-blocked in a file no push could ever fail. Four call sites sat pre-marked `// ci-allow: raw-ai-fetch` waiting for a gate that would actually read them. ' +
      'Ported here because this file IS in the pre-push gate. Two widenings on the way: the shell version walked only `src/` with `--include=*.ts,*.tsx`, while scanRepo walks the whole tree minus SKIP_DIRS -- so packages/, scripts/, and services/ are in scope for the first time -- and the host list grew from four to seven. ' +
      'The four-host version was itself NARROWER than useful: api.voyageai.com was absent while Sentigen ran seven raw voyage embedding fetches emitting ~3,838 ledger rows a day, entirely outside the gate. A check narrower than the rule it claims to enforce is worse than none, because it reads as proof.',
    // .py opts in for Python microservices that call the same hosts (see
    // CREDENTIAL_SCAN_EXTENSIONS); every other rule stays TS/JS-only.
    extensions: new Set([...CODE_EXTENSIONS, '.py']),
    appliesTo: (rel) =>
      !/node_modules|\.test\.|\.spec\./.test(rel)
      && !/(^|\/)([a-z0-9-]*-)?dist\//.test(rel)
      && !/(^|\/)_archived\//.test(rel)
      // Python test naming. collectFiles drops `*.test.*` / `*.spec.*`, which
      // are JS conventions and match nothing in a Python tree; pytest names
      // files `test_*.py` / `*_test.py`. librarian's tests/test_synth.py asserts
      // on the endpoint string it must NOT post to, and was counted as spend.
      && !/(^|\/)test_[^/]*\.py$/.test(rel)
      && !/_test\.py$/.test(rel),
    test: (line) => {
      // Prose about the rule is not a violation of it. scanRepo already skips
      // `//` and `*` lines; `#` and `/*` are added here because this rule is
      // the one that reads Python and block comments.
      if (/^\s*(\/\/|\*|\/\*|#)/.test(line)) return false;
      // A Content-Security-Policy directive lists hosts the browser MAY reach.
      // Declaring a host is permitted is not calling it -- and a repo that
      // correctly confines its AI traffic to a CSP allowlist would otherwise be
      // punished for documenting it. Swishh's lib/security/headers.ts trips
      // this twice. Same class as the `next.config.*` carve-out on
      // direct-research-provider, but matched on the directive rather than the
      // filename, because a CSP is not always in a file named for one.
      if (/\b(connect|default|script|img|frame|media|font|style|worker)-src\b/.test(line)) return false;
      // Anchored on the `//` of a scheme, so a HOST is matched only where a URL
      // is being built. Sentigen's model-registry.ts documents two embedding
      // models with `providerNotes: 'Served from api.voyageai.com'` -- a data
      // string describing a provider, not a call to it. A bare host match
      // reported both as unmetered spend. Every real call site in the fleet
      // writes the scheme (`https://api.voyageai.com/v1/embeddings`), so
      // requiring it costs no true positive and removes the whole false class.
      // The trailing lookahead stops `//api.x.ai` matching `//api.x.aizen.com`.
      return /\/\/(api\.anthropic\.com|api\.openai\.com|api\.perplexity\.ai|generativelanguage\.googleapis\.com|api\.voyageai\.com|api\.assemblyai\.com|api\.x\.ai)(?![\w.-])/.test(line);
    },
    // KNOWN BLIND SPOT, stated so a green gate is not mistaken for coverage.
    //
    // This rule matches raw `fetch()` URLs. It is structurally blind to SDK
    // clients -- `new Anthropic()`, `new GoogleGenAI()`, `new OpenAI()`,
    // `@ai-sdk/*` -- which carry their base URL inside the dependency and never
    // write the host in repo source. That is how six unmetered files in Swishh
    // and a bare `new Anthropic()` in Sentigen's packages/autonomous-agent all
    // pass this rule clean.
    //
    // The SDK case needs import- and construction-shaped analysis (does this
    // module construct a provider client without routing through the tracked
    // wrapper?), which is a different rule, not a wider regex here. Do not
    // "fix" this by adding SDK package names to the pattern above: an import
    // line is not a call site, and flagging every import would bury the raw
    // fetches this rule does catch.
    message:
      'raw HTTP call to a paid AI inference host; route it through this repo\'s tracked wrapper so the spend reaches the cost ledger (@braintied/cost -> ora_core.ai_usage_events). A wrapper that legitimately owns the endpoint marks its own call site with `// ci-allow: raw-ai-fetch <reason>`',
  },
  {
    id: 'inngest-hot-cron',
    lesson:
      '2026-08-02/03 Inngest efficiency program: every-minute crons on outbox drains, recovery sweeps, and email relays burned tens of thousands of empty runs/month and fed failure-handler storms when setup was broken. Policy (2026-08-02): 15-minute cadence is OK for email/outbox/relays; prefer event-wake + */15 safety cron; never delete functions that look dead. Soft-skip permanent setup errors so monitors complete instead of FAILED forever. Record actions in ora_core.inngest_efficiency_actions; measure with ingops / @braintied/inngest-ops.',
    appliesTo: (rel) =>
      /inngest/i.test(rel)
      && !/\.test\.|\.spec\./.test(rel)
      && !/node_modules/.test(rel),
    test: (line) => {
      // Prose/docs in comments are not the schedule.
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return false;
      // Every-minute forms Inngest accepts as cron triggers.
      if (/cron\s*:\s*['"`]\*\s+\*\s+\*\s+\*\s+\*['"`]/.test(line)) return true;
      if (/cron\s*:\s*['"`]\*\/1\s+\*\s+\*\s+\*\s+\*['"`]/.test(line)) return true;
      // Array form: { cron: '* * * * *' } already matched above.
      return false;
    },
    message:
      'every-minute Inngest cron; fleet policy is */15 for outbox/email/relays (event-wake + safety cron). Soft-skip permanent setup; do not delete the function. See @braintied/inngest-ops createOutboxDrain + ingops playbook.',
  },
  // -------------------------------------------------------------------------
  // PROXY ASSERTIONS (2026-08-03). One defect class, found eight times across
  // four repos in a four-day fleet alert investigation: a check that asserts a
  // PROXY for the thing it protects, and therefore reports green through a
  // total outage. The four rules below are the mechanically detectable subset.
  // The two that resist automation are written up in STANDARD.md 6d rather
  // than shipped as regexes that would cry wolf.
  // -------------------------------------------------------------------------
  {
    id: 'port-open-as-health',
    lesson:
      'The supervisor daemon\'s healthCheck asserted that port 1236 was open. kit-0 sat dead for two days while "OK serving" was logged every three minutes, because the model catalog was empty and the process was still holding the listening socket. A port is bound by the OS at bind() time and stays bound until the process exits, so an open port proves the process has not crashed -- it proves nothing about whether the service can do its job. The assertion has to name the WORK: the catalog is non-empty, the required model is present, the queue is draining.',
    extensions: new Set([...CODE_EXTENSIONS, '.sh', '.bash', '.zsh']),
    appliesTo: (rel) => !/node_modules|\.test\.|\.spec\./.test(rel),
    test: (line, i, lines) => {
      if (/^\s*(\/\/|\*|\/\*|#)/.test(line)) return false;
      // A TCP-liveness probe: a bare connect, or the shell idioms for one.
      const probesPort = /\bnet\.(connect|createConnection)\s*\(/.test(line)
        || /\bcreateConnection\s*\(\s*\{[^}]*\bport\b/.test(line)
        || /\bnc\s+(-\w*z\w*)\s/.test(line)
        || /\/dev\/tcp\//.test(line)
        || /\blsof\s+-i\s*:/.test(line);
      if (!probesPort) return false;
      // ...inside something that calls itself a health/liveness check. Without
      // this the rule would flag every legitimate port-reachability utility,
      // which is a fine thing to write -- the defect is calling it health.
      for (let k = i; k >= 0 && k > i - 25; k -= 1) {
        if (/\b(health[_A-Za-z]*check|check[_A-Za-z]*health|is[_A-Za-z]*(healthy|alive)|liveness|readiness|is[_A-Za-z]*up|probe[_A-Za-z]*)\b/i.test(lines[k])) {
          return true;
        }
      }
      return false;
    },
    message:
      'health check asserts only that a TCP port is open; a process holds its listening socket until it exits, so this reports healthy through a total outage. Assert the WORK instead (catalog non-empty, required model present, queue draining)',
  },
  {
    id: 'probe-wakes-parked-host',
    lesson:
      'Swishh\'s systemHealthProbe ran every 30 minutes and GET /health against ora-scraper.fly.dev and cortex-searxng-a/b. Those apps run auto_stop_machines with min_machines_running=0, and on Fly a request to the public hostname is not a passive observation -- the proxy STARTS the machine to serve it. The probe was a ~48/day wake trigger on the fleet\'s most expensive VM (performance-2x/8GB), and then reported `red: This operation was aborted` because it timed out waiting for the wake it had itself caused: paying for compute and getting a false alarm in exchange. Measured 2026-08-06 -- three machines deliberately parked were found started 2h later, and the control (cortex-searxng-c, which nothing probes) was still stopped. cortex-worker had already fixed exactly this for the SAME scraper ("that public ping auto_started the scale-to-zero machine and defeated on-demand savings") and Swishh never inherited the pattern, which is why this belongs in a fleet rule rather than a repo. The fix is to consult machine state first and skip when the app is parked: asleep is not a fault, and reporting it as one trains operators to ignore the row that matters when the service is genuinely down.',
    extensions: new Set([...CODE_EXTENSIONS, '.sh', '.bash', '.zsh']),
    appliesTo: (rel) =>
      !/node_modules|\.test\.|\.spec\./.test(rel)
      && !/(^|\/)_archived\//.test(rel)
      && !/(^|\/)archive\//.test(rel),
    test: (line, i, lines) => {
      if (/^\s*(\/\/|\*|\/\*|#)/.test(line)) return false;
      // A *.fly.dev host literal. The trigger is the HOST, not the fetch call,
      // because in both real incidents they sit on different lines: the host is
      // assigned to a url/default/pool variable and fetched later through it
      // (`const url = ... 'https://ora-scraper.fly.dev'` then
      // `fetchWithTimeout(\`${url}/health\`)`, and an array of searxng nodes then
      // a loop). A same-line rule requiring both was blind to the exact bug it
      // was written for -- caught only by running it against the real pre-fix
      // file, which is why every fixture below is copied rather than invented.
      if (!/https?:\/\/[a-z0-9-]+\.fly\.dev/i.test(line)) return false;

      // ...from inside something that calls itself a health/liveness probe.
      // Same lookback idiom as port-open-as-health: fetching a Fly service is
      // ordinary work, and only becomes this defect when it is a health check.
      let inProbe = false;
      for (let k = i; k >= 0 && k > i - 25; k -= 1) {
        if (/\b(health[_A-Za-z0-9]*(check|probe)|check[_A-Za-z0-9]*health|probe[_A-Za-z0-9]*|liveness|readiness|is[_A-Za-z0-9]*(healthy|alive|up))\b/i.test(lines[k])) {
          inProbe = true;
          break;
        }
      }
      if (!inProbe) return false;

      // A probe that already consults machine state before reaching out is the
      // FIXED shape, not the defect. Without this the rule would flag both
      // cortex-worker's fix and Swishh's fix, i.e. punish the repos that solved
      // it -- the fastest way to get a rule deleted.
      for (let k = Math.max(0, i - 40); k < Math.min(lines.length, i + 5); k += 1) {
        // COMMENTS DO NOT COUNT. Without this, prose silences the rule: a comment
        // explaining why a probe is acceptable ("gating needs FLY_API_TOKEN, which
        // this app does not hold") reads as evidence of the gate it says is
        // missing, and the finding disappears. Observed 2026-08-11 while
        // annotating Sentigen — the annotation suppressed the finding by naming
        // the mechanism, which is a bypass anyone could reproduce by accident.
        // The escape hatch is `// ci-allow: <rule-id> <reason>`, which is
        // deliberate, greppable and reviewed; a passing mention is none of those.
        if (/^\s*(\/\/|\*|\/\*|#)/.test(lines[k])) continue;
        if (/\b(skipIfParked|scaledToZero|anyMachineStarted|machines\.dev|FLY_API_TOKEN|flyGet|machine[_A-Za-z]*state|isParked)\b/i.test(lines[k])) {
          return false;
        }
      }
      return true;
    },
    message:
      'health probe fetches a *.fly.dev host; if that app is scale-to-zero the request STARTS it, so the probe becomes the cost driver and then times out on the wake it caused. Consult machine state first and report parked as healthy-idle',
  },
  {
    id: 'abort-exits-zero',
    lesson:
      'deploy-all.sh exited 0 when it REFUSED to deploy, so "new release + healthy" and "silent no-op" were indistinguishable to every caller and every log reader. An exit code is a script\'s only structured output; spending 0 on a path that printed "aborting" tells the caller the work succeeded. The vocabulary below is deliberately narrow -- "skipping", "nothing to do" and "already up to date" are legitimate no-ops and are NOT matched, because a rule that flags them would be bypassed within a day.',
    extensions: new Set(['.sh', '.bash', '.zsh']),
    // Frozen trees are never edited, so findings there only inflate a baseline
    // and train people past the gate. Same carve-out the research-provider and
    // raw-ai-fetch rules already make.
    appliesTo: (rel) => !/(^|\/)_archived\//.test(rel) && !/(^|\/)archive\//.test(rel),
    test: (line, i, lines) => {
      if (/^\s*#/.test(line)) return false;
      // A STATUS SUMMARY is not a refusal. `echo -e "Failed: ${TESTS_FAILED}"`
      // is a test runner printing a count -- measured against ora-ai, where it
      // was the rule's most common false positive -- and the tell is that the
      // vocabulary is a label followed by a value rather than a sentence.
      if (/(fail(ed|ures?)?|error|abort(ed)?)s?\s*:\s*[$"'`\x24{]/i.test(line)) return false;
      // A SUCCESS message that happens to contain failure vocabulary is not a
      // refusal. Measured on Sentigen: `echo "OK: no onFailure handlers found
      // (vacuously true)."` matched because "onFailure" contains "failure", and
      // `"...all evidence-link writers have observable failure handling"` is a
      // guard reporting that the thing it wants IS present. A line announcing
      // OK / PASS / a vacuous pass is reporting success whatever words it uses.
      if (/(^|[^A-Za-z])(OK|PASS(ED)?|SUCCESS)([^A-Za-z]|$)|✅|vacuous/i.test(line)) return false;
      // A SELF-TEST asserts that something fails, and says so. Sentigen's
      // authorize-observation-worker-release.sh proves its own sha validator by
      // feeding it bad input; ora-ai's deploy-all.sh proves its wait helper
      // times out. Both print failure vocabulary on the path where the script
      // is working correctly.
      if (/self[-_ ]?test|\bexpected\b|\bshould (fail|error|abort)\b/i.test(line)) return false;
      // `die`, `fail`, `fatal`, `bail` are the house names for a helper that
      // exits non-zero on its own. A line calling one is already reporting the
      // failure through the exit code, which is precisely what this rule asks
      // for -- flagging it inverts the rule.
      if (/(^|[\s;&(|])(die|fatal|bail|abort|fail)\s/.test(line)) return false;
      // An output command carrying REFUSAL vocabulary. Not "skip"/"nothing to
      // do": those describe a no-op the caller asked for.
      if (!/\b(echo|printf|log|logger|warn)\b/.test(line)) return false;
      if (!/refus|abort|cannot|can't|unable to|fail(ed|ure)?\b|not deploy|unsafe|blocked|denied|bail(ing)?\b|giving up/i.test(line)) {
        return false;
      }
      // ...followed by a success exit before any non-zero one. `exit 1`,
      // `exit $?`, `return 1` or a further refusal all mean the path is
      // already reporting itself, so the search stops there.
      for (let k = i + 1; k < Math.min(i + 7, lines.length); k += 1) {
        const next = lines[k];
        if (/^\s*#/.test(next)) continue;
        if (/\b(exit|return)\s+(?!0\b)(\$|\d)/.test(next)) return false;
        if (/^\s*(exit|return)\s+0\s*(;|$)/.test(next)) return true;
      }
      return false;
    },
    message:
      'script prints a refusal or failure and then exits 0, so a caller cannot tell a completed run from a refused one; exit non-zero on the path that did not do the work',
  },
  {
    id: 'grep-fail-open',
    lesson:
      'check-inngest-registration.sh grepped source files for an exported Inngest function. One file carried raw NUL bytes, so grep treated it as binary, printed nothing, matched nothing -- and the guard concluded the export was absent, then that everything was registered. A P0 rule failed OPEN because the tool it was built on reports "no match" and "cannot read this" with the same silence. In a guard, `grep` over a file always takes -a: the cost is nil and the alternative is a check that cannot tell absence from blindness.',
    extensions: new Set(['.sh', '.bash', '.zsh']),
    // Guard and check scripts only. A `grep` in a build or convenience script
    // is not making a pass/fail judgement, and flagging every one of them would
    // bury the guards this rule exists to protect.
    appliesTo: (rel) => (/(^|\/)(check|guard|verify|assert)[-_][^/]*\.(sh|bash|zsh)$/.test(rel)
      || /(^|\/)(checks|guards)\//.test(rel))
      && !/(^|\/)_archived\//.test(rel) && !/(^|\/)archive\//.test(rel),
    test: (line) => {
      if (/^\s*#/.test(line)) return false;
      if (!/(^|[\s;&(])grep\b/.test(line)) return false;
      // Already reading binary as text.
      if (/\s(-\w*a\w*|--text|--binary-files=)/.test(line)) return false;
      // A PIPED grep is out of scope, always. The producer chose the bytes, and
      // the overwhelmingly common shape is a filter in a pipeline
      // (`... | grep -v '^archive/'`) rather than a read of a file that might
      // be binary. An earlier version tried to keep piped reads in scope and
      // matched those filters instead -- measured on ora-ai, every hit in
      // check-dangerous-patterns.sh was a filter. The incident this rule exists
      // for (check-inngest-registration.sh) greps a FILE OPERAND, which is
      // where a NUL byte can arrive unannounced.
      if (/\|\s*grep\b/.test(line)) return false;
      const afterGrep = line.slice(line.search(/(^|[\s;&(])grep\b/));
      // A file operand: a quoted variable, or a path-shaped token.
      return /grep\b(?:\s+-[^\s]+)*\s+(?:-e\s+)?(?:"[^"]*"|'[^']*'|\S+)\s+(["']?[~$]\{?[A-Za-z_/]|\S*\/\S+|\S+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|sh|sql|txt|log|yml|yaml))/.test(afterGrep);
    },
    message:
      'grep reads a file without -a in a guard script; a NUL byte anywhere in that file makes grep report "no match" for content that is present, so the guard fails OPEN. Add -a (or --text)',
  },
  {
    id: 'unreachable-alarm',
    lesson:
      'bootstrap-crons.sh warned that its cron store was missing -- inside `if (fs.existsSync(store))`. The alarm was unreachable in exactly the failure it was written for, which is the most expensive way to be silent: the code reads as covered, so nobody looks again. Any alarm about a resource must be reachable when that resource is absent, which almost always means it belongs in the ELSE branch.',
    // .sh is in scope because the fleet's boot scripts embed node heredocs:
    // bootstrap-crons.sh, the script this lesson came from, is a .sh file whose
    // existsSync lives inside `node <<'JS'`. A JS-only rule would have been
    // blind to its own incident.
    extensions: new Set([...CODE_EXTENSIONS, '.sh', '.bash', '.zsh']),
    appliesTo: (rel) => !/node_modules/.test(rel) && !/(^|\/)_archived\//.test(rel),
    test: (line, i, lines) => {
      if (/^\s*(\/\/|\*|\/\*|#)/.test(line)) return false;
      // The POSITIVE existence guard only. `if (!existsSync(x))` is the correct
      // shape and must never be flagged.
      const guard = /\bif\s*\(\s*(?:await\s+)?(?:fs\.)?existsSync\s*\(\s*([A-Za-z_$][\w$.]*)\s*\)\s*\)/.exec(line);
      if (guard === null) return false;
      const subject = guard[1].split('.').pop();
      for (let k = i + 1; k < Math.min(i + 13, lines.length); k += 1) {
        const body = lines[k];
        // Leaving the block ends the search; a sibling `else` branch is where
        // the alarm is SUPPOSED to live.
        if (/^\s*\}/.test(body)) break;
        if (!/console\.(warn|error)|\bthrow\b|\bwarn\(|\bnotify\(|\balert\(/.test(body)) continue;
        if (!/missing|not found|absent|does not exist|no such|never (ran|fired|wrote)/i.test(body)) continue;
        // The alarm must be about the SAME thing the guard proved present.
        // Without this, an inner per-item existence check inside an outer
        // directory check reads as the bug and is not.
        if (new RegExp(`\\b${subject}\\b`).test(body)) return true;
      }
      return false;
    },
    message:
      'alarm about a resource being missing sits inside the branch that only runs when it is present, so it can never fire in its own failure case; move it to the else branch',
  },

];

// A generated Supabase types file DEFINES `Database`; a re-export stub only
// forwards it. Reading the head is enough — the CLI emits `export type Json`
// then `export type Database = {` within the first few lines of every layout.
function definesDatabaseType(full) {
  let head = '';
  try {
    head = readFileSync(full, 'utf8').slice(0, 8192);
  } catch {
    // Unreadable candidate: treat as "not the generated file" and keep looking
    // rather than pinning the rule to a file we cannot inspect.
    return false;
  }
  return /export\s+type\s+Database\s*=/.test(head);
}

// Environment for every git spawn in this checker. Hook-injected repo
// overrides (GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE) are scrubbed because
// they BEAT `-C root`: under a pre-push hook they point at the hook's repo,
// so an inherited env makes these calls read (or, for callers that commit,
// WRITE) the wrong repository. `-C root` + discovery is always the intent.
function gitEnv() {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return env;
}

// Last commit time in ms, or null when the path has no history of its own
// (untracked, newly added, or not a git repo).
function lastCommitMs(root, rel) {
  let out = '';
  try {
    out = execFileSync('git', ['-C', root, 'log', '-1', '--format=%ct', '--', rel], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: gitEnv(),
    }).trim();
  } catch {
    // Not a git repo, or git is unavailable: null is the caller's signal to
    // measure both sides on mtime instead, not a swallowed failure.
    return null;
  }
  if (out === '') return null;
  return Number(out) * 1000;
}

// The most recent commit touching any of `dirs`, as { ms, name }, or null when
// none of them has commit history. ONE `git log` for the whole set rather than
// one per file: Swishh carries 257 migrations and this runs in the pre-push
// gate, where a subprocess per migration cost 5 seconds.
//
// `excluded` holds paths to leave out of the walk, passed as `:(exclude)`
// pathspecs so git skips them while choosing the commit — not filtered out
// afterwards, which would report a commit's timestamp under a file that was
// meant to be ignored. With every candidate excluded git prints nothing and
// this returns null, so the caller must know whether it supplied exclusions
// before reading null as "no history".
//
// When that commit is a MERGE, `--name-only` prints no filenames, so this
// returns null and the caller measures both sides on mtime — the behaviour this
// rule had before commit times were introduced. A merge is a transient HEAD
// state and the next non-merge commit restores commit-time comparison.
function newestCommitAcross(root, dirs, excluded = []) {
  let out = '';
  try {
    out = execFileSync(
      'git',
      [
        '-C', root, 'log', '-1', '--format=%ct', '--name-only', '--',
        ...dirs, ...excluded.map((rel) => `:(exclude)${rel}`),
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: gitEnv() },
    );
  } catch {
    // Not a git repo, or git is unavailable: null is the caller's signal to
    // measure both sides on mtime instead, not a swallowed failure.
    return null;
  }
  const lines = out.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  if (lines.length < 2) return null;
  const changed = lines.slice(1).find((line) => line.endsWith('.sql'));
  if (changed === undefined) return null;
  return { ms: Number(lines[0]) * 1000, name: changed };
}

// The opt-out a migration declares about ITSELF, on its own SQL comment line:
//
//     -- fleet-guards: unapplied
//
// Read the rationale at checkMigrationTypeDrift. Kept as a plain literal so
// `grep -rn 'fleet-guards: unapplied' supabase/migrations` finds every
// exemption in a repo without knowing this checker exists.
const UNAPPLIED_MARKER_TEXT = '-- fleet-guards: unapplied';
const UNAPPLIED_MARKER = /^[ \t]*--[ \t]*fleet-guards:[ \t]*unapplied\b/m;

// The marker belongs in the migration's HEADER, and bounding the search to the
// first 4 KB is what makes scanning 2,575 migrations (Sentigen's count on
// 2026-08-06, measured at 243ms) cost one short read each instead of a full
// file read. It also keeps the declaration where a human reviewing the
// migration will see it.
const MARKER_SCAN_BYTES = 4096;

function marksUnapplied(head) {
  return UNAPPLIED_MARKER.test(head);
}

// First `bytes` bytes of a file as text, or '' when it cannot be read. An
// unreadable migration is treated as UNMARKED by every caller: the default is
// strict, and a marker nobody can read is not a marker.
function headBytes(full, bytes) {
  let fd = null;
  try {
    fd = openSync(full, 'r');
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

// Every migration in the working tree whose header carries the marker, sorted
// for a stable report. This is the WORKING-TREE view; the commit path below
// re-checks each one at HEAD before honouring it.
function markedUnappliedInTree(root, dirs) {
  const marked = [];
  for (const dir of dirs) {
    for (const entry of readdirSync(join(root, dir))) {
      if (!entry.endsWith('.sql')) continue;
      const rel = join(dir, entry);
      if (marksUnapplied(headBytes(join(root, rel), MARKER_SCAN_BYTES))) marked.push(rel);
    }
  }
  return marked.sort();
}

// Repo-level (non-line) rule: generated DB types must not lag migrations.
// Lesson: "Schema-Type Synchronization" — after applying any migration,
// regenerate types immediately or the app layer drifts into runtime mismatches.
//
// Two defects made this rule cry wolf in Swishh from 2026-07-28 to 2026-07-30,
// both fixed here:
//
//  1. It watched whichever candidate path existed FIRST. In both adopters that
//     path holds a short re-export stub kept so old import sites need not move,
//     and a stub's timestamp never changes when types are regenerated — so the
//     rule was pinned to a file that can never be up to date. It now skips any
//     candidate that does not define `Database`.
//  2. It compared filesystem mtimes. A fresh clone or `git worktree add` stamps
//     every file with checkout time, so which of two files looks "newer" is
//     decided by checkout ordering, not by history — this fired a "0d newer"
//     finding in a worktree seconds after the types were regenerated. Commit
//     time answers what the rule actually asks (were types regenerated after
//     this migration landed) and is identical in every checkout.
//
// Preferring commit time narrows the rule to COMMITTED state: a migration that
// is written but not yet committed is invisible to it, where the old mtime
// comparison would have caught it mid-edit. That is the right trade for a
// pre-push gate — by push time the migration is committed, and the case that
// matters (migration and regenerated types in the SAME commit) compares equal
// and correctly passes. An uncommitted migration is still caught, one commit
// later, before it can reach a remote.
//
// Candidates are ordered canonical-generated-output first, then the historical
// single-file layouts that later adopters turned into stubs. With the stub
// filter above the order is no longer load-bearing, but it keeps the choice
// deterministic in a repo that carries more than one generated copy.
//
// UNAPPLIED MIGRATIONS (2026-08-06)
//
// The rule as written assumes a migration is applied before it is pushed. In
// Sentigen that is deliberately false: migrations are applied one at a time as
// a human decision (`supabase migration up` is documented there as refusing),
// so a branch routinely carries a migration that is written and intentionally
// not yet applied. Types are generated FROM the live database, so that
// migration's tables cannot appear in them, and the two rules cannot both be
// satisfied. On 2026-08-06 this blocked two correct branches, and a third
// passed only because an agent's UNCOMMITTED regenerated types file happened to
// be sitting in the working tree. An agent that cannot push a migration-bearing
// branch cannot ship one either.
//
// The migration may now declare its own state, on its own SQL comment line
// within the first MARKER_SCAN_BYTES bytes:
//
//     -- fleet-guards: unapplied
//
// A marked migration is excluded from "the newest migration", and the rule then
// judges the newest migration that carries no marker. Applying the migration
// means deleting that line, which restores full enforcement — the marker and
// the schema state it claims go stale together.
//
// Three properties are deliberate:
//
//   OPT-IN PER FILE. An UNMARKED migration newer than the types fails exactly
//   as before. There is no directory-wide or repo-wide exemption, and no flag.
//
//   NEVER SILENT. Every marker is reported by name on every run, through
//   `notes`, whether or not it changed the outcome. A silently-skipped check is
//   the failure mode this whole checker exists to fight; a repo must not be able
//   to accumulate exemptions quietly.
//
//   MEASURED ON THE SAME SIDE AS THE CLOCK. On the commit path the marker is
//   read from the blob at HEAD, not from the working tree, exactly as the
//   timestamps are. An uncommitted marker must not suppress committed drift —
//   that is the "uncommitted file made the gate green" failure above, and
//   honouring it here would rebuild it. Such a marker is reported as NOT
//   honoured rather than ignored. On the mtime path the working tree is the
//   only clock there is, so the working-tree marker is the consistent one.
function checkMigrationTypeDrift(root, notes = []) {
  const migrationDirs = ['supabase/migrations', 'migrations', 'db/migrations'];
  const typeCandidates = [
    'src/lib/supabase/types.generated.ts', 'lib/supabase/types.generated.ts',
    'src/lib/supabase/database.types.ts', 'lib/supabase/database.types.ts',
    'src/types/database.types.ts', 'types/database.types.ts',
    'src/lib/database.types.ts', 'lib/database.types.ts',
    'packages/database/src/types.ts', 'src/types/supabase.ts',
  ];

  const typesRel = typeCandidates.find((candidate) => {
    const full = join(root, candidate);
    return existsSync(full) && definesDatabaseType(full);
  });
  if (typesRel === undefined) return [];

  const presentDirs = migrationDirs.filter((dir) => existsSync(join(root, dir)));
  if (presentDirs.length === 0) return [];

  const markedInTree = markedUnappliedInTree(root, presentDirs);

  // One clock for both sides. Commit history is preferred; if either side lacks
  // it — a migration added but not yet committed, or no git at all — BOTH fall
  // back to mtime, so the two are never measured against different clocks.
  const typesCommit = lastCommitMs(root, typesRel);
  // Probing with no exclusions first answers "can git tell us anything here?"
  // separately from "did the exclusions empty the set?", which both otherwise
  // arrive as null. Only the first question decides which clock is used.
  const anyCommit = newestCommitAcross(root, presentDirs);
  const useCommitTimes = anyCommit !== null && typesCommit !== null;

  // Which markers count. On the commit path a marker is honoured only when the
  // committed file carries it; a marker that exists only in the working tree is
  // named as unhonoured rather than dropped, because a marker that appears to
  // work locally and not on the branch everyone else sees is worse than no
  // marker at all.
  const HONOURED_NOTE = 'marked unapplied; excluded from the newest-migration comparison';
  const honoured = [];
  if (markedInTree.length > 0 && useCommitTimes) {
    const blobs = readBlobsAt(root, 'HEAD', markedInTree);
    for (const rel of markedInTree) {
      // A batch that could not be parsed is reported as exactly that. Saying
      // "not at HEAD" there would send someone to commit a line they already
      // committed, and the whole point of announcing a skip is that the next
      // person can act on it.
      if (blobs === null) {
        notes.push({
          rule: 'migration-type-drift',
          file: rel,
          message: 'marked unapplied, but the committed file could not be read, so the marker is not honoured',
        });
        continue;
      }
      const blob = blobs.get(rel);
      const committed = blob === null || blob === undefined
        ? false
        : marksUnapplied(blob.subarray(0, MARKER_SCAN_BYTES).toString('utf8'));
      if (committed) honoured.push(rel);
      notes.push({
        rule: 'migration-type-drift',
        file: rel,
        message: committed
          ? HONOURED_NOTE
          : `marked unapplied in the working tree but NOT at HEAD, so the marker is not honoured — commit the \`${UNAPPLIED_MARKER_TEXT}\` line`,
      });
    }
  } else {
    for (const rel of markedInTree) {
      honoured.push(rel);
      notes.push({ rule: 'migration-type-drift', file: rel, message: HONOURED_NOTE });
    }
  }

  let newestMigration = null;
  let typesTime = 0;
  if (useCommitTimes) {
    newestMigration = honoured.length === 0
      ? anyCommit
      : newestCommitAcross(root, presentDirs, honoured);
    // git answered before the exclusions and not after them: every migration
    // with history is marked unapplied, so there is no applied schema for the
    // types to lag behind. The markers are already in `notes`.
    if (newestMigration === null) return [];
    typesTime = typesCommit;
  } else {
    const skip = new Set(honoured);
    for (const dir of presentDirs) {
      for (const entry of readdirSync(join(root, dir))) {
        if (!entry.endsWith('.sql')) continue;
        const rel = join(dir, entry);
        if (skip.has(rel)) continue;
        const ms = statSync(join(root, rel)).mtimeMs;
        if (newestMigration === null || ms > newestMigration.ms) {
          newestMigration = { ms, name: rel };
        }
      }
    }
    if (newestMigration === null) return [];
    typesTime = statSync(join(root, typesRel)).mtimeMs;
  }
  if (typesTime >= newestMigration.ms) return [];

  const days = Math.floor((newestMigration.ms - typesTime) / 86400000);
  return [{
    rule: 'migration-type-drift',
    file: typesRel,
    line: 0,
    text: `${basename(newestMigration.name)} is ${days}d newer than generated types`,
    message: `generated DB types are older than the newest applied migration; regenerate them, or mark the migration \`${UNAPPLIED_MARKER_TEXT}\` if it has not been applied yet`,
    // The two files whose relationship IS the finding. In branch mode this is
    // what decides whether the branch owns it, and the pairing is exactly right
    // here: the migration named is by definition the newest UNMARKED one, so a
    // branch that did not touch it did not cause the drift, and a branch that
    // added it must regenerate the types (or declare it unapplied) before
    // pushing.
    inputs: [typesRel, newestMigration.name],
  }];
}

// Which manager owns which lockfile. Mirrors harness.mjs's LOCKFILES table and
// is repeated here on purpose: this checker is vendored standalone into repos
// that do not carry harness.mjs, so it cannot import from it.
const LOCKFILE_OWNERS = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['package-lock.json', 'npm'],
];

// The commands that RESOLVE A DEPENDENCY TREE, per manager. Script-running is
// deliberately absent: `npm run build`, `npm test` and `npx` say nothing about
// which resolver installed node_modules, and flagging them would fire on most
// pnpm repos in the fleet (`npx` is how every ecosystem invokes a one-off
// binary). `pnpm i` and `npm i` are the real short forms and are included.
//
// The leading `(?<![\w-])` is load-bearing: without it `pnpm install` contains
// the substring `npm install`, so a correctly-configured pnpm repo would flag
// itself on every install line.
const INSTALL_COMMANDS = [
  ['npm', /(?<![\w-])npm\s+(?:ci|install|i)(?![\w-])/],
  ['pnpm', /(?<![\w-])pnpm\s+(?:install|i)(?![\w-])/],
  ['yarn', /(?<![\w-])yarn\s+install(?![\w-])/],
  ['bun', /(?<![\w-])bun\s+install(?![\w-])/],
];

// Installing a package manager is not installing a dependency tree. Parlor
// bootstraps its toolchain by fetching pinned npm and pnpm tarballs, checking
// their sha256, and running `npm install --global --ignore-scripts` on each —
// so the line that installs PNPM ITSELF is an `npm install`. That is textbook
// practice, and flagging it would have handed Parlor six findings it must not
// act on.
const GLOBAL_INSTALL = /(?:^|\s)(?:--global|-g)(?:\s|$)/;

// An install explicitly scoped into a subdirectory answers to THAT directory's
// lockfile, not the root declaration — the shell half of the sub-app exclusion
// below. Dibs runs `( cd web && npm ci )` against a tracked `web/package-lock.json`.
const SUBDIR_SHELL = /(?:^|[\s(;])cd\s+[^\s;&|]+\s+&&/;

// Quoted text is prose, not a command. Dibs' `.localci.sh` prints
// `echo "==> web/node_modules missing — running npm ci"` before doing the work,
// and a rule that reads an echo as an invocation reports the log line beside
// the real one. A manager's verb is never inside quotes.
function executablePart(line) {
  return line.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
}

// A directory that is not the repo root. `.` and `./` are how a step opts BACK
// OUT of an inherited scope, so they mean root, not sub-app.
//
// An unresolved expression (`${{ matrix.directory }}`) counts as a subdirectory.
// Its value is not knowable without running the workflow, and the two ways to be
// wrong are not symmetric: treating it as root guarantees a false finding on
// every matrix build in the fleet, while treating it as a subdirectory can only
// ever miss a defect that some other repo's literal path would still catch.
function isSubdirectory(value) {
  return value !== '.' && value !== './';
}

// The YAML half of the sub-app exclusion. Parlor's backend-ci.yml installs its
// RA·NUE contract graph with `run: npm ci` under `working-directory: sites/ranue`,
// which carries its own tracked `package-lock.json` and is not a workspace member.
//
// Scoping is read by walking back to the step header rather than by parsing the
// document: a step's keys sit between its `- name:` and the next list item, so
// finding `working-directory:` before a new item means the command belongs to it.
// Returns null when the step says nothing, which is different from a step that
// explicitly says `.` — the first inherits the job default below, the second
// deliberately overrides it.
function stepWorkingDirectory(lines, index) {
  if (/^\s*-\s/.test(lines[index])) return null;
  for (let k = index - 1; k >= 0 && k > index - 15; k -= 1) {
    const scoped = /^\s*working-directory:\s*['"]?([^'"\s]+)/.exec(lines[k]);
    if (scoped !== null) return scoped[1];
    if (/^\s*-\s/.test(lines[k])) return null;
  }
  return null;
}

// A job may scope EVERY step at once with `defaults: run: working-directory:`,
// and a step-level walk cannot see it.
//
// Parlor, found while probing this rule before shipping it. Its
// validate-premium-workers.yml is a matrix over `sites/*`, each with its own
// tracked `package-lock.json`, scoped once at the job with
// `working-directory: ${{ matrix.directory }}`. Its `run: npm ci` therefore
// carries no key of its own, and the step-level walk alone reported it — one
// wrong finding, in the exact shape this rule exists to excuse. The tell was in
// the file: the step above it sets `working-directory: .` explicitly, which is
// only meaningful if there is an inherited scope to override.
//
// Job config is bounded without parsing the document: it is the region between
// the job key and its `steps:`, so a `working-directory:` indented deeper than
// `steps:` and above it belongs to this job. Reaching a line indented LESS than
// `steps:` means the job key, and the search stops rather than reading the
// previous job's defaults.
function jobDefaultWorkingDirectory(lines, index) {
  let stepsAt = -1;
  let stepsIndent = 0;
  for (let k = index - 1; k >= 0; k -= 1) {
    const header = /^(\s*)steps:\s*$/.exec(lines[k]);
    if (header !== null) {
      stepsAt = k;
      stepsIndent = header[1].length;
      break;
    }
  }
  if (stepsAt === -1) return null;
  for (let k = stepsAt - 1; k >= 0; k -= 1) {
    const line = lines[k];
    if (line.trim() === '') continue;
    const indent = /^(\s*)/.exec(line)[1].length;
    if (indent < stepsIndent) return null;
    const scoped = /^\s*working-directory:\s*['"]?([^'"\s]+)/.exec(line);
    if (scoped !== null) return scoped[1];
  }
  return null;
}

// A step's own scope wins over the job default, which is what makes an explicit
// `working-directory: .` a way back to the root.
function scopedToSubdirectory(lines, index) {
  const step = stepWorkingDirectory(lines, index);
  if (step !== null) return isSubdirectory(step);
  const job = jobDefaultWorkingDirectory(lines, index);
  if (job !== null) return isSubdirectory(job);
  return false;
}

// A `case` arm for a package manager the repo does not declare never executes.
//
// The portable way to write a lockfile gate is to switch on the declared
// manager, which means the script legitimately CONTAINS an `npm ci` it will
// never run:
//
//   case "$PACKAGE_MANAGER" in
//     pnpm) LOCKFILE_CHECK=(pnpm install --frozen-lockfile --lockfile-only) ;;
//     npm)  LOCKFILE_CHECK=(npm ci --dry-run) ;;
//   esac
//
// Reading that line by line reports the dead arm as a live npm install, which
// is what Swishh's correct `.localci.sh` hit on 2026-08-03. The alternatives
// were both worse: delete the arm and the script stops being portable, or
// escape-hatch it in every adopter and the rule erodes by habit.
//
// Deliberately conservative. Only an arm whose every alternative names a
// KNOWN manager other than the declared one is treated as dead; `*)`, a
// non-manager label, or anything we cannot resolve stays reportable, because
// missing a real defect is worse than one annotated false positive.
function scopedToOtherManagerCaseArm(lines, index, declared) {
  const managers = INSTALL_COMMANDS.map(([manager]) => manager);
  for (let i = index - 1; i >= 0; i -= 1) {
    const line = lines[i];
    // Boundaries: past these we are no longer inside a preceding arm body.
    if (/^\s*esac\b/.test(line)) return false;
    if (/\bcase\b[^\n]*\bin\b/.test(line)) return false;
    if (/;;\s*$/.test(line)) return false;
    const label = /^\s*\(?\s*([A-Za-z0-9_|.*-]+?)\s*\)/.exec(line);
    if (label === null) continue;
    const alternatives = label[1].split('|').map((s) => s.trim());
    return (
      alternatives.length > 0 &&
      alternatives.every((alt) => managers.includes(alt) && alt !== declared)
    );
  }
  return false;
}

// The gate files worth reading: the ones that actually install dependencies on
// a fresh clone. Kept to a fixed short list rather than a tree walk, because a
// stray `npm install` in a README is documentation drift, not a broken gate.
//
// `.yaml` workflows are included alongside `.yml` even though the fleet writes
// `.yml`: GitHub honours both, and this file's own history says a check
// narrower than the rule it claims to enforce is worse than none, because it
// reads as proof.
function gateFiles(root) {
  const files = [];
  for (const rel of ['.localci.sh', 'scripts/vercel-build.sh']) {
    if (existsSync(join(root, rel))) files.push(rel);
  }
  let entries = [];
  try {
    entries = readdirSync(join(root, '.github', 'workflows'));
  } catch {
    // No workflows directory. The two shell gates above still stand on their
    // own; this is absence, not a failure to report.
    return files;
  }
  for (const entry of entries) {
    if (entry.endsWith('.yml') || entry.endsWith('.yaml')) {
      files.push(`.github/workflows/${entry}`);
    }
  }
  return files;
}

// Repo-level (non-line) rule: the package manager a repo DECLARES must be the
// one its gates actually run.
//
// Lesson — Swishh, 2026-07-30. package.json pinned `pnpm@9.15.9` next to a
// `pnpm-lock.yaml`, but `.localci.sh` line 37 ran `npm ci --dry-run` and
// CLAUDE.md called npm "the single lockfile authority". npm cannot read a pnpm
// lockfile, so a fresh clone resolved its own tree, installed versions nobody
// had pinned, and produced 10 phantom typecheck errors that did not reproduce
// for anyone with a warm node_modules. The declaration was right, the lockfile
// was right, and the gate disagreed with both — which is precisely the state
// no existing check could see.
//
// harness.mjs's PM-PIN-MISMATCH already compares the pin against the lockfile,
// and would have passed Swishh: pin and lockfile agreed. The gap this closes is
// the THIRD party to that agreement, the commands a gate file runs. The lockfile
// half below is kept anyway because that scorer is advisory and runs only under
// `harness audit`, while this rule runs in the pre-push gate of every adopter.
//
// Root lockfiles ONLY. A sub-app lockfile is usually the deliberate authority
// for a container build with its own install step — Swishh tracks six of them
// (`apps/render-worker/package-lock.json` and five more) beside a pnpm root,
// and every one is correct. Flagging those would bury the one finding that
// matters under six that never will be.
//
// Silent when `packageManager` is absent: adopting that field is a different
// rule's job (harness.mjs's NO-PM-PIN warns about it), and inventing a
// declaration here would mean guessing which manager the repo meant.
function checkPackageManagerDrift(root, tracked) {
  let manifest = null;
  try {
    manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  } catch {
    // Absent, or unparseable. Either way there is no declaration to hold the
    // repo to, and guessing one would be worse than staying quiet.
    return [];
  }
  if (typeof manifest.packageManager !== 'string') return [];
  const pin = manifest.packageManager;
  const parsed = /^([a-z]+)@/.exec(pin);
  if (parsed === null) return [];
  const declared = parsed[1];
  if (!INSTALL_COMMANDS.some(([manager]) => manager === declared)) return [];

  const findings = [];

  for (const rel of gateFiles(root)) {
    let lines = [];
    try {
      lines = readFileSync(join(root, rel), 'utf8').split('\n');
    } catch {
      continue;
    }
    const isYaml = rel.endsWith('.yml') || rel.endsWith('.yaml');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      // A commented-out command does not run. Swishh's `.localci.sh` documents
      // its own steps in a `#` header block that names `npm ci --dry-run`, so
      // without this the rule would report the prose beside the real defect.
      if (/^\s*#/.test(line)) continue;
      const command = executablePart(line);
      if (GLOBAL_INSTALL.test(command)) continue;
      if (SUBDIR_SHELL.test(command)) continue;
      if (isYaml && scopedToSubdirectory(lines, i)) continue;
      if (!isYaml && scopedToOtherManagerCaseArm(lines, i, declared)) continue;
      for (const [manager, pattern] of INSTALL_COMMANDS) {
        if (manager === declared) continue;
        if (!pattern.test(command)) continue;
        if (hasEscapeHatch(lines, i, 'package-manager-drift')) continue;
        findings.push({
          rule: 'package-manager-drift',
          file: rel,
          line: i + 1,
          text: `declares ${declared}, runs ${manager}: ${line.trim().slice(0, 100)}`,
          message: `gate file installs with ${manager} but package.json declares ${pin}; a fresh clone ignores the lockfile and resolves its own versions`,
          inputs: [rel, 'package.json'],
        });
      }
    }
  }

  for (const [file, owner] of LOCKFILE_OWNERS) {
    if (owner === declared) continue;
    // Only git can make a lockfile authoritative for anyone else. When there is
    // no git to ask, fall back to the filesystem rather than passing silently —
    // the same choice trackedFiles() documents for literal-credential.
    const present = tracked !== null ? tracked.has(file) : existsSync(join(root, file));
    if (!present) continue;
    findings.push({
      rule: 'package-manager-drift',
      file,
      line: 0,
      text: `declares ${declared}, tracks ${file} at the repo root`,
      message: `root lockfile belongs to ${owner} but package.json declares ${pin}; delete it or change the declaration`,
      inputs: [file, 'package.json'],
    });
  }

  return findings;
}

// Lesson — stack, 2026-08-05. @braintied/blog carried 69 files copied out of
// @braintied/blog-admin, 64 of them byte-identical, and nothing in either repo
// recorded the relationship. The copy itself was defensible; its invisibility
// was not, because "which of these two trees is authoritative" decayed into
// archaeology within a week. Classifying all 73 stack packages surfaced the
// structural reason it happened: 73 packages with ~15 internal edges is a pile
// of leaves, so when one package needed another's code, copying was the path of
// least resistance in a system with no norm for depending.
//
// This rule enforces the dependency half of @braintied/layers. The tier
// vocabulary and the law below are a DELIBERATE copy of that package: a
// vendored guard is a standalone .mjs with no dependency resolution, so it
// cannot import the thing it enforces. @braintied/layers is the source of
// truth; if the law changes there, it changes here. The table is four lines
// precisely so that stays cheap.
//
// The load-bearing edge is `surface -> engine`. A surface that reaches into an
// engine has to be redeployed whenever that engine's internals move, which is
// the coupling the tiers exist to prevent.
//
// Silent when the depending package declares no `braintied.tier`: adopting the
// field is a migration, not a violation, and inventing a tier here would mean
// guessing what the author meant. Silent too when a dependency's tier cannot be
// resolved — an uninstalled dependency is an unknown, and an unknown must never
// be reported as a violation. Both mirror package-manager-drift's stance on an
// absent `packageManager`.
const LAYER_LAW = {
  contract: ['contract'],
  engine: ['contract', 'engine'],
  surface: ['contract', 'surface'],
  tool: ['contract', 'engine', 'surface', 'tool'],
};

const LAYER_RATIONALE = {
  'surface->engine':
    'a surface that reaches into an engine must be redeployed whenever that engine changes; go through a contract',
  'surface->tool': 'a surface that depends on tooling ships build machinery to production',
  'contract->engine': 'a contract that depends on an engine is no longer implementable by anyone else',
  'contract->surface': 'a contract that depends on a surface makes every implementer inherit one renderer',
  'contract->tool': 'a contract that depends on tooling drags build machinery into every consumer',
  'engine->surface': 'an engine that depends on a surface cannot be driven by a second surface',
  'engine->tool': 'an engine that depends on tooling ships build machinery into the data path',
};

// Manifests this repo owns: the root, plus one level of the usual workspace
// folders. Deliberately not a full tree walk — node_modules holds thousands of
// manifests and this runs in a pre-push gate.
function ownManifests(root) {
  const out = [];
  const push = (rel) => {
    try {
      const json = JSON.parse(readFileSync(join(root, rel), 'utf8'));
      if (typeof json.name === 'string') out.push({ rel, json });
    } catch {
      /* absent or unparseable: nothing to hold the repo to */
    }
  };
  push('package.json');
  for (const folder of ['packages', 'apps', 'services', 'sites']) {
    let entries = [];
    try {
      entries = readdirSync(join(root, folder), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      push(`${folder}/${entry.name}/package.json`);
    }
  }
  return out;
}

// A dependency's tier travels in its published package.json, which is exactly
// why @braintied/layers puts the block there rather than in a sidecar: an app
// can check its own layering against what it actually installed.
function resolveTier(root, name, own) {
  const local = own.find((entry) => entry.json.name === name);
  if (local !== undefined) {
    const tier = local.json.braintied?.tier;
    return typeof tier === 'string' ? tier : null;
  }
  try {
    const installed = JSON.parse(
      readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8'),
    );
    const tier = installed.braintied?.tier;
    return typeof tier === 'string' ? tier : null;
  } catch {
    // ci-allow: silent-catch a dependency that is not installed, or whose
    // manifest will not parse, is an UNKNOWN tier — which this rule must treat
    // as "no opinion", never as a violation. Propagating here would turn a
    // pre-push gate red for the ordinary case of a tree that has not been
    // installed yet.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Comments that cite something which does not exist
// ---------------------------------------------------------------------------

// Lesson — Mirror, 2026-08-10. `_shared/gemini.ts` said "the caller enforces a
// ci-allow: comment-cites-missing quoting the Mirror comment this rule exists for
// duration ceiling instead (see MAX_AUDIO_BYTES)". That constant had never
// existed anywhere in that repo. Three separate places each implied something
// else was enforcing a limit and nothing was: the storage bucket allowed
// 200 MB, the recorder's own header claimed sittings run "20 to 45 minutes",
// and a recording too long to transcribe was accepted and then failed forever.
//
// The comment was not merely stale, it was load-bearing in the way that costs
// the most: a reader checking whether a ceiling existed found that sentence and
// stopped looking. A stale comment that names a real symbol is a small problem,
// because the symbol can be read. One that names a symbol nobody ever wrote is
// a false witness.

// Identifiers that are part of the platform rather than the repo. A comment
// citing `process.env` or `Number.MAX_SAFE_INTEGER` is not making a claim about
// code someone here was supposed to have written.
const AMBIENT_IDENTIFIERS = new Set([
  'MAX_SAFE_INTEGER', 'MIN_SAFE_INTEGER', 'MAX_VALUE', 'MIN_VALUE', 'POSITIVE_INFINITY',
  'NEGATIVE_INFINITY', 'EPSILON', 'NODE_ENV', 'NODE_OPTIONS', 'NODE_AUTH_TOKEN',
  'TODO', 'FIXME', 'NOTE', 'XXX', 'HACK', 'WARNING', 'IMPORTANT', 'DEPRECATED',
  'GET', 'PUT', 'POST', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'HTTP', 'HTTPS',
  'JSON', 'HTML', 'CSS', 'SQL', 'URL', 'URI', 'API', 'CLI', 'SDK', 'UUID', 'JWT',
  'RLS', 'CORS', 'MIME', 'UTC', 'ISO', 'RFC', 'AWS', 'GCP', 'CDN', 'DNS', 'TLS',
  'AND', 'OR', 'NOT', 'NULL', 'TRUE', 'FALSE', 'IS', 'IF', 'THEN', 'ELSE',
]);

// A SCREAMING_SNAKE_CASE name of 8+ characters that contains an underscore,
// and which the comment POINTS AT rather than merely mentions.
//
// The pointing is the whole mechanism. What made the founding incident cost a
// week was not that a name was stale, it was that the sentence sent a reader
// somewhere: "the caller enforces a duration ceiling instead (see
// MAX_AUDIO_BYTES)". Anyone checking whether a ceiling existed followed that
// pointer, found nothing, and stopped looking.
//
// Prose that merely names a thing does not do that, and comments are full of
// it: enum values, environment variables belonging to somebody else's tool,
// external API constants, and metasyntactic placeholders. (Those four classes
// are named here without examples on purpose — a backticked example would be a
// pointer, and this rule would flag its own documentation.)
// Measured on Sentigen-App 2026-08-11: matching every mention gave
// 65 findings, most of them that. Requiring a pointer keeps the incident and
// drops the noise, and a noisy guard gets switched off, which is worse than no
// guard because the repo still reads as covered.
const CITED_CONSTANT =
  /(?:\bsee\b|\bvia\b|\bper\b|\bdefined in\b|\benforced by\b|\bset (?:by|in)\b|\bread from\b|\bfrom\b|`)\s*`?\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g;

// A `someFunction()` call form was tried and REMOVED on 2026-08-11, before this
// rule ever shipped. Measured against braintied-harness it produced 7 findings,
// all 7 false: `createClient()`, `cookies()`, `trimEnd()`, `getPassword()` and
// `someFunction()`, every one either a symbol belonging to another codebase
// that a lesson was legitimately describing, or an illustrative name in a
// comment explaining a regex. The SCREAMING_SNAKE form produced zero false
// positives in the same run and is the form the founding incident took.
//
// Prose names other people's functions constantly and names other people's
// CONSTANTS almost never. A guard that fires on the first would be switched
// off inside a day, and a switched-off guard is worse than no guard because
// the repo still reads as covered.

// Where a symbol can legitimately be named without this repo declaring it: a
// link to someone else's docs, or a JSDoc tag pointing at an external symbol.
const EXTERNAL_CITATION = /https?:\/\/|@see\b|@link\b|@external\b|@throws\b/;

// A comment line is identified by the SHAPE OF THE LINE, not by tracking
// delimiter state across the file.
//
// The state-machine version was written first and was wrong in the expensive
// direction. Its block-comment scan treated the `/*` inside a regex literal as
// the start of a comment, so on harness.mjs a single regex swallowed **37% of
// the file**: real declarations disappeared from the identifier index and came
// back as findings that the code plainly contradicted: one constant was
// reported missing while sitting on the line the finding pointed at.
//
// That constant is deliberately not named here. This file is vendored into
// every adopter, so prose in it that points at a symbol belonging to ONE repo
// becomes a finding in all the others — which is how this very paragraph was
// first caught, by its own rule, in Swishh.
//
// A line whose first non-space characters are `//`, `*` or `/*` is a comment in
// every JSDoc and line-comment style this fleet writes, and is NEVER a
// declaration. Nothing can eat code, because the decision never spans lines.
//
// The deliberate cost: a trailing comment after code (`send(); // see FOO_BAR`)
// is not examined. That direction only ever MISSES a finding, and a guard that
// misses is recoverable in a way that a guard crying wolf is not.
const COMMENT_LINE = /^\s*(?:\/\/+|\*+|\/\*+)\s?(.*)$/;
const FENCE_LINE = /^\s*(?:\*\s*)?```/;

function commentBodies(text) {
  const out = [];
  const lines = text.split('\n');
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // A fenced block is example code, not a claim about this repo. Its contents
    // are frequently illustrative names that were never meant to exist.
    if (FENCE_LINE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = COMMENT_LINE.exec(line);
    if (match === null) continue;
    // `*/` alone carries no prose.
    if (match[1].trim() === '' || match[1].trim() === '/') continue;
    out.push({ line: i + 1, body: match[1] });
  }
  return out;
}

/**
 * Every identifier this repo actually declares, imports, or exports.
 *
 * Built from the whole tree in one pass. A per-file rule cannot answer "does
 * this exist anywhere", and answering it wrong in the permissive direction is
 * the only acceptable failure for a rule that gates a push.
 */
// Everything that is not a whole-line comment, joined back together.
//
// This DROPS ONLY LINES, never spans, which is the property that matters: the
// previous regex-based stripper removed 37% of harness.mjs by finding a `/*`
// inside a regex literal, and every declaration it swallowed became a false
// finding. Keeping a trailing comment attached to its code line is harmless
// here — the index only ever grows, and a bigger index means fewer findings.
function codeOnly(text) {
  return text
    .split('\n')
    .filter((line) => !COMMENT_LINE.test(line))
    .join('\n');
}

function declaredIdentifiers(files) {
  const declared = new Set();
  const patterns = [
    // const/let/var/function/class/type/interface/enum NAME
    /\b(?:const|let|var|function|class|type|interface|enum|namespace)\s+([A-Za-z_$][\w$]*)/g,
    // import { A, B as C }, import D, export { E }
    /\b(?:import|export)\s*(?:type\s*)?\{([^}]*)\}/g,
    /\bimport\s+([A-Za-z_$][\w$]*)\s+from\b/g,
    /\bimport\s*\*\s*as\s+([A-Za-z_$][\w$]*)/g,
    // object literal / class member / TS property: NAME: value, NAME = value
    /^\s*(?:readonly\s+|static\s+|public\s+|private\s+|protected\s+)*([A-Za-z_$][\w$]*)\s*[:=]/gm,
    // destructuring: const { A, B } = ...
    /(?:const|let|var)\s*\{([^}]*)\}\s*=/g,
    // shell and env assignment, since .sh files are in scope elsewhere
    /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)=/gm,
  ];

  for (const { text: raw } of files) {
    // Comment lines are dropped before indexing, and this is the line the rule
    // lives or dies on. The first version indexed the whole file, so a name
    // cited in a comment INDEXED ITSELF and was then found to exist — the rule
    // could not fire on its own founding incident. It reported clean on a probe
    // repo written to reproduce that incident exactly.
    const text = codeOnly(raw);
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        for (const piece of match[1].split(',')) {
          // `A as B` declares B; `A` declares A. Take both, because either
          // spelling appearing in a comment is a real reference.
          for (const name of piece.split(/\s+as\s+/)) {
            const cleaned = name.replace(/[^\w$]/g, '').trim();
            if (cleaned !== '') declared.add(cleaned);
          }
        }
      }
    }
    // Anything used as a property or a bare reference also counts as existing.
    // This is deliberately generous: the rule's job is to catch a name that
    // appears NOWHERE but in prose, not to police where it was defined.
    for (const match of text.matchAll(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g)) {
      declared.add(match[1]);
    }
  }
  return declared;
}

function checkCommentCitesMissing(files) {
  // The identifier index must be built from EVERY file, including the ones no
  // rule would otherwise scan, or a constant declared in a test would read as
  // missing and the rule would invent a finding.
  const declared = declaredIdentifiers(files);
  const findings = [];

  for (const { rel, text } of files) {
    if (!CODE_EXTENSIONS.has(extname(rel))) continue;
    const lines = text.split('\n');

    for (const { line, body } of commentBodies(text)) {
      if (EXTERNAL_CITATION.test(body)) continue;
      if (hasEscapeHatch(lines, line - 1, 'comment-cites-missing')) continue;

      const cited = new Set();
      for (const [, name] of body.matchAll(CITED_CONSTANT)) {
        if (name.length < 8) continue;
        if (AMBIENT_IDENTIFIERS.has(name)) continue;
        cited.add(name);
      }

      for (const name of cited) {
        if (declared.has(name)) continue;
        findings.push({
          rule: 'comment-cites-missing',
          file: rel,
          line,
          text: `comment cites ${name}, which is declared nowhere in this repo`,
          message:
            `comment names ${name} but nothing in the repo declares, imports or uses it; ` +
            'a reader checking whether that thing exists will find this sentence and stop looking',
        });
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// One risk-carrying constant, declared twice
// ---------------------------------------------------------------------------

// Lesson — Mirror, 2026-08-03/09. `generate.ts` and `gemini.ts` each declared
// ci-allow: comment-cites-missing naming another repo's constant in a lesson
// `REQUEST_TIMEOUT_MS = 300_000` against a 150-second Edge Function wall clock,
// so the timeout could never fire and the platform killed the call instead —
// writing nothing and advancing no stage, which is what a silent stall actually
// is. `generate.ts` was fixed on 2026-08-03 and given a careful comment
// explaining the bug. `gemini.ts` kept the broken value for six more days while
// owning the longest external call in the system, and CLAUDE.md recorded the
// lesson as learned the whole time.
//
// Scoped to NUMERIC constants with risk-carrying names on purpose. Two files
// declaring `const DEFAULT_NAME = 'Interviewer'` is ordinary; two files
// declaring a different platform timeout is how a fix reaches one of them.
const RISK_CONSTANT_NAME =
  /^(?:.*_)?(?:TIMEOUT(?:_MS)?|LIMIT|MAX(?:_[A-Z0-9]+)?|BUDGET(?:_[A-Z0-9]+)?|RETRIES|RETRY(?:_[A-Z0-9]+)?|TTL(?:_[A-Z0-9]+)?|WALL_CLOCK(?:_[A-Z0-9]+)?|CEILING|THRESHOLD|INTERVAL(?:_MS)?|DEADLINE(?:_MS)?)$/;

const NUMERIC_CONST_DECL =
  /^\s*(?:export\s+)?(?:const|let)\s+([A-Z][A-Z0-9_]*)\s*(?::\s*number\s*)?=\s*([0-9][0-9_]*(?:\.[0-9]+)?(?:\s*\*\s*[0-9][0-9_]*)*)\s*;?\s*(?:\/\/.*)?$/;

/** The directory a file's constants are "local" to, for grouping. */
function constantScope(rel) {
  const parts = rel.split('/');
  parts.pop();
  return parts.join('/');
}

function checkDuplicateRiskConstant(files) {
  // name -> scope -> [{ rel, line, value }]
  const seen = new Map();

  for (const { rel, text } of files) {
    if (!CODE_EXTENSIONS.has(extname(rel))) continue;
    if (/\.(test|spec)\./.test(rel)) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const match = NUMERIC_CONST_DECL.exec(lines[i]);
      if (match === null) continue;
      const [, name, rawValue] = match;
      if (!RISK_CONSTANT_NAME.test(name)) continue;
      if (hasEscapeHatch(lines, i, 'duplicate-risk-constant')) continue;

      const scope = constantScope(rel);
      let byScope = seen.get(name);
      if (byScope === undefined) {
        byScope = new Map();
        seen.set(name, byScope);
      }
      const list = byScope.get(scope);
      const entry = { rel, line: i + 1, value: rawValue.replace(/[\s_]/g, '') };
      if (list === undefined) byScope.set(scope, [entry]);
      else list.push(entry);
    }
  }

  const findings = [];
  for (const [name, byScope] of seen) {
    for (const [, entries] of byScope) {
      // Two declarations in ONE file is a different (and usually deliberate)
      // thing; this rule is about a fix that can only reach one of them.
      const distinctFiles = [...new Set(entries.map((entry) => entry.rel))];
      if (distinctFiles.length < 2) continue;

      const values = [...new Set(entries.map((entry) => entry.value))];
      // Report against the SECOND file, not the first: the first is usually the
      // one someone already fixed, and the finding belongs where the stale copy
      // lives. Sorting keeps the attribution stable across runs.
      const ordered = [...entries].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
      const target = ordered[ordered.length - 1];
      const others = ordered.slice(0, -1).map((entry) => `${entry.rel}:${entry.line}`);

      findings.push({
        rule: 'duplicate-risk-constant',
        file: target.rel,
        line: target.line,
        text:
          `${name} is declared in ${distinctFiles.length} files in this directory ` +
          `(also ${others.join(', ')})` +
          (values.length > 1 ? `; the values already disagree: ${values.join(' vs ')}` : ''),
        message:
          `${name} carries a limit and is declared in more than one file here; ` +
          (values.length > 1
            ? 'the copies have ALREADY diverged, so a fix landed in one of them'
            : 'a fix to one copy will not reach the other') +
          '. Declare it once and import it',
        inputs: distinctFiles,
      });
    }
  }

  return findings;
}

function checkLayerViolation(root) {
  const own = ownManifests(root);
  const findings = [];

  for (const { rel, json } of own) {
    const fromTier = json.braintied?.tier;
    if (typeof fromTier !== 'string') continue;
    const allowed = LAYER_LAW[fromTier];
    if (allowed === undefined) continue;

    const deps = json.dependencies;
    if (deps === undefined || deps === null || typeof deps !== 'object') continue;

    for (const name of Object.keys(deps)) {
      if (!name.startsWith('@braintied/')) continue;
      const toTier = resolveTier(root, name, own);
      if (toTier === null) continue;
      if (allowed.includes(toTier)) continue;
      const why = LAYER_RATIONALE[`${fromTier}->${toTier}`];
      findings.push({
        rule: 'layer-violation',
        file: rel,
        line: 0,
        text: `${json.name} (${fromTier}) depends on ${name} (${toTier})`,
        message: `${fromTier} may not depend on ${toTier}: ${why === undefined ? 'see @braintied/layers' : why}`,
        inputs: [rel],
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

// Whether a path is in scope at all, decided from the path alone so the tree
// walk and the merge-base blob scan cannot disagree about what counts. A file
// judged by one side and skipped by the other would read as a regression the
// moment a branch touched it.
//
// The extensionless arm takes ANY extensionless file, not an allowlist of known
// ones. It was `.env* | .npmrc | .netrc`, and it missed a tracked file named
// `Untitled` whose entire content was a live OpenAI key -- an empty editor
// buffer that got a pasted secret and then got committed. The guard reported
// that repo clean, and I republished it into a new archive on the strength of
// that. An allowlist can only ever catch the filenames someone thought of.
// Extensionless files are few, and scanText skips anything binary or oversized,
// so the cost of scanning them all is nil.
function isScannablePath(rel) {
  const parts = rel.split('/');
  if (parts.some((p) => SKIP_DIRS.has(p))) return false;
  const name = parts[parts.length - 1];
  const ext = extname(name);
  if (ext === '') return true;
  // Widened from CODE_EXTENSIONS. Each rule still filters by its own
  // `extensions` in scanText, so code-shaped rules see exactly what they saw
  // before; only opt-in rules see the extra file types.
  return CREDENTIAL_SCAN_EXTENSIONS.has(ext) && !/\.(test|spec)\./.test(name);
}

function collectFiles(dir, root, out) {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    const rel = relative(root, full);
    if (SKIP_DIRS.has(entry.name) || rel.split('/').some((p) => SKIP_DIRS.has(p))) continue;
    if (entry.isDirectory()) {
      collectFiles(full, root, out);
    } else if (isScannablePath(rel)) {
      out.push({ full, rel });
    }
  }
  return out;
}

function hasEscapeHatch(lines, index, ruleId) {
  const pattern = new RegExp(`ci-allow:\\s*${ruleId}\\b`);
  if (pattern.test(lines[index])) return true;
  if (index > 0 && pattern.test(lines[index - 1])) return true;
  return false;
}

// A gitignored `.env` is not a leak -- it is the RECOMMENDED place to put a
// secret. Only git can publish a file, so only a tracked file can be exposed,
// which is what the literal-credential message has always claimed ("in a
// tracked file"). The first implementation walked the filesystem and never
// checked, so it flagged Sentigen-App's correctly-stored .env 15 times. A gate
// that fails every push over secrets kept the right way gets switched off in a
// day, and then it protects nothing.
//
// Tracked is also the right boundary for WHEN this runs: git-local-ci fires on
// push, and `git add`ing a settings.local.json makes it tracked, so the leak
// path stays covered.
function trackedFiles(root) {
  try {
    const out = execFileSync('git', ['-C', root, 'ls-files', '-z'], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
      env: gitEnv(),
    });
    return new Set(out.split('\0').filter(Boolean));
  } catch {
    // Not a git repo, or git is unavailable: fall back to scanning everything
    // rather than silently passing.
    return null;
  }
}

// A file this checker could not read. Not a style violation like the rest of
// the manifest: it is the checker declaring the size of its own blind spot, so
// that a clean run means "no violations" rather than "no violations I could
// see". It ratchets like any other rule, because an adopter may legitimately
// track a binary blob and should not be turned red on upgrade -- but it can
// never again be zero when the truth is unknown.
//
// There is deliberately NO `// ci-allow:` path. The escape hatch is a comment
// on the offending line, and a file this rule fires on is one nothing can
// write a readable comment into. The baseline is the only way to accept one.
function unscannable(rel, reason) {
  return {
    rule: 'unscannable-file',
    file: rel,
    line: 0,
    text: reason,
    message:
      `no rule in this checker could read this file (${reason}); every guard, including the credential rule that never ratchets, is blind to its contents. Commit it as text, stop tracking it, or accept it in the baseline knowing it is unscanned`,
  };
}

// The line-rule half of the scanner, over ONE file's text. Split out of
// scanRepo so the merge-base comparison can measure a historical blob through
// the identical pipeline instead of a second, drifting implementation.
//
// `rules` is the subset to run: the branch comparison excludes the alwaysFail
// rules, which are absolute and never diffed against anything.
export function scanText(rel, text, { denyImports, tracked, rules }) {
  const findings = [];
  // The walk reaches binaries and large artefacts now that extensionless files
  // are collected. Skip both: a NUL byte means binary, and nothing above a
  // couple of MB is hand-written source worth line-scanning.
  //
  // SKIPPING IS REPORTED, NOT SILENT (2026-08-03). These two lines used to
  // `return findings` and say nothing, which made this checker its own best
  // example of the proxy-assertion class it now carries rules for: a tracked
  // file holding a NUL byte was invisible to EVERY rule -- including the
  // alwaysFail credential rule -- and the gate printed "ok". The file that
  // proved it was this one. check-fleet-guards.mjs carried two raw NUL bytes
  // as map-key separators, so plain `grep` reported no match for strings it
  // contains eight times, and the scanner could not read itself. A guard that
  // cannot name its own blind spot is indistinguishable from one that has none.
  if (text.length > 2_000_000) return [unscannable(rel, 'larger than the 2 MB line-scan cap')];
  if (text.includes('\0')) return [unscannable(rel, 'contains NUL bytes, so it reads as binary')];
  // Bundled output stays silent. It is machine-written, excluded by name in
  // SKIP_DIRS wherever it has a known home, and reporting it would hand every
  // adopter a baseline full of build artefacts.
  if (looksBundled(text)) return findings;

  const lines = text.split('\n');
  const ctx = { rel, denyImports };
  const ext = extname(rel);
  for (const rule of rules) {
    // A rule sees CODE_EXTENSIONS unless it opts into a wider set. Without
    // this, widening the collector would run line-shaped heuristics over
    // markdown and JSON and bury the real findings in noise.
    const allowed = rule.extensions !== undefined ? rule.extensions : CODE_EXTENSIONS;
    if (!allowed.has(ext) && ext !== '') continue;
    if (ext === '' && rule.extensions === undefined) continue;
    if (rule.trackedOnly === true && tracked !== null && !tracked.has(rel)) continue;
    if (!rule.appliesTo(rel)) continue;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      // Comment lines are skipped for code-shaped rules only. A credential
      // pasted into a comment is still a credential, and the audit found
      // several in exactly that position.
      const isComment = line.trim().startsWith('//') || line.trim().startsWith('*');
      if (isComment && rule.scanComments !== true) continue;
      let hit = false;
      try {
        hit = rule.test(line, i, lines, ctx) === true;
      } catch {
        hit = false;
      }
      if (!hit) continue;
      if (hasEscapeHatch(lines, i, rule.id)) continue;
      findings.push({
        rule: rule.id,
        file: rel,
        line: i + 1,
        text: line.trim().slice(0, 140),
        message: rule.message,
      });
    }
  }
  return findings;
}

export function scanRepo(root, options = {}) {
  const denyImports = options.denyImports !== undefined ? options.denyImports : ABSTRACTION_ONLY_PACKAGES;
  const tracked = trackedFiles(root);
  const findings = [];
  // Kept for the two whole-tree rules below, so the walk and the file reads
  // happen once. Only tracked, in-scope text lands here.
  const corpus = [];
  for (const { full, rel } of collectFiles(root, root, [])) {
    // Only a TRACKED file can be published, and only a published file's
    // contents matter to anyone else -- the same boundary literal-credential
    // draws. A binary blob sitting untracked in a working tree is nobody's
    // problem, and reporting it would fire on every local build artefact that
    // happens to live outside a SKIP_DIRS name.
    const isTracked = tracked === null || tracked.has(rel);
    let text;
    try {
      if (statSync(full).size > 2_000_000) {
        if (isTracked) findings.push(unscannable(rel, 'larger than the 2 MB line-scan cap'));
        continue;
      }
      text = readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    if (isTracked) corpus.push({ rel, text });
    for (const finding of scanText(rel, text, { denyImports, tracked, rules: RULES })) {
      if (finding.rule === 'unscannable-file' && !isTracked) continue;
      findings.push(finding);
    }
  }
  // `notes` collects what a rule DID NOT measure and why. It is not a finding —
  // it never gates and never ratchets — but it is printed on every run, so an
  // exemption cannot buy silence.
  findings.push(...checkMigrationTypeDrift(root, options.notes === undefined ? [] : options.notes));
  // `tracked` is handed over rather than re-derived: `git ls-files` on a repo
  // with substantial tracked content is the expensive call in this checker
  // (it needed a 64 MB buffer to stop hitting ENOBUFS), and this runs in a
  // pre-push gate.
  findings.push(...checkPackageManagerDrift(root, tracked));
  findings.push(...checkLayerViolation(root));
  // Both read the corpus collected above rather than walking again. Untracked
  // files are excluded from it, which matters for comment-cites-missing in the
  // permissive direction only: a name declared in an untracked file is not in
  // the index, so the rule could in principle report it. That is the same
  // boundary literal-credential draws, and the escape hatch covers the case.
  findings.push(...checkCommentCitesMissing(corpus));
  findings.push(...checkDuplicateRiskConstant(corpus));
  return findings;
}

// ---------------------------------------------------------------------------
// Branch comparison — judge what THIS branch changed, not what the tree holds
// ---------------------------------------------------------------------------

// Every git call in this section returns null on failure rather than throwing,
// because every one of them has a legitimate way to be absent: no .git under a
// Vercel build, no origin ref in a fresh clone, no common ancestor in a shallow
// one. A null anywhere in the chain drops the whole run back to the whole-tree
// comparison, which is the behaviour this file had before branch mode existed.
function gitOut(root, args) {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'], env: gitEnv(),
    });
  // ci-allow: silent-catch deliberate null-return contract; every caller branches on null
  } catch {
    return null;
  }
}

function resolves(root, ref) {
  const out = gitOut(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return out !== null && out.trim() !== '';
}

// REMOTE refs only, deliberately. A local `main` is not evidence of what the
// branch will be measured against: in a repo with no remote, or on the very
// first push before origin/main exists, `merge-base HEAD main` is HEAD itself,
// so nothing at all would be judged. Returning null there is what sends the run
// back to the whole-tree comparison, which is the stricter answer.
function defaultBranchRef(root, override) {
  if (override !== null) return resolves(root, override) ? override : null;
  const head = gitOut(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  const candidates = [];
  if (head !== null && head.trim() !== '') candidates.push(head.trim());
  candidates.push('origin/main', 'origin/master');
  for (const ref of candidates) {
    if (resolves(root, ref)) return ref;
  }
  return null;
}

// The files this branch changed, as current path -> path at the merge base.
// A rename maps to its OLD path so a pure move is not read as inventing every
// violation the file already carried; an added or untracked file maps to null,
// which counts as zero violations at the base and therefore judges the whole
// file.
//
// The diff has no second commit on purpose: `git diff <base>` compares the base
// against the WORKING TREE, so uncommitted edits are judged too. Untracked
// files are added separately because a diff cannot see them, and one of them
// becoming part of the repo is exactly the case the gate exists for.
function touchedFiles(root, mergeBase) {
  const status = gitOut(root, ['diff', '--name-status', '-M', '-z', mergeBase]);
  if (status === null) return null;
  const fields = status.split('\0').filter((f) => f !== '');
  const touched = new Map();
  let i = 0;
  while (i < fields.length) {
    const code = fields[i];
    if (/^[RC]/.test(code)) {
      const from = fields[i + 1];
      const to = fields[i + 2];
      i += 3;
      if (to !== undefined) touched.set(to, from);
    } else if (code === 'D') {
      // Deleted: nothing to scan now, and a deletion can only lower a count.
      i += 2;
    } else {
      const path = fields[i + 1];
      i += 2;
      if (path !== undefined) touched.set(path, path);
    }
  }
  const others = gitOut(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (others !== null) {
    for (const path of others.split('\0')) {
      if (path !== '') touched.set(path, null);
    }
  }
  return touched;
}

// Read many blobs in ONE git process. A branch touching 200 files would
// otherwise pay 200 spawns inside a pre-push gate.
//
// `git cat-file --batch` answers each request as `<oid> <type> <size>\n<body>\n`
// for a hit and `<name> missing\n` for a miss, in input order. Parsing walks a
// Buffer rather than a string because a size is a BYTE count and a multi-byte
// character would slide every subsequent offset. Anything unexpected returns
// null for the whole batch: a mis-parsed stream would silently mis-attribute
// one file's content to another, and reporting the wrong file is worse than
// falling back.
function readBlobsAt(root, commit, paths) {
  if (paths.length === 0) return new Map();
  // The batch protocol is newline-delimited, so a filename containing one would
  // desynchronise every request after it. Give up on the whole batch and let the
  // caller fall back rather than answer about the wrong files.
  if (paths.some((p) => p.includes('\n'))) return null;
  const input = `${paths.map((p) => `${commit}:${p}`).join('\n')}\n`;
  let out;
  try {
    out = execFileSync('git', ['-C', root, 'cat-file', '--batch'], {
      input, maxBuffer: 256 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'ignore'], env: gitEnv(),
    });
  // ci-allow: silent-catch deliberate null-return contract; every caller branches on null
  } catch {
    return null;
  }
  const blobs = new Map();
  let offset = 0;
  for (const path of paths) {
    const newline = out.indexOf(0x0a, offset);
    if (newline === -1) return null;
    const header = out.toString('utf8', offset, newline);
    offset = newline + 1;
    const parts = header.split(' ');
    // `<name> missing` and `<name> ambiguous` are two fields; a hit is three.
    if (parts.length < 3 || parts[1] !== 'blob') {
      blobs.set(path, null);
      continue;
    }
    const size = Number.parseInt(parts[2], 10);
    if (!Number.isInteger(size) || size < 0) return null;
    blobs.set(path, out.subarray(offset, offset + size));
    offset += size + 1;
  }
  return blobs;
}

// Everything the branch verdict needs, or null when git cannot supply it.
export function branchContext(root, { base } = { base: null }) {
  const override = base === undefined ? null : base;
  if (gitOut(root, ['rev-parse', '--git-dir']) === null) return null;
  if (!resolves(root, 'HEAD')) return null;
  const ref = defaultBranchRef(root, override);
  if (ref === null) return null;
  const merged = gitOut(root, ['merge-base', 'HEAD', ref]);
  // Unrelated histories, or a shallow clone deep enough to hide the fork point.
  if (merged === null || merged.trim() === '') return null;
  const mergeBase = merged.trim();
  const touched = touchedFiles(root, mergeBase);
  if (touched === null) return null;
  return { ref, mergeBase, touched };
}

// The repo-level rules produce findings about a RELATIONSHIP between files
// rather than a line, so they cannot be diffed per file. They are attributed by
// their `inputs` instead: the branch owns the finding when it touched one of
// the files whose relationship is broken.
const REPO_LEVEL_RULES = new Set([
  'migration-type-drift',
  'package-manager-drift',
  'layer-violation',
  // Both need the whole tree: one asks whether a cited name exists ANYWHERE,
  // the other compares declarations ACROSS files. Neither question can be
  // answered from the single file a per-file rule is handed.
  'comment-cites-missing',
  'duplicate-risk-constant',
]);

function countByFileAndRule(findings) {
  const counts = new Map();
  for (const finding of findings) {
    if (REPO_LEVEL_RULES.has(finding.rule)) continue;
    const key = `${finding.file}\0${finding.rule}`;
    const current = counts.get(key);
    counts.set(key, current === undefined ? 1 : current + 1);
  }
  return counts;
}

/**
 * Which rules this branch made worse, per file, measured against the merge base.
 *
 * Returns { regressions, scanned } or null when the base side could not be read
 * — null means "cannot judge the branch", and the caller falls back rather than
 * passing on missing evidence.
 *
 * alwaysFail rules are excluded: they never ratchet against anything, and are
 * gated in full before this runs.
 */
export function branchRegressions(root, ctx, findings, options = {}) {
  const denyImports = options.denyImports !== undefined ? options.denyImports : ABSTRACTION_ONLY_PACKAGES;
  const rules = RULES.filter((rule) => rule.alwaysFail !== true);
  // `unscannable-file` is produced by the scanner itself rather than by a
  // manifest entry, so it is not in RULES and the per-file loop below would
  // never compare it. Naming it here is what makes a branch that ADDS a NUL
  // byte to a readable file fail -- which is the whole point, since that
  // branch has just hidden the file from every other rule.
  const comparedIds = [...rules.map((rule) => rule.id), 'unscannable-file'];

  const pairs = [...ctx.touched.entries()].filter(([rel]) => isScannablePath(rel));
  const basePaths = [...new Set(pairs.map(([, base]) => base).filter((base) => base !== null))];
  const blobs = readBlobsAt(root, ctx.mergeBase, basePaths);
  if (blobs === null) return null;

  const now = countByFileAndRule(findings);
  const regressions = [];
  for (const [rel, base] of pairs) {
    // A file present at the base is measured under the name it had THEN:
    // `appliesTo` reads the path, so scanning an old blob under its new name
    // would answer a question about a file that never existed.
    const wasCounts = new Map();
    if (base !== null) {
      const blob = blobs.get(base);
      if (blob !== undefined && blob !== null && isScannablePath(base)) {
        if (blob.length > 2_000_000) {
          // The base was ALREADY unscannable. Skipping it here would leave
          // `was` at 0 while the working tree reports 1, so merely touching a
          // file that has been oversized for months reads as a fresh
          // regression. Record the state it was actually in, so this rule
          // still fires for a branch that MAKES a file unscannable (which is
          // what naming it in comparedIds is for) and stays quiet for one that
          // inherits an oversized file.
          wasCounts.set('unscannable-file', 1);
        } else {
          const baseFindings = scanText(base, blob.toString('utf8'), { denyImports, tracked: null, rules });
          for (const finding of baseFindings) {
            const current = wasCounts.get(finding.rule);
            wasCounts.set(finding.rule, current === undefined ? 1 : current + 1);
          }
        }
      }
    }
    for (const ruleId of comparedIds) {
      const nowCount = now.get(`${rel}\0${ruleId}`);
      const nowValue = nowCount === undefined ? 0 : nowCount;
      const wasCount = wasCounts.get(ruleId);
      const wasValue = wasCount === undefined ? 0 : wasCount;
      if (nowValue > wasValue) {
        regressions.push({ file: rel, rule: ruleId, was: wasValue, now: nowValue });
      }
    }
  }

  for (const finding of findings) {
    if (!REPO_LEVEL_RULES.has(finding.rule)) continue;
    const inputs = finding.inputs === undefined ? [finding.file] : finding.inputs;
    const owned = inputs.filter((path) => ctx.touched.has(path));
    if (owned.length === 0) continue;
    // `was`/`now` are deliberately absent: this rule has no per-file count to
    // compare, and rendering it as "0 -> 1" would claim the branch created a
    // finding that may well predate it. What the branch did is touch an input.
    regressions.push({ file: finding.file, rule: finding.rule, touchedInput: owned[0] });
  }

  return { regressions, scanned: pairs.length };
}

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

// Two shapes, because an adopter's committed file must keep working across this
// upgrade: a bare integer (the total, with no per-rule detail) and a JSON object
// carrying per-rule buckets. `buckets: null` is the honest representation of
// "this baseline cannot tell you which rule the debt belongs to", and every
// caller has to decide what to do about that rather than reading a zero.
class UnreadableBaseline extends Error {
  constructor(reason) {
    super(`${BASELINE_FILE} is unreadable: ${reason}`);
    this.name = 'UnreadableBaseline';
  }
}

function readBaseline(root) {
  const full = join(root, BASELINE_FILE);
  if (!existsSync(full)) return null;
  const text = readFileSync(full, 'utf8').trim();
  if (/^\d+$/.test(text)) return { count: Number.parseInt(text, 10), buckets: null };
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Treating it as "no baseline" would rewrite it with today's count on the
    // first-baseline path and silently absorb everything it was pinning.
    throw new UnreadableBaseline('neither an integer nor JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new UnreadableBaseline('JSON is not an object');
  }
  if (parsed.buckets === null || typeof parsed.buckets !== 'object' || Array.isArray(parsed.buckets)) {
    throw new UnreadableBaseline('no "buckets" object');
  }
  const buckets = {};
  for (const [rule, value] of Object.entries(parsed.buckets)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new UnreadableBaseline(`bucket "${rule}" is not a non-negative integer`);
    }
    buckets[rule] = value;
  }
  const total = Number.isInteger(parsed.count)
    ? parsed.count
    : Object.values(buckets).reduce((sum, n) => sum + n, 0);
  return { count: total, buckets };
}

// A baseline bucket naming a rule this checker does not implement is ALWAYS a
// bug, and always a silent one: the pin survives, the gate does not. Nothing
// else in this file can notice, because every comparison iterates the rules
// that exist and a vanished rule simply never appears.
//
// The way it happens is re-vendoring. An adopter adds a local rule, then later
// copies a newer checker over the top; the local rule is gone and its baseline
// entry remains, still claiming N sites are watched. Measured 2026-08-11 on
// swishh: `unscoped-model-call` was added (baseline 141) and overwritten by a
// fleet-guards adoption 20 minutes later. The checker reported `ok`, exit 0,
// with an orphan pin sitting in the file — the gate had been dead since the
// adoption and nothing said so.
//
// Refusing here converts that into a loud failure at the next run. The fix is
// to restore the rule or drop the pin deliberately, and both are decisions
// someone should make on purpose.
function unknownBaselineRules(baseline) {
  if (baseline === null || baseline.buckets === null) return [];
  const known = new Set([...RULES.map((rule) => rule.id), ...REPO_LEVEL_RULES, 'unscannable-file']);
  return Object.keys(baseline.buckets).filter((id) => !known.has(id));
}

function bucketize(findings) {
  const buckets = {};
  for (const finding of findings) {
    const current = buckets[finding.rule];
    buckets[finding.rule] = current === undefined ? 1 : current + 1;
  }
  return buckets;
}

// Always written with buckets. An adopter converts the moment it can tighten,
// which is the only moment a rewrite is allowed to change the number.
function writeBaseline(root, findings) {
  const buckets = bucketize(findings);
  const ordered = {};
  for (const rule of Object.keys(buckets).sort()) ordered[rule] = buckets[rule];
  const body = { count: findings.length, buckets: ordered };
  writeFileSync(join(root, BASELINE_FILE), `${JSON.stringify(body, null, 2)}\n`);
}

// Which rules rose against the baseline, whole-tree.
//
// Per-rule is deliberately STRICTER than the total: a rule that rises is a
// regression even when the total falls, so a cleanup in one rule can no longer
// pay for new debt in another. Against a bare-integer baseline there is no
// per-rule history to compare, so only the total can be judged.
function risenRules(buckets, baseline) {
  if (baseline.buckets === null) return null;
  const risen = [];
  for (const [rule, count] of Object.entries(buckets)) {
    const was = baseline.buckets[rule];
    const wasValue = was === undefined ? 0 : was;
    if (count > wasValue) risen.push({ rule, was: wasValue, now: count });
  }
  return risen;
}

// An unscannable file is the one finding that must be said out loud on a
// PASSING run, and the only one printed beside "ok".
//
// Every other rule describes code that is present and wrong, and a baseline is
// an honest way to owe that debt. This one describes a file whose contents
// nobody has read, so absorbing it into a baseline quietly converts "we have
// not looked" into "we looked and it was fine" -- and the rule that would have
// caught a credential in there is the one rule that never ratchets, precisely
// so a live secret cannot be amortised away. Baselining is still allowed (14
// such files already exist across three repos, and turning every adopter red on
// upgrade is how a gate gets deleted), but it is never silent.
function announceUnscannable(findings) {
  const blind = findings.filter((f) => f.rule === 'unscannable-file');
  if (blind.length === 0) return;
  process.stdout.write(
    `\ncheck-fleet-guards: ${blind.length} tracked file(s) could NOT be read, so no rule ran on them:\n`
  );
  for (const f of blind.slice(0, 20)) process.stdout.write(`  ${f.file} — ${f.text}\n`);
  if (blind.length > 20) process.stdout.write(`  ...and ${blind.length - 20} more\n`);
  process.stdout.write('A credential inside one of these is invisible to the rule that never ratchets.\n');
}

// The other thing that must be said out loud on a PASSING run: a check that a
// file asked to be left out of.
//
// `-- fleet-guards: unapplied` is opt-in per migration and legitimate — types
// are generated from the live database, so an unapplied migration cannot be in
// them — but an exemption nobody reads is how a repo drifts into having no
// enforcement while its gate stays green. Printed whether or not it changed the
// outcome, so `grep 'fleet-guards: unapplied'` is a confirmation rather than a
// discovery.
function announceUnappliedMigrations(notes) {
  const marked = notes.filter((n) => n.rule === 'migration-type-drift');
  if (marked.length === 0) return;
  process.stdout.write(
    `\ncheck-fleet-guards: ${marked.length} migration(s) declare \`${UNAPPLIED_MARKER_TEXT}\`:\n`
  );
  for (const n of marked.slice(0, 20)) process.stdout.write(`  ${n.file} — ${n.message}\n`);
  if (marked.length > 20) process.stdout.write(`  ...and ${marked.length - 20} more\n`);
  process.stdout.write('Delete that line when the migration is applied; migration-type-drift enforces it again.\n');
}

// `--base=<ref>` rather than `--base <ref>`: the positional argument is the repo
// root, and a two-token flag would put the ref there on every parse that missed
// the pairing.
function flagValue(argv, name) {
  const prefix = `${name}=`;
  const hit = argv.find((a) => a.startsWith(prefix));
  return hit === undefined ? null : hit.slice(prefix.length);
}

function main(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const positional = argv.filter((a) => !a.startsWith('--'));
  const root = positional.length > 0 ? positional[0] : process.cwd();

  if (flags.has('--list')) {
    for (const rule of RULES) {
      process.stdout.write(`${rule.id}\n  ${rule.lesson}\n\n`);
    }
    process.stdout.write('unscannable-file\n  The scanner naming its own blind spot: a tracked file it could not read (NUL bytes, or over the 2 MB cap) is invisible to every rule including the credential rule that never ratchets, so a silent skip made a clean run mean "nothing I could see" while reading as "nothing".\n\n');
    process.stdout.write(`migration-type-drift\n  Schema-Type Synchronization: regenerate types immediately after any APPLIED migration. Types are generated from the live database, so a migration that is written but deliberately not applied yet (Sentigen applies them one at a time as a human decision) cannot appear in them. Such a migration declares itself with \`${UNAPPLIED_MARKER_TEXT}\` on its own comment line in the first ${MARKER_SCAN_BYTES} bytes; it is then excluded from "the newest migration", every skip is printed by name on every run, and deleting the line when you apply it restores full enforcement. Unmarked is always strict.\n\n`);
    process.stdout.write('package-manager-drift\n  Swishh 2026-07-30: package.json pinned pnpm@9.15.9 beside a pnpm-lock.yaml while .localci.sh ran `npm ci --dry-run`, so a fresh clone ignored the lockfile and produced 10 phantom typecheck errors.\n');
    process.stdout.write('\nlayer-violation\n  stack 2026-08-05: 73 packages with ~15 internal edges is a pile of leaves, so @braintied/blog copied 69 files out of @braintied/blog-admin rather than depending on it. Tiers from @braintied/layers; surface -> engine is the edge that matters.\n');
    return 0;
  }

  const notes = [];
  const findings = scanRepo(root, { notes });
  const count = findings.length;
  const buckets = bucketize(findings);

  const ctx = flags.has('--whole-tree')
    ? null
    : branchContext(root, { base: flagValue(argv, '--base') });
  const branch = ctx === null ? null : branchRegressions(root, ctx, findings);

  if (flags.has('--json')) {
    const detail = branch === null || ctx === null
      ? null
      : { ref: ctx.ref, mergeBase: ctx.mergeBase, touched: ctx.touched.size, regressions: branch.regressions };
    process.stdout.write(`${JSON.stringify({ count, buckets, branch: detail, findings, notes }, null, 2)}\n`);
    return 0;
  }

  // Before any gating decision, so it is printed on every non-JSON path — a
  // failing run is exactly when knowing what was NOT measured matters most.
  announceUnappliedMigrations(notes);

  if (flags.has('--rebaseline')) {
    writeBaseline(root, findings);
    process.stdout.write(`check-fleet-guards: baseline explicitly reset to ${count}\n`);
    return 0;
  }

  // Rules marked `alwaysFail` bypass the ratchet entirely, and this check runs
  // BEFORE the first-baseline path -- otherwise a credential present on the day
  // a repo adopts the guard would be written into the baseline and absorbed
  // forever, which is the exact opposite of the point.
  //
  // The baseline exists so a repo can adopt without a big-bang cleanup. That
  // trade is right for style debt and wrong for a live credential.
  const alwaysFailIds = new Set(RULES.filter((r) => r.alwaysFail === true).map((r) => r.id));
  const hardFindings = findings.filter((f) => alwaysFailIds.has(f.rule));
  if (hardFindings.length > 0) {
    process.stderr.write(
      `check-fleet-guards: ${hardFindings.length} finding(s) from rules that never ratchet.\n\n`
    );
    for (const f of hardFindings.slice(0, 40)) {
      process.stderr.write(`  ${f.file}:${f.line} [${f.rule}] ${f.message}\n`);
    }
    process.stderr.write('\nNot baselined and not suppressible by --update-baseline.\n');
    process.stderr.write('Remove the value, then rotate it: git history is permanent.\n');
    return 1;
  }

  let baseline = null;
  try {
    baseline = readBaseline(root);
  } catch (error) {
    if (!(error instanceof UnreadableBaseline)) throw error;
    process.stderr.write(`check-fleet-guards: ${error.message}\n`);
    process.stderr.write('Refusing to rewrite it: that would absorb every violation it was pinning.\n');
    return 2;
  }

  const orphanRules = unknownBaselineRules(baseline);
  if (orphanRules.length > 0) {
    process.stderr.write(
      `check-fleet-guards: ${BASELINE_FILE} pins ${orphanRules.length} rule(s) this checker does not implement:\n`,
    );
    for (const id of orphanRules) {
      process.stderr.write(`  ${id} (pinned at ${baseline.buckets[id]})\n`);
    }
    process.stderr.write(
      '\nThe pin outlived the rule, so that gate has been dead and reporting ok.\n' +
        'Usually a re-vendor overwrote a locally-added rule. Either restore the rule,\n' +
        `or delete its entry from ${BASELINE_FILE} on purpose and say why.\n`,
    );
    return 2;
  }

  if (baseline === null) {
    writeBaseline(root, findings);
    process.stdout.write(`check-fleet-guards: first baseline written (${count} existing violations).\n`);
    process.stdout.write('This count may only decrease. Run --list to see what each rule protects.\n');
    announceUnscannable(findings);
    return 0;
  }

  // Tightening is judged WHOLE-TREE and per rule: the baseline is the fleet's
  // debt ledger, and a number written from a branch's partial view would pin
  // debt that is still there. Baselines move down only.
  if (flags.has('--update-baseline')) {
    const risen = risenRules(buckets, baseline);
    if (risen !== null && risen.length > 0) {
      process.stderr.write('check-fleet-guards: refusing to loosen the ratchet. Use --rebaseline if deliberate.\n');
      for (const r of risen) process.stderr.write(`  ${r.rule}: ${r.was} -> ${r.now}\n`);
      return 1;
    }
    if (count > baseline.count) {
      process.stderr.write(`check-fleet-guards: refusing to loosen the ratchet (${baseline.count} -> ${count}). Use --rebaseline if deliberate.\n`);
      return 1;
    }
    writeBaseline(root, findings);
    process.stdout.write(`check-fleet-guards: baseline tightened ${baseline.count} -> ${count}\n`);
    return 0;
  }

  const perRule = Object.entries(buckets).map(([rule, n]) => `${rule}=${n}`).join(' ');

  // BRANCH MODE. The whole-tree number is still reported, but it does not gate:
  // a violation main gained while this scan was running is not this branch's to
  // pay, and making it so is what taught everyone to bypass the gate.
  if (branch !== null && ctx !== null) {
    if (branch.regressions.length > 0) {
      process.stderr.write(
        `check-fleet-guards: this branch adds ${branch.regressions.length} violation(s) against ${ctx.ref} (merge base ${ctx.mergeBase.slice(0, 9)}).\n\n`,
      );
      for (const r of branch.regressions.slice(0, 40)) {
        const change = r.touchedInput === undefined
          ? `${r.was} -> ${r.now}`
          : `this branch changed ${r.touchedInput}`;
        process.stderr.write(`  ${r.file} [${r.rule}] ${change}\n`);
      }
      if (branch.regressions.length > 40) {
        process.stderr.write(`  ...and ${branch.regressions.length - 40} more\n`);
      }
      const risenFiles = new Set(branch.regressions.map((r) => r.file));
      const risenIds = new Set(branch.regressions.map((r) => r.rule));
      const attributable = findings.filter((f) => risenFiles.has(f.file) && risenIds.has(f.rule));
      process.stderr.write('\n');
      for (const f of attributable.slice(0, 40)) {
        process.stderr.write(`  ${f.file}:${f.line} [${f.rule}] ${f.message}\n      ${f.text}\n`);
      }
      process.stderr.write(`\nWhole-tree totals (not the gate): ${perRule}\n`);
      process.stderr.write('Escape hatch for a justified case: // ci-allow: <rule-id> <reason>\n');
      return 1;
    }
    const drift = count > baseline.count ? `, ${count - baseline.count} above the baseline on ${ctx.ref}` : '';
    process.stdout.write(
      `check-fleet-guards: ok (${branch.scanned} file(s) changed against ${ctx.ref}, none regressed; ${count} tree-wide${drift})\n`,
    );
    announceUnscannable(findings);
    return 0;
  }

  // WHOLE-TREE MODE: no git to ask, or --whole-tree. Per rule when the baseline
  // records rules, on the total when it is a bare integer.
  const risen = risenRules(buckets, baseline);
  const overTotal = baseline.buckets === null && count > baseline.count;
  if ((risen !== null && risen.length > 0) || overTotal) {
    process.stderr.write(`check-fleet-guards: ${count} violations, baseline ${baseline.count}. New violations are not allowed.\n\n`);
    if (risen !== null) {
      for (const r of risen) process.stderr.write(`  ${r.rule}: ${r.was} -> ${r.now}\n`);
      process.stderr.write('\n');
    }
    for (const f of findings.slice(0, 40)) {
      process.stderr.write(`  ${f.file}:${f.line} [${f.rule}] ${f.message}\n      ${f.text}\n`);
    }
    if (findings.length > 40) process.stderr.write(`  ...and ${findings.length - 40} more\n`);
    process.stderr.write(`\nPer-rule totals: ${perRule}`);
    process.stderr.write('\nEscape hatch for a justified case: // ci-allow: <rule-id> <reason>\n');
    return 1;
  }

  process.stdout.write(`check-fleet-guards: ok (${count} violations, baseline ${baseline.count})\n`);
  announceUnscannable(findings);
  return 0;
}

// `process.argv[1]` is undefined under `node -e` / `node --eval`, where
// pathToFileURL(undefined) throws and takes down every importer of this module
// with an error that names this line rather than the caller.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // `process.exitCode`, never `process.exit()`. Writes to a PIPE are async in
  // Node, and process.exit() discards whatever has not drained -- so piping
  // `--json` anywhere (`| jq`, `| node -e`, a shell capture) truncated the
  // output at the 64 KB pipe buffer and produced "Unterminated string in JSON".
  // Any repo with more than a few hundred findings, which is every repo this
  // flag exists for. Setting the code and returning lets Node flush and exit on
  // its own; there are no pending handles to keep it alive.
  process.exitCode = main(process.argv.slice(2));
}
