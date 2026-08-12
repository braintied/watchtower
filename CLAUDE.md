# watchtower — Repo Instructions

<!-- Harness standard v1 (braintied-harness). Router file: rule + enforcement
     + link. Hard cap 40KB (checks/check-claude-md-size.sh). Long-form detail
     belongs in docs/, not here. -->

{{ONE_LINE_IDENTITY}}. Canon: docs/architecture.md · Operations:
docs/ops-runbook.md · History: docs/changelog/ · Data: {{SCHEMA_DOC}}.

## Domain model (keep these nouns straight)

<!-- The nouns agents must not confuse. One line each. Example:
- **club** = workspace (all data workspace-scoped, RLS everywhere) -->
- **{{NOUN}}** = {{MEANING}}

## Commands

```bash
pnpm install
pnpm run dev        # {{DEV_URL}}
npm run verify (no gate detected — define a verify script or .localci.sh)     # typecheck + lint + test + checks — must be green before committing
```

## Standing facts (don't re-derive, don't contradict)

<!-- Decisions already made. Each entry: the fact, the incident that created
     it (if any), the check that enforces it (if any). Example:
- **ASR = Deepgram** (bake-off-proven 2026-07-22; see docs/decisions/…). -->

## Provenance & copy-and-own

<!-- Lifted/vendored code that will NOT inherit upstream fixes. Plus the
     standing rule: audit any lifted fly.toml/Dockerfile for foreign app
     names BEFORE first deploy. Delete this section if fully greenfield. -->

## Coding standards

House standards apply (global CLAUDE.md): zero `any`/`as`/`!`, explicit null
checks, Zod at every external boundary, workspace scoping on every query,
specific error classes. Repo-specific deltas only below:

## Verification

- `npm run verify (no gate detected — define a verify script or .localci.sh)` green before committing.
- Docs are load-bearing: a change that alters architecture, env, events, or
  APIs updates the matching doc in the same commit.

## Session exit checklist (code-modifying sessions)

1. Changelog entry written (`docs/changelog/YYYY-MM-DD-<slug>.md`, proof
   template in that dir).
2. Touched canonical docs updated + `Last verified` stamp bumped.
3. CLAUDE.md updated ONLY if a rule changed.
4. `npm run verify (no gate detected — define a verify script or .localci.sh)` green.
