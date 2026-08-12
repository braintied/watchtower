# Doc Governance

**Status:** Last verified 2026-08-12

Every markdown file in this repo is one of two kinds. Classification follows
the file's JOB, not its folder.

## LIVING docs

Must match the code **now**. Carry a freshness stamp near the top:

```
**Status:** Last verified YYYY-MM-DD
```

Examples: architecture doc, ops runbook, schema doc, README. When you change
the system, you update the canonical living doc **in the same commit** and
bump its stamp. A living doc that contradicts the code is a bug.

One canonical living doc per domain. Duplicated facts are rot — merge them
into the canonical and link from everywhere else.

## FROZEN docs

Dated evidence: changelog entries, audit reports, bake-off results, incident
writeups. Named `YYYY-MM-DD-<slug>.md`. **Never rewritten** — historical
numbers (test counts, latency, cost, commit hashes) stay exactly as recorded,
even when they become outdated. Corrections happen in a NEW dated entry.

## Update protocol (the session exit checklist enforces this)

1. Change the system → update the canonical living doc + bump its stamp.
2. Write the changelog entry (frozen, proof template in `docs/changelog/`).
3. Update CLAUDE.md only if a **rule** changed.
4. `npm run verify (no gate detected — define a verify script or .localci.sh)` — includes the doc-link check.

## Link integrity

`scripts/checks/check-doc-links.mjs` validates internal links with a ratchet
baseline (`.doc-links-baseline`): the count of broken links may only
decrease. New docs must link clean. `--update-baseline` tightens the ratchet
after improvements; `--rebaseline` recomputes and overwrites the baseline
explicitly (the deliberate escape hatch after a known restructuring).
