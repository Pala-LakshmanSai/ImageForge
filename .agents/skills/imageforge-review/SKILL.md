---
name: imageforge-review
description: Independently review an ImageForge implementation, pull request, diff, benchmark, UI state, backend behavior, or release against its task contract and product invariants. Use after every builder handoff and before integration or packaging; never fix code during the same review pass.
---

# Review ImageForge work

1. Read the task, `AGENTS.md`, relevant docs, full diff, and changed files.
2. Reproduce using raw code and commands; do not trust the builder summary.
3. Run the narrow tests, then relevant full checks. Inspect real rendered UI for
   frontend changes and concurrency/restart behavior for worker changes.
4. Report only scoped evidence in three groups:
   - **Must fix before integration**: failed AC, defect, security issue, data
     loss, secret exposure, regression, or required test failure.
   - **Should fix soon**: material maintainability or polish issue inside scope.
   - **Safe to integrate**: yes/no and why.
5. Tag each must-fix with `[AC-N]`, `[DEFECT]`, `[SECURITY]`, `[TEST]`, or
   `[VISUAL]`, plus file/line or reproduction evidence.
6. Escalate a scope conflict instead of prescribing behavior excluded by a
   non-goal.

Never edit, merge, weaken tests, or approve from the builder's context. A fresh
review must evaluate the new commit after every repair.
