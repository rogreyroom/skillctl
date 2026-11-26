import pc from "picocolors";
import { loadConfig } from "../config.js";
import { listLibrarySkills, loadLibraryIndex } from "../library.js";

const TOP_LEVEL_COMMANDS = [
  "setup",
  "status",
  "init",
  "add",
  "rm",
  "sync",
  "list",
  "ls",
  "new",
  "edit",
  "search",
  "info",
  "group",
  "global",
  "raycast",
  "install",
  "update",
  "migrate",
  "doctor",
  "completion",
  "help",
];

export async function runInternalCompleteCommand(
  kind: string,
): Promise<void> {
  try {
    const config = await loadConfig();
    const index = await loadLibraryIndex(config.libraryPath);
    const skills = await listLibrarySkills(config.libraryPath);
    const skillNames = skills.map((s) => s.name);
    const groupNames = Object.keys(index.groups ?? {}).map((g) => `@${g}`);

    if (kind === "skills") {
      for (const name of skillNames) console.log(name);
      return;
    }
    if (kind === "groups") {
      for (const g of Object.keys(index.groups ?? {})) console.log(g);
      return;
    }
    if (kind === "targets") {
      for (const g of groupNames) console.log(g);
      for (const name of skillNames) console.log(name);
      return;
    }
  } catch {
    // Never break shell completion on errors
  }
}

