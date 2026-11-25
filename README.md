# skillctl

Manage global, per-project, and Raycast AI agent skills from a single central library (default `~/dotfiles/agent-skills`).

Works seamlessly across **VS Code (Copilot)**, **Cursor**, **Raycast**, and **T3 Code (Codex + Claude Code)**.

## Features

- **Central skill library** (`~/dotfiles/agent-skills` by default, configurable via `skillctl setup`) with matching rules in `index.yaml` (so `SKILL.md` stays untouched and Raycast-compatible).
- **Smart project detection (`skillctl init`)** — reads `package.json`, `composer.json`, `pyproject.toml`, `Cargo.toml`, and config files (`nuxt.config.*`, `wrangler.toml`, `.gitlab-ci.yml`, etc.) to suggest matching skills.
- **Symlink vs. Copy per skill** — symlink personal skills (automatically added to `.git/info/exclude`) or copy real files for team/shared repos (with hash-based drift detection).
- **Raycast bridge (`~/.config/raycast/skills`)** — expose a project's skills (`skillctl raycast use`) or pin specific skills (`skillctl raycast add`) to Raycast without polluting `~/.agents/skills` for Cursor/VS Code/Codex.
- **Bidirectional duplicate checks** — prevents/warns on overlap between global and project skills in both directions.
- **Health checks (`skillctl doctor --fix`)** — finds broken symlinks, duplicates, invalid `SKILL.md` files (kebab-case/name mismatch), and drifted copied skills.
- **Import & Migrate** — install remote skills from GitHub (`skillctl install owner/repo`) or migrate existing skills from `~/.agents/skills` and `~/.claude/skills`.

## Install & Build

```bash
pnpm install
pnpm build
npm link
```

## Quick Start

```bash
# 1. Configure library path (default ~/dotfiles/agent-skills) & migrate existing skills
skillctl setup

# 2. Pick global skills (linked into ~/.agents/skills, and ~/.claude/skills if enabled)
skillctl global add

# 3. Inside any project, detect stack & link/copy matching skills
skillctl init

# 4. Expose the current project's skills to Raycast (via ~/.config/raycast/skills)
skillctl raycast use

# 5. Check health and auto-fix stale links, duplicates, or drifted copies
skillctl doctor --fix
```

## Library `index.yaml` Example

```yaml
global:
  - find-skills
  - commit-style

skills:
  vitest:
    match:
      deps: [vitest]
  nuxt-vertical-slice:
    match:
      deps: [nuxt]
      files: [nuxt.config.*]
  raycast-extension:
    match:
      deps: ["@raycast/api"]
  laravel-api:
    match:
      files: [composer.json, artisan]
```
