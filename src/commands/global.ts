import * as p from "@clack/prompts";
import pc from "picocolors";
import {
  loadConfig,
  loadMergedProjectManifest,
  removeManifestIfEmpty,
  saveProjectLocalManifest,
  saveProjectManifest,
} from "../config.js";
import { findProjectDuplicates } from "../duplicates.js";
import {
  listLibrarySkills,
  loadLibraryIndex,
  saveLibraryIndex,
} from "../library.js";
import {
  removeProjectSkillFiles,
  syncGlobal,
  syncProject,
  syncRaycast,
} from "../linker.js";
import {
  getProjectLocalManifestPath,
  getProjectManifestPath,
} from "../paths.js";

export async function runGlobalListCommand(): Promise<void> {
  const config = await loadConfig();
  const index = await loadLibraryIndex(config.libraryPath);

  const targets = ["~/.agents/skills"];
  if (config.agents.claude) targets.push("~/.claude/skills");
  if (config.agents.antigravity) targets.push("~/.gemini/config/skills");

  console.log(
    pc.bold(
      `Global skills (${index.global.length}) ${pc.dim(`[${targets.join(" + ")}]`)}:`,
    ),
  );
  if (index.global.length === 0) {
    console.log(pc.dim("  (none)"));
    return;
  }
  for (const name of index.global) {
    console.log(`  • ${pc.cyan(name)}`);
  }
}

export async function runGlobalAddCommand(
  skillNames: string[],
  options: { cleanProjectDuplicates?: boolean },
): Promise<void> {
  const config = await loadConfig();
  const index = await loadLibraryIndex(config.libraryPath);
  const librarySkills = await listLibrarySkills(config.libraryPath);
  const availableNames = new Set(librarySkills.map((s) => s.name));
  const globalSet = new Set(index.global);

  let targets = skillNames;
  if (targets.length === 0) {
    const candidates = librarySkills.filter((s) => !globalSet.has(s.name));
    if (candidates.length === 0) {
      console.log(pc.yellow("All library skills are already global."));
      return;
    }
    const chosen = await p.multiselect({
      message: "Select skills to enable globally:",
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

  // Bidirectional duplicate check: global vs current + tracked projects
  const projectsToCheck = [
    ...new Set([process.cwd(), ...config.trackedProjects]),
  ];
  const dupHits = await findProjectDuplicates(targets, projectsToCheck);
  if (dupHits.length > 0) {
    console.log(
      pc.yellow(
        `Warning: found project duplicate(s) for newly global skill(s):`,
      ),
    );
    for (const hit of dupHits) {
      console.log(`  • ${hit.skill} in ${hit.projectDir}`);
    }

    let shouldClean = Boolean(options.cleanProjectDuplicates);
    if (!shouldClean && skillNames.length === 0) {
      const answer = await p.confirm({
        message: "Remove those duplicate entries from the projects?",
        initialValue: true,
      });
      if (!p.isCancel(answer)) {
        shouldClean = Boolean(answer);
      }
    }

    if (shouldClean) {
      const byProject = new Map<string, string[]>();
      for (const hit of dupHits) {
        const arr = byProject.get(hit.projectDir) ?? [];
        arr.push(hit.skill);
        byProject.set(hit.projectDir, arr);
      }
      for (const [projectDir, skills] of byProject) {
        const existing = await loadMergedProjectManifest(projectDir);
        if (!existing.merged) continue;
        const useClaude = existing.merged.claude ?? config.agents.claude;
        for (const s of skills) {
          if (existing.shared?.skills[s]) delete existing.shared.skills[s];
          if (existing.local?.skills[s]) delete existing.local.skills[s];
          await removeProjectSkillFiles(projectDir, s, useClaude);
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
      }
      console.log(pc.green("Cleaned up project duplicates."));
    }
  }

  for (const name of targets) {
    if (!index.global.includes(name)) {
      index.global.push(name);
    }
  }

  await saveLibraryIndex(config.libraryPath, index);
  const result = await syncGlobal(config, index);
  await syncRaycast(config, index);

  console.log(
    pc.green(
      `Global skills updated (${result.linked.length} linked globally).`,
    ),
  );
}

export async function runGlobalRmCommand(skillNames: string[]): Promise<void> {
  const config = await loadConfig();
  const index = await loadLibraryIndex(config.libraryPath);

  let targets = skillNames;
  if (targets.length === 0) {
    if (index.global.length === 0) {
      console.log(pc.yellow("No global skills to remove."));
      return;
    }
    const chosen = await p.multiselect({
      message: "Select global skills to remove:",
      options: index.global.map((name) => ({ value: name, label: name })),
    });
    if (p.isCancel(chosen)) {
      p.cancel("Cancelled.");
      return;
    }
    targets = chosen as string[];
  }

  const removeSet = new Set(targets);
  index.global = index.global.filter((name) => !removeSet.has(name));
  await saveLibraryIndex(config.libraryPath, index);
  const result = await syncGlobal(config, index);
  await syncRaycast(config, index);

  console.log(
    pc.green(
      `Removed global skill(s). Active global: ${result.linked.length}, unlinked: ${result.removed.length}.`,
    ),
  );
}

export async function runGlobalSyncCommand(): Promise<void> {
  const config = await loadConfig();
  const index = await loadLibraryIndex(config.libraryPath);
  const result = await syncGlobal(config, index);
  await syncRaycast(config, index);

  console.log(
    pc.green(
      `Synced global skills: ${result.linked.length} linked, ${result.removed.length} removed.`,
    ),
  );
  if (result.missing.length > 0) {
    console.log(
      pc.yellow(`Missing in library: ${result.missing.join(", ")}`),
    );
  }
}
