#!/usr/bin/env node
import { Command } from "commander";
import { runDoctorCommand } from "./commands/doctor.js";
import {
  runGlobalAddCommand,
  runGlobalListCommand,
  runGlobalRmCommand,
  runGlobalSyncCommand,
} from "./commands/global.js";
import { runInitCommand } from "./commands/init.js";
import { runInstallCommand, runMigrateCommand } from "./commands/install.js";
import {
  runListCommand,
  runProjectAddCommand,
  runProjectRmCommand,
  runProjectSyncCommand,
} from "./commands/project.js";
import {
  runRaycastAddCommand,
  runRaycastClearCommand,
  runRaycastRmCommand,
  runRaycastStatusCommand,
  runRaycastUseCommand,
} from "./commands/raycast.js";
import { runSetupCommand } from "./commands/setup.js";
import { runStatusCommand } from "./commands/status.js";

const program = new Command();

program
  .name("skillctl")
  .description(
    "Manage global, per-project, and Raycast AI agent skills from a central library",
  )
  .version("0.1.0");

program
  .command("setup")
  .description("Configure central library path, agent targets, and migrate existing skills")
  .option("--library <path>", "Central skill library path")
  .option("--claude", "Enable Claude Code (~/.claude/skills & .claude/skills)")
  .option("--no-claude", "Disable Claude Code sync")
  .option("--antigravity", "Enable Antigravity global skills (~/.gemini/config/skills)")
  .option("--no-antigravity", "Disable Antigravity global sync")
  .option("-y, --yes", "Run non-interactively with defaults")
  .action(runSetupCommand);

program
  .command("status")
  .description("Show library path, enabled targets, global/project counts, and Raycast state")
  .option("--dir <path>", "Target project directory")
  .action(runStatusCommand);

program
  .command("init")
  .description("Detect project stack, suggest matching skills, and sync to this project")
  .option("--copy", "Copy skills into repo (for team/shared repos)")
  .option("--link", "Symlink skills into repo (personal)")
  .option("--claude", "Also sync into .claude/skills/")
  .option("--no-claude", "Do not sync into .claude/skills/")
  .option("-y, --yes", "Accept detected matches non-interactively")
  .option("--dir <path>", "Target project directory")
  .action(runInitCommand);

program
  .command("add [skills...]")
  .description("Add one or more library skills to the current project")
  .option("--copy", "Copy skill files instead of symlinking")
  .option("--link", "Symlink skill from library")
  .option("-f, --force", "Add even if the skill is already active globally")
  .option("--dir <path>", "Target project directory")
  .action(runProjectAddCommand);

program
  .command("rm [skills...]")
  .description("Remove one or more skills from the current project")
  .option("--dir <path>", "Target project directory")
  .action(runProjectRmCommand);

program
  .command("sync")
  .description("Rebuild project skill symlinks/copies from .skillctl.json and .skillctl.local.json")
  .option("--dir <path>", "Target project directory")
  .action(runProjectSyncCommand);

program
  .command("list")
  .alias("ls")
  .description("List library skills or only skills active in the current project (-p)")
  .option("-p, --project", "Show only skills active in the current project (plus unmanaged & global)")
  .option("--dir <path>", "Target project directory")
  .action(runListCommand);

const globalCmd = program
  .command("global")
  .description("Manage global skills linked in ~/.agents/skills");

globalCmd
  .command("list")
  .alias("ls")
  .description("List active global skills")
  .action(runGlobalListCommand);

globalCmd
  .command("add [skills...]")
  .description("Enable skill(s) globally")
  .option(
    "--clean-project-duplicates",
    "Automatically remove duplicate entries from tracked projects",
  )
  .action(runGlobalAddCommand);

globalCmd
  .command("rm [skills...]")
  .description("Remove skill(s) from global skills")
  .action(runGlobalRmCommand);

globalCmd
  .command("sync")
  .description("Sync global skill symlinks from library index.yaml")
  .action(runGlobalSyncCommand);

const raycastCmd = program
  .command("raycast")
  .description("Expose project or pinned skills to Raycast via ~/.config/raycast/skills");

raycastCmd
  .command("use [projectPath]")
  .description("Expose a project's skills to Raycast (defaults to current directory)")
  .action(runRaycastUseCommand);

raycastCmd
  .command("clear")
  .description("Clear the active Raycast project (keeps pinned skills)")
  .action(runRaycastClearCommand);

raycastCmd
  .command("add <skills...>")
  .description("Pin library skill(s) to Raycast without making them global for other tools")
  .action(runRaycastAddCommand);

raycastCmd
  .command("rm <skills...>")
  .description("Unpin skill(s) from Raycast")
  .action(runRaycastRmCommand);

raycastCmd
  .command("status")
  .description("Show active Raycast project and pinned skills")
  .action(runRaycastStatusCommand);

program
  .command("install <source>")
  .description("Import skill(s) from a git repo (owner/repo or URL) or local folder into library")
  .option("--overwrite", "Overwrite existing skills with the same name")
  .action(runInstallCommand);

program
  .command("migrate")
  .description("Import existing skills from ~/.agents, ~/.claude, ~/.cursor, and ~/.codegpt into library")
  .option("--overwrite", "Overwrite existing skills with the same name")
  .action(runMigrateCommand);

program
  .command("doctor")
  .description("Check for broken symlinks, duplicates, invalid SKILL.md files, and copy drift")
  .option("--fix", "Automatically repair fixable issues")
  .option("--dir <path>", "Target project directory")
  .action(runDoctorCommand);

program.addHelpText(
  "after",
  `
Examples:
  $ skillctl setup                     Configure library & migrate existing skills
  $ skillctl global add find-skills    Enable a skill globally (~/.agents/skills)
  $ skillctl init                      Detect project stack & link/copy matching skills
  $ skillctl add vitest                Add personal skill (.skillctl.local.json, git-excluded)
  $ skillctl add vitest --copy         Add shared skill (.skillctl.json, committed to repo)
  $ skillctl list --project            Verify all skills active in the current project
  $ skillctl raycast use               Expose current project's skills to Raycast
  $ skillctl doctor --fix              Find and auto-repair broken links, duplicates, or drift
`,
);

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
