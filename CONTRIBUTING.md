# Contributing to Metis AI

Thanks for helping improve Metis AI. Small, focused pull requests are welcome,
especially when they include tests or clear reproduction steps.

## Before you start

1. Check existing issues and pull requests.
2. For larger changes, open an issue first so the direction can be discussed.
3. Read [`SECURITY.md`](./SECURITY.md) before reporting a security concern.
4. Read [`docs/README.md`](./docs/README.md). Architecture and operator notes live under `docs/`.
5. Never include `.env`, credentials, API keys, databases or runtime state in a
   commit.

## Local setup

```bash
git clone https://github.com/f1shyondrugs/metis-ai.git
cd metis-ai
pnpm install
cp .env.example .env
pnpm dev
```

Use a dedicated local data directory and test credentials. Do not point local
development at production data or provider accounts that other people depend
on.

## Making changes

- Keep changes focused and avoid unrelated formatting churn.
- Follow the existing TypeScript, React and Tailwind conventions.
- Keep user-facing text in English unless a localized string is explicitly
  required.
- Preserve authentication, authorization and secret-handling boundaries.
- Update the README or relevant package documentation when behavior or setup
  changes.
- Add or update tests for provider, storage, security and API behavior where
  appropriate.

## Validation

Run the checks relevant to your change. For a broad change, run the complete
set:

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm build
```

If a check cannot run in your environment, mention that in the pull request
instead of silently omitting it.

## Pull requests

Please include:

- A short explanation of the problem and the chosen solution.
- The user-visible impact, if any.
- Tests and commands you ran.
- Screenshots or a short recording for meaningful UI changes.
- Notes about configuration, migrations or security implications.

Keep the pull request small enough to review. Resolve review comments with
follow-up commits; maintainers may squash the final history when merging.

## Commit messages

Use concise imperative messages, for example:

```text
Add provider connection validation
Fix shared chat password handling
Improve browser workspace empty state
```

## Reporting bugs

Open an issue with:

- Reproduction steps
- Expected and actual behavior
- Relevant logs with secrets removed
- Browser, operating system and Node.js version
- A minimal reproduction or failing test when possible

Do not disclose security vulnerabilities in a public issue. Follow the
reporting instructions in [`SECURITY.md`](./SECURITY.md).
