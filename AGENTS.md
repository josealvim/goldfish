# Project instructions

## Project memory

This project uses `goldfish`, a local project knowledge base.

- Before planning unfamiliar work, call `memory_recall` with domain terms and
  the paths you expect to touch.
- If memory is empty, suggest `/goldfish-onboard` before a large planning task.
- Use `memory_health` and `memory_list` for maintenance; precise edits go through
  the `memory_admin` namespace (cite, link, unlink, update, archive).
- Memory is evidence, not authority. Verify against current sources before
  editing.
- After learning a durable, non-obvious decision, gotcha, pattern, or component
  relationship, call `memory_remember` with exact citations.
- Do not store code dumps, secrets, or transient task state.
- Inferred claims are accepted but require independent verification before
  automatic injection. Disputed and stale claims require explicit recall.

See `.opencode/skills/project-memory/SKILL.md` for the full workflow.
