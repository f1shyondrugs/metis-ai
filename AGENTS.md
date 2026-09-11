# Metis Agent Rules

Project documentation is under [`docs/README.md`](./docs/README.md). Current
open production issues: [`docs/PRODUCTION-AUDIT.md`](./docs/PRODUCTION-AUDIT.md).
Do not stop live Metis systemd units as a side effect of a test.

## Provider And Model Contract

- Never hardcode a model, provider capability, context window, parameter value,
  usage limit, tool contract, or provider-specific default in UI code, prompts,
  runners, or fallback branches.
- Model metadata must flow from the provider registry contract and, whenever a
  connection supports discovery, the provider's live discovery response.
- Live discovery is authoritative for model IDs, display names, context,
  reasoning/effort values, fast mode, vision, tools, MCP, browser, skills,
  subagents, and usage sources. Merge only explicit registry metadata for the
  same provider/model family; never infer correctness from a model-name regex.
- Unknown or missing capabilities must stay unknown and be shown as unavailable.
  Do not silently invent a default, quota, context size, reasoning level, or
  tool.
- Every model switch and every run must validate persisted parameters against
  the selected model contract. Metis-only parameters must never be forwarded
  to a provider.
- Provider adapters must use the canonical Metis MCP contract. Do not add
  native file, shell, browser, task, or subagent tools as an undocumented
  fallback.

## Change Requirements

- When adding or changing a provider/model contract, update the typed registry,
  discovery merge, model-parameter validation, and focused tests together.
- Do not add a model to a picker only to make a UI test pass.
- Prefer a clear "not available" state over a fabricated value.
- Keep this policy synchronized with any future `CLAUDE.md`, `GEMINI.md`,
  `CODEX.md`, or other repository agent instruction file.
