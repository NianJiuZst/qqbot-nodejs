# Contributing

First off, thanks for taking the time to contribute! This document explains
how to file issues, propose features and submit pull requests to
`@tencent-connect/qqbot-nodejs`.

- [Getting Started](#getting-started)
- [Development Workflow](#development-workflow)
- [Commit Message Convention](#commit-message-convention)
- [Pull Request Checklist](#pull-request-checklist)
- [Reporting Bugs](#reporting-bugs)
- [Proposing Features](#proposing-features)
- [Security Issues](#security-issues)
- [License](#license)

## Getting Started

Requirements:

- Node.js **>= 20** (Active LTS)
- pnpm **>= 9** (see the `packageManager` field in `package.json`)

Install and verify locally:

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
```

The `dist/` output is only produced at publish time via `npm run build` (and is
`.gitignore`d). You should not commit build artifacts.

## Development Workflow

1. Fork the repository and create a topic branch off `main`:

   ```bash
   git checkout -b feat/my-feature
   # or fix/bug-name, docs/xxx, refactor/xxx …
   ```

2. Make your changes. Please keep PRs focused — one logical change per PR.
3. Add or update tests. New public APIs must ship with tests.
4. Run the full verification loop before pushing:

   ```bash
   pnpm typecheck
   pnpm lint
   pnpm test:coverage
   ```

5. Update documentation (`README.md`, `README.zh-CN.md`, `USAGE.md`) if you
   change public API or behaviour.

## Commit Message Convention

We use [Conventional Commits](https://www.conventionalcommits.org/) enforced
by `commitlint`. The release pipeline (`semantic-release`) derives the next
version and the changelog from these commit messages.

Format:

```
<type>(<scope>): <subject>

[optional body]

[optional footer]
```

Common types:

| Type       | When to use                                            | Version bump |
| :--------- | :----------------------------------------------------- | :----------: |
| `feat`     | A new feature                                          |    minor     |
| `fix`      | A bug fix                                              |    patch     |
| `perf`     | A performance improvement                              |    patch     |
| `refactor` | Code change that neither fixes a bug nor adds a feature |     —      |
| `docs`     | Documentation only changes                             |      —       |
| `test`     | Adding or fixing tests                                 |      —       |
| `build`    | Build system / dependency changes                      |      —       |
| `ci`       | CI configuration                                       |      —       |
| `chore`    | Miscellaneous chores                                   |      —       |

A commit with `BREAKING CHANGE:` in the footer triggers a **major** bump.

Examples:

```
feat(middleware): add per-target concurrency guard
fix(gateway): retry with fresh token on close code 4004
docs(readme): add English quick-start section
```

## Pull Request Checklist

Before requesting review, please make sure:

- [ ] The PR title follows Conventional Commits.
- [ ] `pnpm typecheck && pnpm lint && pnpm test` all pass locally.
- [ ] New behaviour is covered by tests.
- [ ] Public API changes are documented in `README*.md` / `USAGE.md`.
- [ ] The change does not introduce breaking changes; if it must, the commit
      body includes a `BREAKING CHANGE:` footer.
- [ ] No secrets, tokens or internal URLs are added to the codebase or CI.

## Reporting Bugs

Please use the [Bug Report](.github/ISSUE_TEMPLATE/bug_report.yml) template
and include:

- SDK version (`@tencent-connect/qqbot-nodejs@x.y.z`)
- Node.js version (`node -v`)
- OS
- Minimal reproduction (a self-contained snippet or repo)
- Expected vs actual behaviour
- Relevant logs (with **credentials and openids redacted**)

## Proposing Features

For non-trivial features, please open an issue first so we can discuss scope,
API shape and platform constraints before you invest time.

The SDK is deliberately **protocol-only**. Business abstractions
(persistence, auth, LLM integration) belong in the caller layer, not in the
SDK. Keep this in mind when proposing new middleware or high-level facades.

## Security Issues

Please do **NOT** open a public issue for security vulnerabilities. See
[SECURITY.md](./SECURITY.md) for the private disclosure process.

## License

By contributing, you agree that your contributions will be licensed under
the [MIT License](./LICENSE).
