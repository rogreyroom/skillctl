import path from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import {
  loadConfig,
  loadMergedProjectManifest,
  removeManifestIfEmpty,
  saveProjectLocalManifest,
  saveProjectManifest,
  trackProject,
} from "../config.js";
import { findGlobalDuplicates } from "../duplicates.js";
import { listLibrarySkills, loadLibraryIndex } from "../library.js";
import { removeProjectSkillFiles, syncProject } from "../linker.js";
import {
  getProjectLocalManifestPath,
  getProjectManifestPath,
} from "../paths.js";
import type { InstallMode, ProjectManifest } from "../types.js";

export interface AddOptions {
  copy?: boolean;
  link?: boolean;
  force?: boolean;
  dir?: string;
}

export async function runProjectAddCommand(
  skillNames: string[],
  options: AddOptions,
): Promise<void> {
  const projectDir = path.resolve(options.dir ?? process.cwd());
  const config = await loadConfig();
  const index = await loadLibraryIndex(config.libraryPath);
  const librarySkills = await listLibrarySkills(config.libraryPath);
  const availableNames = new Set(librarySkills.map((s) => s.name));
  const globalSet = new Set(index.global);

  const existing = await loadMergedProjectManifest(projectDir);
  const mergedSkills = existing.merged?.skills ?? {};

  let targets = skillNames;
  if (targets.length === 0) {
    const candidates = librarySkills.filter(
      (s) => !mergedSkills[s.name] && !globalSet.has(s.name),
    );
    if (candidates.length === 0) {
      console.log(pc.yellow("No additional library skills available to add."));
      return;
    }
    const chosen = await p.multiselect({
      message: "Select skills to add to this project:",
      options: candidates.map((s) => ({
        value: s.name,
        label: s.name,
        hint: s.description,
      })),
    });
    if (p.isCancel(chosen)) {
      p.cancel("Cancelled.");
      return;
    }
    targets = chosen as string[];
  }

  const missing = targets.filter((n) => !availableNames.has(n));
  if (missing.length > 0) {
    console.error(
      pc.red(`Unknown skill(s) not in library: ${missing.join(", ")}`),
    );
    process.exitCode = 1;
    return;
  }

  // Bidirectional duplicate check: project vs global
  const dups = findGlobalDuplicates(targets, index);
  if (dups.length > 0 && !options.force) {
    console.log(
      pc.yellow(
        `Warning: already active globally (skipping; pass --force to add anyway): ${dups.join(", ")}`,
      ),
    );
    targets = targets.filter((n) => !globalSet.has(n));
  }

  if (targets.length === 0) return;

  const sharedManifest: ProjectManifest = existing.shared ?? {
    skills: {},
    claude: config.agents.claude,
  };
  const localManifest: ProjectManifest = existing.local ?? {
    skills: {},
    claude: config.agents.claude,
    gitExclude: true,
  };

  let touchedShared = false;
  let touchedLocal = false;

  const explicitMode: InstallMode | undefined = options.copy
    ? "copy"
    : options.link
      ? "link"
      : undefined;

  for (const name of targets) {
    const mode = explicitMode ?? index.skills[name]?.defaultMode ?? "link";
    if (mode === "copy") {
      sharedManifest.skills[name] = { mode: "copy" };
      delete localManifest.skills[name];
      touchedShared = true;
    } else {
      localManifest.skills[name] = { mode: "link" };
      delete sharedManifest.skills[name];
      touchedLocal = true;
    }
  }

  if (touchedShared) {
    await saveProjectManifest(projectDir, sharedManifest);
    await removeManifestIfEmpty(getProjectLocalManifestPath(projectDir));
  }
  if (touchedLocal) {
    await saveProjectLocalManifest(projectDir, localManifest);
    await removeManifestIfEmpty(getProjectManifestPath(projectDir));
  }

  await trackProject(config, projectDir);
  const result = await syncProject(projectDir, config);

  console.log(
    pc.green(
      `Added ${targets.join(", ")} (${result.linked.length} personal/linked, ${result.copied.length} repo/copied).`,
    ),
  );
}

