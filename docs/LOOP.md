# Codex-native delivery loop

1. Spec: convert one outcome into acceptance criteria, non-goals, relevant
   files, tests, and manual verification.
2. Build: one agent works in one isolated Git worktree and changes only its
   contract.
3. Verify: builder runs targeted checks and records results.
4. Review: a fresh agent reads the contract and raw diff/test artifacts, then
   reports must-fix, should-fix, and safe-to-integrate sections.
5. Repair: return must-fix items to the builder. Allow at most two rounds.
6. Integrate: the main agent rebases/merges verified work and runs cross-system
   tests.
7. Taste pass: render UI states and compare against `DESIGN_SYSTEM.md`; repeat
   until the user-visible result reaches the reference quality.

Durable truth lives in the repository. Chat messages may explain or summarize
but do not override a checked-in contract without updating it.