export function generateCompletionScript(shell: string): string | null {
  const normalized = shell.toLowerCase();

  if (normalized === "zsh") {
    return `#compdef skillctl
# Add to ~/.zshrc:  eval "$(skillctl completion zsh)"

_skillctl() {
  local -a commands
  commands=(
    'setup:Configure central library path and agent targets'
    'status:Show library, targets, project counts, and Raycast state'
    'init:Detect project stack and sync matching skills'
    'add:Add skill(s) or @group to the current project'
    'rm:Remove skill(s) or @group from the current project'
    'sync:Rebuild project skill symlinks/copies'
    'list:List library skills or project skills (-p)'
    'new:Scaffold a new kebab-case skill in the library'
    'edit:Open a skill SKILL.md in $EDITOR and validate'
    'search:Search library skills by keyword or @group'
    'info:Show details and usage for a skill'
    'group:Manage @group skill bundles in index.yaml'
    'global:Manage global skills'
    'raycast:Manage Raycast bridge (~/.config/raycast/skills)'
    'install:Install skill(s) from GitHub or local folder'
    'update:Update installed skill(s) from upstream source'
    'migrate:Import existing skills from agent folders'
    'doctor:Check and fix broken links, duplicates, and drift'
    'completion:Output shell completion script (zsh, bash, fish)'
  )

  if (( CURRENT == 2 )); then
    _describe 'command' commands
    return
  fi

  local cmd="\${words[2]}"
  case "$cmd" in
    add|rm)
      local -a targets
      targets=(\${(f)"$(skillctl __complete targets 2>/dev/null)"})
      _describe 'skill or @group' targets
      ;;
    edit|info|update)
      local -a skills
      skills=(\${(f)"$(skillctl __complete skills 2>/dev/null)"})
      _describe 'skill' skills
      ;;
    global)
      if (( CURRENT == 3 )); then
        _values 'subcommand' list add rm sync
      elif [[ "\${words[3]}" == "add" || "\${words[3]}" == "rm" ]]; then
        local -a targets
        targets=(\${(f)"$(skillctl __complete targets 2>/dev/null)"})
        _describe 'skill or @group' targets
      fi
      ;;
    raycast)
      if (( CURRENT == 3 )); then
        _values 'subcommand' use clear add rm status
      elif [[ "\${words[3]}" == "add" || "\${words[3]}" == "rm" ]]; then
        local -a targets
        targets=(\${(f)"$(skillctl __complete targets 2>/dev/null)"})
        _describe 'skill or @group' targets
      fi
      ;;
    group)
      if (( CURRENT == 3 )); then
        _values 'subcommand' list add rm
      elif (( CURRENT == 4 )); then
        local -a groups
        groups=(\${(f)"$(skillctl __complete groups 2>/dev/null)"})
        _describe 'group' groups
      else
        local -a skills
        skills=(\${(f)"$(skillctl __complete skills 2>/dev/null)"})
        _describe 'skill' skills
      fi
      ;;
    completion)
      _values 'shell' zsh bash fish
      ;;
  esac
}

compdef _skillctl skillctl
`;
  }

  if (normalized === "bash") {
    return `# Add to ~/.bashrc:  eval "$(skillctl completion bash)"

_skillctl_completions() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  local cmd="\${COMP_WORDS[1]}"

  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "${TOP_LEVEL_COMMANDS.join(" ")}" -- "$cur") )
    return 0
  fi

  case "$cmd" in
    add|rm)
      local targets
      targets="$(skillctl __complete targets 2>/dev/null)"
      COMPREPLY=( $(compgen -W "$targets" -- "$cur") )
      ;;
    edit|info|update)
      local skills
      skills="$(skillctl __complete skills 2>/dev/null)"
      COMPREPLY=( $(compgen -W "$skills" -- "$cur") )
      ;;
    global)
      if [[ \${COMP_CWORD} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "list add rm sync" -- "$cur") )
      else
        local targets
        targets="$(skillctl __complete targets 2>/dev/null)"
        COMPREPLY=( $(compgen -W "$targets" -- "$cur") )
      fi
      ;;
    raycast)
      if [[ \${COMP_CWORD} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "use clear add rm status" -- "$cur") )
      else
        local targets
        targets="$(skillctl __complete targets 2>/dev/null)"
        COMPREPLY=( $(compgen -W "$targets" -- "$cur") )
      fi
      ;;
    group)
      if [[ \${COMP_CWORD} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "list add rm" -- "$cur") )
      elif [[ \${COMP_CWORD} -eq 3 ]]; then
        local groups
        groups="$(skillctl __complete groups 2>/dev/null)"
        COMPREPLY=( $(compgen -W "$groups" -- "$cur") )
      else
        local skills
        skills="$(skillctl __complete skills 2>/dev/null)"
        COMPREPLY=( $(compgen -W "$skills" -- "$cur") )
      fi
      ;;
    completion)
      COMPREPLY=( $(compgen -W "zsh bash fish" -- "$cur") )
      ;;
  esac
}

complete -F _skillctl_completions skillctl
`;
  }

  if (normalized === "fish") {
    return `# Add to ~/.config/fish/config.fish:  skillctl completion fish | source

complete -c skillctl -f
complete -c skillctl -n "__fish_use_subcommand" -a "${TOP_LEVEL_COMMANDS.join(" ")}"
complete -c skillctl -n "__fish_seen_subcommand_from add rm" -a "(skillctl __complete targets 2>/dev/null)"
complete -c skillctl -n "__fish_seen_subcommand_from edit info update" -a "(skillctl __complete skills 2>/dev/null)"
complete -c skillctl -n "__fish_seen_subcommand_from global; and not __fish_seen_subcommand_from list add rm sync" -a "list add rm sync"
complete -c skillctl -n "__fish_seen_subcommand_from global; and __fish_seen_subcommand_from add rm" -a "(skillctl __complete targets 2>/dev/null)"
complete -c skillctl -n "__fish_seen_subcommand_from raycast; and not __fish_seen_subcommand_from use clear add rm status" -a "use clear add rm status"
complete -c skillctl -n "__fish_seen_subcommand_from raycast; and __fish_seen_subcommand_from add rm" -a "(skillctl __complete targets 2>/dev/null)"
complete -c skillctl -n "__fish_seen_subcommand_from group; and not __fish_seen_subcommand_from list add rm" -a "list add rm"
complete -c skillctl -n "__fish_seen_subcommand_from group; and __fish_seen_subcommand_from add rm" -a "(skillctl __complete groups 2>/dev/null) (skillctl __complete skills 2>/dev/null)"
complete -c skillctl -n "__fish_seen_subcommand_from completion" -a "zsh bash fish"
`;
  }

  return null;
}

export async function runCompletionCommand(shell: string): Promise<void> {
  const script = generateCompletionScript(shell);
  if (!script) {
    console.error(
      pc.red(
        `Unsupported shell "${shell}". Supported shells: zsh, bash, fish.`,
      ),
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(script);
}
