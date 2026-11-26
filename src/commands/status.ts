import path from "node:path";
import pc from "picocolors";
import { loadConfig, loadMergedProjectManifest } from "../config.js";
import {
  discoverProjectUnmanagedSkills,
  listLibrarySkills,
  loadLibraryIndex,
} from "../library.js";
import { resolveGitInfo } from "../linker.js";
import { badge, renderCard } from "../ui.js";

export async function runStatusCommand(options: {
  dir?: string;
}): Promise<void> {
  const projectDir = path.resolve(options.dir ?? process.cwd());
  const config = await loadConfig();
  const index = await loadLibraryIndex(config.libraryPath);
  const librarySkills = await listLibrarySkills(config.libraryPath);
  const existing = await loadMergedProjectManifest(projectDir);
  const unmanaged = await discoverProjectUnmanagedSkills(
    projectDir,
    config.libraryPath,
  );
  const gitInfo = await resolveGitInfo(projectDir);

  const enabledTargets = [pc.cyan("~/.agents/skills")];
  if (config.agents.claude) enabledTargets.push(pc.cyan("~/.claude/skills"));
  if (config.agents.antigravity)
    enabledTargets.push(pc.cyan("~/.gemini/config/skills"));

  const repoCount = Object.keys(existing.shared?.skills ?? {}).length;
  const localCount = Object.keys(existing.local?.skills ?? {}).length;

  const projectValue =
    `${pc.bold(path.basename(projectDir))} ${pc.dim(`(${projectDir})`)}` +
    (gitInfo?.isWorktree ? ` ${badge("worktree", "yellow")}` : "");

  const projectCounts = [
    pc.green(`${repoCount} repo`),
    pc.blue(`${localCount} local`),
    unmanaged.length > 0
      ? pc.yellow(`${unmanaged.length} unmanaged`)
      : pc.dim("0 unmanaged"),
  ].join(pc.dim(" · "));

  const raycastValue = [
    `active: ${config.raycast.activeProject ? pc.cyan(path.basename(config.raycast.activeProject)) : pc.dim("none")}`,
    `pinned: ${config.raycast.pinned.length > 0 ? pc.magenta(String(config.raycast.pinned.length)) : pc.dim("0")}`,
  ].join(pc.dim(" · "));

  const rows: Array<[string, string]> = [
    [
      "Library",
      `${pc.cyan(config.libraryPath)} ${pc.dim(`(${librarySkills.length} skills)`)}`,
    ],
    ["Targets", enabledTargets.join(pc.dim(", "))],
    [
      "Global",
      index.global.length > 0
        ? index.global.map((g) => pc.cyan(g)).join(pc.dim(", "))
        : pc.dim("(none)"),
    ],
    ["Project", projectValue],
    ["Project skills", projectCounts],
    ["Raycast", raycastValue],
  ];

  console.log("");
  console.log(renderCard("skillctl status", rows));
  console.log("");
}
