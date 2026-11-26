import path from "node:path";
import pc from "picocolors";
import { loadConfig, loadMergedProjectManifest } from "../config.js";
import {
  discoverProjectUnmanagedSkills,
  listLibrarySkills,
  loadLibraryIndex,
} from "../library.js";
import { resolveGitInfo } from "../linker.js";

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

  const enabledTargets = ["~/.agents/skills"];
  if (config.agents.claude) enabledTargets.push("~/.claude/skills");
  if (config.agents.antigravity) enabledTargets.push("~/.gemini/config/skills");

  const repoCount = Object.keys(existing.shared?.skills ?? {}).length;
  const localCount = Object.keys(existing.local?.skills ?? {}).length;

  console.log(pc.bold("skillctl status"));
  console.log(
    `  Library:        ${pc.cyan(config.libraryPath)} ${pc.dim(`(${librarySkills.length} skill(s))`)}`,
  );
  console.log(`  Global targets: ${pc.dim(enabledTargets.join(", "))}`);
  console.log(
    `  Global skills:  ${index.global.length > 0 ? pc.cyan(index.global.join(", ")) : pc.dim("(none)")}`,
  );
  console.log(
    `  Project:        ${pc.bold(path.basename(projectDir))} ${pc.dim(`(${projectDir})`)}${gitInfo?.isWorktree ? pc.yellow(" [git worktree]") : ""}`,
  );
  console.log(
    `    Skills:       ${pc.green(`${repoCount} repo`)}, ${pc.blue(`${localCount} local`)}, ${pc.yellow(`${unmanaged.length} unmanaged`)}`,
  );
  console.log(
    `  Raycast bridge: active=${config.raycast.activeProject ? pc.cyan(path.basename(config.raycast.activeProject)) : pc.dim("(none)")}, pinned=${config.raycast.pinned.length}`,
  );
}
