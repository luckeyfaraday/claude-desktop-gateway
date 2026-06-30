# Contributing

Thanks for taking the time to contribute to claude-desktop-gateway.

## Getting started

```bash
git clone https://github.com/luckeyfaraday/claude-desktop-gateway.git
cd claude-desktop-gateway
npm install   # only needed for the Electron desktop app
```

The CLI gateways (`src/`, `scripts/`) have no runtime dependencies and run
directly with Node.js 18.17+.

## Before opening a pull request

Run the syntax check that CI also runs:

```bash
npm run check
```

This runs `node --check` against every `.mjs`/`.cjs` file in the project. If
you change `app/`, also smoke-test the desktop app locally:

```bash
npm run app
```

## Pull request guidelines

- Keep changes focused; unrelated cleanup belongs in its own PR.
- Match the existing code style (plain Node.js, no build step, no
  dependencies beyond Electron for the desktop app).
- Update `README.md` if you change a script's flags, environment variables,
  or default model.
- Describe what you tested (CLI gateway, desktop app, which OS) in the PR
  description.

## Reporting bugs and requesting features

Use the issue templates under **Issues → New issue**. Include your OS, Node
version, and which gateway (OpenRouter or Codex OAuth) you were running.

## Security issues

Do not open a public issue for credential leaks, OAuth token handling bugs,
or similar security-sensitive reports. See [SECURITY.md](./SECURITY.md).
