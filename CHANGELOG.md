# Changelog

All notable changes to `skillctl` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-11-26

### Added
- **Skill groups (`groups:` in `index.yaml`)** — use `@group` syntax in `add`, `rm`, `global add/rm`, and `raycast add`.
- **`skillctl new <name>`** — scaffold a new kebab-case skill with Raycast-valid `SKILL.md` frontmatter and optional match rules.
- **`skillctl search <query>`** & **`skillctl info <skill>`** — search library skills by keyword/group/rules and inspect full details and tracked project usage.
- **`skillctl sync --all`** — re-sync all tracked projects in one command.
- **Upstream tracking (`skillctl update`)** — `skillctl install` records `source` in `index.yaml`; `skillctl update` re-pulls upstream updates.
- **`skillctl list --project` (`-p`)** — filter to skills active in the current project (repo, local, unmanaged, and global).
- **`skillctl status`** — quick overview of library, global targets, project skill counts, worktree state, and Raycast bridge.
- **Antigravity global target** (`~/.gemini/config/skills/`) toggleable in `skillctl setup`.
- **Legacy duplicate checks in `skillctl doctor`** — detects and auto-fixes stale copies in `~/.cursor/skills/` and unmanaged library duplicates in `~/.agents/skills/`.
- **Git worktree support** — resolves linked worktree `.git` files via `commondir` for `.git/info/exclude`, and `skillctl sync` inherits `.skillctl.local.json` from the main worktree.

## [0.1.0] - 2026-11-25

### Added
- Initial `skillctl` CLI with central library (`~/dotfiles/agent-skills`), `index.yaml` project detection, mixed `.skillctl.json` (shared copy) + `.skillctl.local.json` (personal symlink, `.git/info/exclude`), Raycast bridge (`~/.config/raycast/skills`), bidirectional duplicate checks, `doctor --fix`, `install`, and `migrate`.
