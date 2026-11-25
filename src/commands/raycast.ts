import path from "node:path";
import pc from "picocolors";
import {
  loadConfig,
  loadMergedProjectManifest,
  saveConfig,
} from "../config.js";
import { listLibrarySkills, loadLibraryIndex } from "../library.js";
import { syncRaycast } from "../linker.js";
import { getRaycastSkillsDir } from "../paths.js";

export async function runRaycastUseCommand(
  projectArg?: string,
): Promise<void> {
  const projectDir = path.resolve(projectArg ?? process.cwd());
  const { merged: manifest } = await loadMergedProjectManifest(projectDir);
  if (!manifest) {
    console.error(
      pc.red(
        `No .skillctl.json or .skillctl.local.json found in ${projectDir}. Run \`skillctl init\` there first.`,
      ),
    );
    process.exitCode = 1;
    return;
  }

  const config = await loadConfig();
  const index = await loadLibraryIndex(config.libraryPath);

  config.raycast.activeProject = projectDir;
  if (!config.trackedProjects.includes(projectDir)) {
    config.trackedProjects.push(projectDir);
  }
  await saveConfig(config);

  const result = await syncRaycast(config, index);
  console.log(
    pc.green(
      `Raycast active project set to ${path.basename(projectDir)} (${projectDir})`,
    ),
  );
  console.log(
    `  Linked in ${pc.dim(getRaycastSkillsDir())}: ${result.linked.length > 0 ? result.linked.join(", ") : pc.dim("(none)")}`,
  );
  if (result.skippedGlobal && result.skippedGlobal.length > 0) {
    console.log(
      pc.dim(
        `  Skipped (already global): ${result.skippedGlobal.join(", ")}`,
      ),
    );
  }
}

export async function runRaycastClearCommand(): Promise<void> {
  const config = await loadConfig();
  const index = await loadLibraryIndex(config.libraryPath);

  delete config.raycast.activeProject;
  await saveConfig(config);

  const result = await syncRaycast(config, index);
  console.log(
    pc.green(
      `Cleared active Raycast project (${result.removed.length} unlinked, ${result.linked.length} pinned still active).`,
    ),
  );
}

export async function runRaycastAddCommand(
  skillNames: string[],
): Promise<void> {
  const config = await loadConfig();
  const index = await loadLibraryIndex(config.libraryPath);
  const librarySkills = await listLibrarySkills(config.libraryPath);
  const available = new Set(librarySkills.map((s) => s.name));
  const globalSet = new Set(index.global);

  const missing = skillNames.filter((n) => !available.has(n));
  if (missing.length > 0) {
    console.error(
      pc.red(`Unknown skill(s) not in library: ${missing.join(", ")}`),
    );
    process.exitCode = 1;
    return;
  }

  for (const name of skillNames) {
    if (globalSet.has(name)) {
      console.log(
        pc.yellow(
          `Skipping "${name}" — already global (Raycast already sees it via ~/.agents/skills).`,
        ),
      );
      continue;
    }
    if (!config.raycast.pinned.includes(name)) {
      config.raycast.pinned.push(name);
    }
  }

  await saveConfig(config);
  const result = await syncRaycast(config, index);
  console.log(
    pc.green(
      `Raycast skills synced (${result.linked.length} linked in ~/.config/raycast/skills).`,
    ),
  );
}

export async function runRaycastRmCommand(skillNames: string[]): Promise<void> {
  const config = await loadConfig();
  const index = await loadLibraryIndex(config.libraryPath);
  const removeSet = new Set(skillNames);

  config.raycast.pinned = config.raycast.pinned.filter(
    (name) => !removeSet.has(name),
  );
  await saveConfig(config);

  const result = await syncRaycast(config, index);
  console.log(
    pc.green(
      `Updated Raycast pins (${result.removed.length} unlinked, ${result.linked.length} remaining).`,
    ),
  );
}

export async function runRaycastStatusCommand(): Promise<void> {
  const config = await loadConfig();
  const index = await loadLibraryIndex(config.libraryPath);

  console.log(pc.bold("Raycast bridge (~/.config/raycast/skills)"));
  console.log(
    `  Active project: ${config.raycast.activeProject ? pc.cyan(config.raycast.activeProject) : pc.dim("(none)")}`,
  );
  console.log(
    `  Pinned skills:  ${config.raycast.pinned.length > 0 ? pc.magenta(config.raycast.pinned.join(", ")) : pc.dim("(none)")}`,
  );
  console.log(
    `  Global skills:  ${index.global.length > 0 ? pc.dim(index.global.join(", ")) : pc.dim("(none)")} ${pc.dim("(read via ~/.agents/skills)")}`,
  );
}
