# <Plan title>

**Status:** active
**Opened:** YYYY-MM-DD

## The problem

What is actually wrong, with evidence — a measurement, an error string, a
failing case. Not "improve X"; a plan that cannot say what is broken cannot
say when it is done.

## Why now

What this unblocks, or what it costs to leave alone.

## Approach

The chosen shape, and the alternatives rejected with the reason. A plan that
lists only the chosen option hides the decision.

## Steps

- [ ] Step, in dependency order
- [ ] Each one independently verifiable

## Verification

How this will be proven, before it is called done. Prefer positive evidence
(rows written, work completed) over absence of errors — a quiet system and a
working one look identical from the outside.

## Out of scope

What this plan deliberately does NOT do, so scope creep is visible.

---

<!--
LIFECYCLE — the folder is the status, so `ls` tells the truth and moving the
file IS the state change:

  docs/plans/active/     being worked
  docs/plans/executed/   shipped — add the block below and move it here
  docs/plans/archive/    written, never executed, now stale

On execution, prepend:

    ---
    executed: YYYY-MM-DD
    commits:
      - <sha> <subject>
    ---

A plan left in active/ after it shipped is worse than no plan: it reads as
outstanding work forever.
-->
