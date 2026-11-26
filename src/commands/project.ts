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
import {
  discoverProjectUnmanagedSkills,
  expandSkillTargets,
  listLibrarySkills,
  loadLibraryIndex,
} from "../library.js";
import {
  pathExists,
  removeProjectSkillFiles,
  resolveGitInfo,
  syncProject,
} from "../linker.js";
import {
  getProjectAgentsSkillsDir,
  getProjectLocalManifestPath,
  getProjectManifestPath,
} from "../paths.js";
import type { InstallMode, ProjectManifest } from "../types.js";
import { badge, formatSkillRow, sectionHeader } from "../ui.js";

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
  } else {
    const expanded = expandSkillTargets(targets, index);
    if (expanded.unknownGroups.length > 0) {
      console.error(
        pc.red(
          `Unknown skill group(s) in index.yaml: ${expanded.unknownGroups.join(", ")}`,
        ),
      );
      process.exitCode = 1;
      return;
    }
    targets = expanded.resolved;
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

  const index = await loadLibraryIndex(config.libraryPath);
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
  } else {
    const expanded = expandSkillTargets(targets, index);
    if (expanded.unknownGroups.length > 0) {
      console.error(
        pc.red(
          `Unknown skill group(s) in index.yaml: ${expanded.unknownGroups.join(", ")}`,
        ),
      );
      process.exitCode = 1;
      return;
    }
    targets = expanded.resolved;
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
  all?: boolean;
}): Promise<void> {
  const config = await loadConfig();

  if (options.all) {
    if (config.trackedProjects.length === 0) {
      console.log(pc.yellow("No tracked projects to sync."));
      return;
    }
    let syncedCount = 0;
    for (const dir of config.trackedProjects) {
      if (!(await pathExists(dir))) {
        console.log(pc.yellow(`Skipping missing directory: ${dir}`));
        continue;
      }
      const { merged } = await loadMergedProjectManifest(dir);
      if (!merged) continue;
      const result = await syncProject(dir, config);
      syncedCount++;
      console.log(
        `${pc.green("✓")} ${pc.bold(path.basename(dir))} ${pc.dim(`(${dir})`)}: ${result.linked.length} linked, ${result.copied.length} copied, ${result.removed.length} removed`,
      );
    }
    console.log(pc.cyan(`Synced ${syncedCount} tracked project(s).`));
    return;
  }

  const projectDir = path.resolve(options.dir ?? process.cwd());
  let existing = await loadMergedProjectManifest(projectDir);

  // If running in a linked git worktree without .skillctl.local.json, inherit it from the main worktree
  if (!existing.local) {
    const gitInfo = await resolveGitInfo(projectDir);
    if (gitInfo?.isWorktree && gitInfo.mainWorktreeDir !== projectDir) {
      const mainLoaded = await loadMergedProjectManifest(
        gitInfo.mainWorktreeDir,
      );
      if (mainLoaded.local && Object.keys(mainLoaded.local.skills).length > 0) {
        await saveProjectLocalManifest(projectDir, mainLoaded.local);
        existing = await loadMergedProjectManifest(projectDir);
        console.log(
          pc.dim(
            `Inherited .skillctl.local.json from main worktree (${gitInfo.mainWorktreeDir}).`,
          ),
        );
      }
    }
  }

  if (!existing.merged) {
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

export async function runListCommand(options: {
  dir?: string;
  project?: boolean;
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

  const libraryByName = new Map(librarySkills.map((s) => [s.name, s]));
  const globalSet = new Set(index.global);
  const sharedSkills = existing.shared?.skills ?? {};
  const localSkills = existing.local?.skills ?? {};
  const raycastPinned = new Set(config.raycast.pinned);

  if (options.project) {
    const projectSkillNames = [
      ...new Set([...Object.keys(sharedSkills), ...Object.keys(localSkills)]),
    ].sort();

    console.log(
      sectionHeader(
        `Project: ${path.basename(projectDir)}`,
        projectDir,
      ),
    );

    const nameWidth = Math.min(
      30,
      Math.max(
        14,
        ...projectSkillNames.map((n) => n.length),
        ...unmanaged.map((u) => u.name.length),
        ...index.global.map((g) => g.length),
      ),
    );

    if (projectSkillNames.length === 0 && unmanaged.length === 0) {
      console.log(pc.dim("  (no project-specific skills)"));
    } else {
      for (const name of projectSkillNames) {
        const badges: string[] = [];
        if (sharedSkills[name]) {
          badges.push(badge(`repo:${sharedSkills[name].mode}`, "green"));
        }
        if (localSkills[name]) {
          badges.push(badge(`local:${localSkills[name].mode}`, "blue"));
        }
        const installed = await pathExists(
          path.join(getProjectAgentsSkillsDir(projectDir), name),
        );
        if (!installed) {
          badges.push(badge("missing on disk", "red"));
        }
        const meta = libraryByName.get(name);
        if (!meta) {
          badges.push(badge("missing in library", "red"));
        } else if (meta.issues.length > 0) {
          badges.push(badge(`${meta.issues.length} issue(s)`, "red"));
        }

        console.log(
          formatSkillRow({
            name,
            nameWidth,
            badges,
            description: meta?.description,
          }),
        );
      }

      for (const item of unmanaged) {
        console.log(
          formatSkillRow({
            name: item.name,
            nameWidth,
            badges: [badge(`unmanaged: ${item.relativeSource}`, "yellow")],
            description: item.info.description,
          }),
        );
      }
    }

    if (index.global.length > 0) {
      console.log(
        sectionHeader("Global skills", "also active in this project"),
      );
      for (const name of index.global) {
        const meta = libraryByName.get(name);
        console.log(
          formatSkillRow({
            name,
            nameWidth,
            badges: [badge("global", "cyan")],
            description: meta?.description,
          }),
        );
      }
    }
    console.log("");
    return;
  }

  console.log(
    sectionHeader(
      `Skill Library (${librarySkills.length})`,
      config.libraryPath,
    ),
  );
  const nameWidth = Math.min(
    30,
    Math.max(
      14,
      ...librarySkills.map((s) => s.name.length),
      ...unmanaged.map((u) => u.name.length),
    ),
  );

  if (librarySkills.length === 0) {
    console.log(pc.dim("  (no skills in library)"));
  } else {
    for (const skill of librarySkills) {
      const badges: string[] = [];
      if (globalSet.has(skill.name)) badges.push(badge("global", "cyan"));
      if (sharedSkills[skill.name]) {
        badges.push(badge(`repo:${sharedSkills[skill.name].mode}`, "green"));
      }
      if (localSkills[skill.name]) {
        badges.push(badge(`local:${localSkills[skill.name].mode}`, "blue"));
      }
      if (raycastPinned.has(skill.name))
        badges.push(badge("raycast", "magenta"));
      if (skill.issues.length > 0) {
        badges.push(badge(`${skill.issues.length} issue(s)`, "red"));
      }

      console.log(
        formatSkillRow({
          name: skill.name,
          nameWidth,
          badges,
          description: skill.description,
        }),
      );
    }
  }

  if (unmanaged.length > 0) {
    console.log(sectionHeader("Unmanaged skills in current project"));
    for (const item of unmanaged) {
      console.log(
        formatSkillRow({
          name: item.name,
          nameWidth,
          badges: [badge(item.relativeSource, "yellow")],
          description: item.info.description,
        }),
      );
    }
  }
  console.log("");
}