export async function runProjectRmCommand(
  skillNames: string[],
  options: { dir?: string },
): Promise<void> {
  const projectDir = path.resolve(options.dir ?? process.cwd());
  const config = await loadConfig();
  const existing = await loadMergedProjectManifest(projectDir);

  if (!existing.merged || Object.keys(existing.merged.skills).length === 0) {
    console.log(pc.yellow("No skills configured in this project."));
    return;
  }

  let targets = skillNames;
  if (targets.length === 0) {
    const chosen = await p.multiselect({
      message: "Select skills to remove from this project:",
      options: Object.entries(existing.merged.skills).map(([name, entry]) => ({
        value: name,
        label: name,
        hint: entry.mode === "copy" ? "repo (copy)" : "personal (link)",
      })),
    });
    if (p.isCancel(chosen)) {
      p.cancel("Cancelled.");
      return;
    }
    targets = chosen as string[];
  }

  const useClaude = existing.merged.claude ?? config.agents.claude;
  const removed: string[] = [];

  for (const name of targets) {
    let found = false;
    if (existing.shared?.skills[name]) {
      delete existing.shared.skills[name];
      found = true;
    }
    if (existing.local?.skills[name]) {
      delete existing.local.skills[name];
      found = true;
    }
    if (found) {
      await removeProjectSkillFiles(projectDir, name, useClaude);
      removed.push(name);
    }
  }

  if (existing.shared) {
    await saveProjectManifest(projectDir, existing.shared);
    await removeManifestIfEmpty(getProjectManifestPath(projectDir));
  }
  if (existing.local) {
    await saveProjectLocalManifest(projectDir, existing.local);
    await removeManifestIfEmpty(getProjectLocalManifestPath(projectDir));
  }

  await syncProject(projectDir, config);

  if (removed.length > 0) {
    console.log(pc.green(`Removed from project: ${removed.join(", ")}`));
  } else {
    console.log(pc.yellow("No matching skills found in project manifest."));
  }
}

export async function runProjectSyncCommand(options: {
  dir?: string;
}): Promise<void> {
  const projectDir = path.resolve(options.dir ?? process.cwd());
  const config = await loadConfig();
  const { merged } = await loadMergedProjectManifest(projectDir);

  if (!merged) {
    console.log(
      pc.yellow(
        `No .skillctl.json or .skillctl.local.json found in ${projectDir}. Run \`skillctl init\` first.`,
      ),
    );
    return;
  }

  await trackProject(config, projectDir);
  const result = await syncProject(projectDir, config);

  console.log(
    pc.green(
      `Synced project: ${result.linked.length} linked, ${result.copied.length} copied, ${result.removed.length} removed.`,
    ),
  );
  if (result.missing.length > 0) {
    console.log(
      pc.yellow(`Missing in library: ${result.missing.join(", ")}`),
    );
  }
}

export async function runListCommand(options: { dir?: string }): Promise<void> {
  const projectDir = path.resolve(options.dir ?? process.cwd());
  const config = await loadConfig();
  const index = await loadLibraryIndex(config.libraryPath);
  const librarySkills = await listLibrarySkills(config.libraryPath);
  const existing = await loadMergedProjectManifest(projectDir);

  const globalSet = new Set(index.global);
  const sharedSkills = existing.shared?.skills ?? {};
  const localSkills = existing.local?.skills ?? {};
  const raycastPinned = new Set(config.raycast.pinned);

  console.log(pc.bold(`Library: ${pc.dim(config.libraryPath)}`));
  if (librarySkills.length === 0) {
    console.log(pc.dim("  (no skills in library)"));
    return;
  }

  for (const skill of librarySkills) {
    const badges: string[] = [];
    if (globalSet.has(skill.name)) badges.push(pc.cyan("global"));
    if (sharedSkills[skill.name]) {
      badges.push(pc.green(`repo:${sharedSkills[skill.name].mode}`));
    }
    if (localSkills[skill.name]) {
      badges.push(pc.blue(`local:${localSkills[skill.name].mode}`));
    }
    if (raycastPinned.has(skill.name)) badges.push(pc.magenta("raycast-pin"));
    if (skill.issues.length > 0) {
      badges.push(pc.red(`${skill.issues.length} issue(s)`));
    }

    const badgeStr = badges.length > 0 ? ` [${badges.join(", ")}]` : "";
    const desc = skill.description ? pc.dim(` — ${skill.description}`) : "";
    console.log(`  • ${pc.bold(skill.name)}${badgeStr}${desc}`);
  }
}
