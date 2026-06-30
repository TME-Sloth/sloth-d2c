# Sloth D2C

Codex marketplace package for the Sloth D2C design-to-code workflow.

This repository intentionally contains only the Codex plugin distribution files:

- `.agents/plugins/marketplace.json`
- `plugins/sloth-d2c/.codex-plugin/plugin.json`
- `plugins/sloth-d2c/skills/`
- `plugins/sloth-d2c/scripts/`

## Install

Install the marketplace from GitHub:

```bash
codex plugin marketplace add TME-Sloth/sloth-d2c --ref main
codex plugin add sloth-d2c --marketplace sloth-d2c
```

For local testing from a checkout:

```bash
codex plugin marketplace add /path/to/sloth-d2c
codex plugin add sloth-d2c --marketplace sloth-d2c
```

## Requirements

The plugin workflows expect the Sloth CLI to be available when running D2C generation:

```bash
npm install -g sloth-d2c-mcp
sloth --version
```

## Validate

```bash
npm run validate
```

## Release

1. Update `plugins/sloth-d2c/.codex-plugin/plugin.json`.
2. Run `npm run validate`.
3. Commit and push to `main`.
4. Users can refresh with:

```bash
codex plugin marketplace upgrade sloth-d2c
```
