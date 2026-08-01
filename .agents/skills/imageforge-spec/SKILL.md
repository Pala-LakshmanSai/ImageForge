---
name: imageforge-spec
description: Convert an ImageForge feature, bug, UI change, backend change, or release request into one bounded implementation contract with observable acceptance criteria, binding non-goals, relevant files, automated tests, and manual verification. Use before assigning any nontrivial ImageForge build task or when requirements conflict.
---

# Specify ImageForge work

1. Read `AGENTS.md`, `docs/PRODUCT_SPEC.md`, and relevant architecture files.
2. Inspect existing code before asking a question the repository can answer.
3. Resolve only product forks that materially change observable behavior.
4. Write one task sized for one agent and one review cycle.
5. Use stable `AC-N` and `NG-N` identifiers.
6. Include failure, reconnect, concurrency, and empty states when relevant.
7. Require tests and numbered manual verification for every acceptance criterion.
8. Stop if two capable builders could still ship different behavior.

Use the exact contract shape in `references/task-template.md`. Never mark a
contract complete by weakening an acceptance criterion.
