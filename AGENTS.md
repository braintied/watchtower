# watchtower — Agent Instructions

<!-- Harness standard v2. AGENTS.md is the cross-vendor router (Linux
     Foundation standard; read by Codex, Cursor, Copilot, Devin, Gemini CLI,
     20+ tools). Keep it SHORT and point at the same canon CLAUDE.md uses —
     never duplicate content between the two. -->

{{ONE_LINE_IDENTITY}}

- **How the platform works:** docs/architecture.md
- **Operating it:** docs/ops-runbook.md
- **History:** docs/changelog/ (dated entries; proof template inside)
- **Doc rules:** docs/DOC-GOVERNANCE.md (LIVING docs carry `Last verified`
  stamps and must match code; FROZEN docs are never rewritten)

## Working rules

- `npm run verify (no gate detected — define a verify script or .localci.sh)` must be green before committing (typecheck + lint +
  test + harness checks).
- Docs are load-bearing: a change to architecture, env, events, or APIs
  updates the matching doc in the same commit.
- Claude-specific instructions live in CLAUDE.md; this file is the
  tool-agnostic surface. When they would overlap, link — don't copy.
