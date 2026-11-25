import fs from "node:fs/promises";
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
import { detectProjectSkills } from "../detect.js";
import { findGlobalDuplicates } from "../duplicates.js";
import {
  discoverProjectUnmanagedSkills,
  importSkillDirToLibrary,
  listLibrarySkills,
  loadLibraryIndex,
} from "../library.js";
import { syncProject } from "../linker.js";
import {
  getProjectLocalManifestPath,
  getProjectManifestPath,
} from "../paths.js";
import type { InstallMode, ProjectManifest } from "../types.js";

export interface InitOptions {
  copy?: boolean;
  link?: boolean;
  claude?: boolean;
  yes?: boolean;
  dir?: string;
}

export async function runInitCommand(options: InitOptions): Promise<void> {
  const projectDir = path.resolve(options.dir ?? process.cwd());
  const config = await loadConfig();
  const index = await loadLibraryIndex(config.libraryPath);
  const existing = await loadMergedProjectManifest(projectDir);

  // Track any skills imported from the project during this init run
  const importedModes = new Map<string, InstallMode>();
  const removedImported = new Set<string>();

  if (!options.yes) {
    p.intro(pc.cyan(`skillctl init — ${path.basename(projectDir)}`));

    // Step 1: Discover project skills not yet in the central library
    const unmanaged = await discoverProjectUnmanagedSkills(
      projectDir,
      config.libraryPath,
    );

    if (unmanaged.length > 0) {
      const listPreview = unmanaged
        .map(
          (u) =>
            `  ${pc.yellow("•")} ${pc.bold(u.name)} ${pc.dim(`(${u.relativeSource})`)}`,
        )
        .join("\n");
      p.log.info(
        `Found ${unmanaged.length} skill(s) in this project that are not in your library:\n${listPreview}`,
      );

      const toSave = await p.multiselect({
        message: "Save any of these project skills into your central library?",
        options: unmanaged.map((u) => ({
          value: u.name,
          label: u.name,
          hint: u.relativeSource,
        })),
        required: false,
      });

      if (p.isCancel(toSave)) {
        p.cancel("Init cancelled.");
        return;
      }

      const saveNames = toSave as string[];
      if (saveNames.length > 0) {
        const unmanagedByName = new Map(unmanaged.map((u) => [u.name, u]));
        for (const name of saveNames) {
          const item = unmanagedByName.get(name);
          if (item) {
            await importSkillDirToLibrary(
              item.sourcePath,
              config.libraryPath,
              item.name,
            );
          }
        }
        p.log.success(
          `Saved ${saveNames.length} skill(s) to library: ${saveNames.join(", ")}`,
        );

        const disposition = await p.select({
          message:
            "What should happen to those saved skill(s) in this project?",
          options: [
            {
              value: "keep-repo",
              label: "Keep in repo (shared / copy)",
              hint: "Tracked in .skillctl.json so teammates keep them",
            },
            {
              value: "keep-local",
              label: "Replace with personal symlink (git-excluded)",
              hint: "Tracked in .skillctl.local.json and excluded via .git/info/exclude",
            },
            {
              value: "remove",
              label: "Remove from project (keep in library only)",
              hint: "Deletes the project folder copy now that it's saved in your library",
            },
          ],
          initialValue: "keep-repo",
        });

        if (p.isCancel(disposition)) {
          p.cancel("Init cancelled.");
          return;
        }

        for (const name of saveNames) {
          const item = unmanagedByName.get(name);
          if (!item) continue;
          if (disposition === "remove") {
            await fs.rm(item.sourcePath, { recursive: true, force: true });
            removedImported.add(name);
          } else if (disposition === "keep-repo") {
            importedModes.set(name, "copy");
          } else if (disposition === "keep-local") {
            // If it came from .cursor/skills or another path, remove old copy so symlink takes over in .agents/skills
            await fs.rm(item.sourcePath, { recursive: true, force: true });
            importedModes.set(name, "link");
          }
        }
      }
    }
  }

  const librarySkills = await listLibrarySkills(config.libraryPath);

  if (librarySkills.length === 0) {
    console.log(
      pc.yellow(
        `No skills found in library (${config.libraryPath}/skills). Add or import skills first (e.g. \`skillctl setup\` or \`skillctl install <repo>\`).`,
      ),
    );
    return;
  }

  const availableNames = new Set(librarySkills.map((s) => s.name));
  const globalSet = new Set(index.global);
  const matches = await detectProjectSkills(projectDir, index, availableNames);
  const matchMap = new Map(matches.map((m) => [m.skill, m.reasons]));

  const defaultMode: InstallMode = options.copy ? "copy" : "link";

  if (options.yes) {
    const selected = matches
      .map((m) => m.skill)
      .filter((name) => !globalSet.has(name));

    const sharedManifest: ProjectManifest = {
      skills: { ...(existing.shared?.skills ?? {}) },
      claude: options.claude ?? existing.shared?.claude ?? config.agents.claude,
    };
    const localManifest: ProjectManifest = {
      skills: { ...(existing.local?.skills ?? {}) },
      claude: options.claude ?? existing.local?.claude ?? config.agents.claude,
      gitExclude: true,
    };

    for (const skill of selected) {
      const mode = index.skills[skill]?.defaultMode ?? defaultMode;
      if (mode === "copy") {
        sharedManifest.skills[skill] = { mode: "copy" };
      } else {
        localManifest.skills[skill] = { mode: "link" };
      }
    }

    if (Object.keys(sharedManifest.skills).length > 0) {
      await saveProjectManifest(projectDir, sharedManifest);
    }
    if (Object.keys(localManifest.skills).length > 0) {
      await saveProjectLocalManifest(projectDir, localManifest);
    }
    await trackProject(config, projectDir);
    const result = await syncProject(projectDir, config);
    console.log(
      pc.green(
        `Initialized ${path.basename(projectDir)}: ${result.linked.length} linked, ${result.copied.length} copied.`,
      ),
    );
    return;
  }

  if (matches.length > 0) {
    const summary = matches
      .map(
        (m) =>
          `  ${pc.green("•")} ${pc.bold(m.skill)} ${pc.dim(`(${m.reasons.join(", ")})`)}${globalSet.has(m.skill) ? pc.yellow(" [already global]") : ""}`,
      )
      .join("\n");
    p.log.info(`Detected matching skills:\n${summary}`);
  } else {
    p.log.info("No automatic matches found from index.yaml rules.");
  }

  const nonGlobalSkills = librarySkills.filter((s) => !globalSet.has(s.name));
  const preselected = new Set<string>(
    existing.merged ? Object.keys(existing.merged.skills) : [],
  );
  for (const m of matches) {
    if (!globalSet.has(m.skill)) {
      preselected.add(m.skill);
    }
  }
  for (const name of importedModes.keys()) {
    if (!globalSet.has(name)) {
      preselected.add(name);
    }
  }
  for (const name of removedImported) {
    preselected.delete(name);
  }

  if (nonGlobalSkills.length === 0) {
    p.log.warn("All skills in your library are already enabled globally.");
    p.outro("Nothing to add to this project.");
    return;
  }

  const chosen = await p.multiselect({
    message: "Select skills to enable for this project:",
    options: nonGlobalSkills.map((skill) => {
      const reasons = matchMap.get(skill.name);
      const hintParts: string[] = [];
      if (reasons) hintParts.push(`matched: ${reasons.join(", ")}`);
      if (importedModes.has(skill.name)) hintParts.push("imported");
      if (skill.description) {
        hintParts.push(
          skill.description.length > 60
            ? skill.description.slice(0, 57) + "..."
            : skill.description,
        );
      }
      return {
        value: skill.name,
        label: skill.name,
        hint: hintParts.join(" — ") || undefined,
      };
    }),
    initialValues: [...preselected].filter((name) => !globalSet.has(name)),
    required: false,
  });

  if (p.isCancel(chosen)) {
    p.cancel("Init cancelled.");
    return;
  }

  const selectedNames = chosen as string[];

  const dups = findGlobalDuplicates(selectedNames, index);
  if (dups.length > 0) {
    p.log.warn(
      `Already active globally (will skip duplicates): ${dups.join(", ")}`,
    );
  }
  const filteredNames = selectedNames.filter((n) => !globalSet.has(n));

  // Decide per-skill mode: all personal (link), all shared (copy), or mixed
  const skillModes = new Map<string, InstallMode>();
  if (filteredNames.length > 0) {
    if (options.copy) {
      for (const n of filteredNames) skillModes.set(n, "copy");
    } else if (options.link) {
      for (const n of filteredNames) skillModes.set(n, "link");
    } else {
      const strategy = await p.select({
        message: "How should these skills be stored in this project?",
        options: [
          {
            value: "link",
            label: "All personal (symlink, excluded from git)",
            hint: "Saved in .skillctl.local.json + .git/info/exclude",
          },
          {
            value: "copy",
            label: "All shared in repo (copy, committed to git)",
            hint: "Saved in .skillctl.json for teammates & CI",
          },
          {
            value: "mixed",
            label: "Mixed (choose which belong in the repo vs personal)",
            hint: "Repo skills → .skillctl.json (copy), personal → .skillctl.local.json (link)",
          },
        ],
        initialValue:
          importedModes.size > 0 &&
          [...importedModes.values()].includes("copy")
            ? "mixed"
            : "link",
      });
      if (p.isCancel(strategy)) {
        p.cancel("Init cancelled.");
        return;
      }

      if (strategy === "link") {
        for (const n of filteredNames) skillModes.set(n, "link");
      } else if (strategy === "copy") {
        for (const n of filteredNames) skillModes.set(n, "copy");
      } else {
        const preShared = filteredNames.filter(
          (n) =>
            importedModes.get(n) === "copy" ||
            existing.shared?.skills[n]?.mode === "copy",
        );
        const sharedChoice = await p.multiselect({
          message:
            "Select skills to COMMIT to the repo (unselected stay personal & git-excluded):",
          options: filteredNames.map((n) => ({
            value: n,
            label: n,
          })),
          initialValues: preShared,
          required: false,
        });
        if (p.isCancel(sharedChoice)) {
          p.cancel("Init cancelled.");
          return;
        }
        const sharedSet = new Set(sharedChoice as string[]);
        for (const n of filteredNames) {
          skillModes.set(n, sharedSet.has(n) ? "copy" : "link");
        }
      }
    }
  }

  const hasPersonal = [...skillModes.values()].includes("link");
  let gitExclude = true;
  if (hasPersonal) {
    const excludeAnswer = await p.confirm({
      message:
        "Exclude personal skills & .skillctl.local.json via .git/info/exclude?",
      initialValue: existing.merged?.gitExclude ?? true,
    });
    if (p.isCancel(excludeAnswer)) {
      p.cancel("Init cancelled.");
      return;
    }
    gitExclude = Boolean(excludeAnswer);
  }

  const claudeAnswer =
    options.claude !== undefined
      ? options.claude
      : await p.confirm({
          message: "Also sync into .claude/skills/ for Claude Code?",
          initialValue: existing.merged?.claude ?? config.agents.claude,
        });
  if (p.isCancel(claudeAnswer)) {
    p.cancel("Init cancelled.");
    return;
  }

  const sharedManifest: ProjectManifest = {
    skills: {},
    claude: Boolean(claudeAnswer),
  };
  const localManifest: ProjectManifest = {
    skills: {},
    claude: Boolean(claudeAnswer),
    gitExclude,
  };

  for (const [skillName, mode] of skillModes) {
    const prevHash =
      existing.shared?.skills[skillName]?.hash ??
      existing.local?.skills[skillName]?.hash;
    if (mode === "copy") {
      sharedManifest.skills[skillName] = {
        mode: "copy",
        ...(prevHash ? { hash: prevHash } : {}),
      };
    } else {
      localManifest.skills[skillName] = { mode: "link" };
    }
  }

  if (Object.keys(sharedManifest.skills).length > 0) {
    await saveProjectManifest(projectDir, sharedManifest);
  } else {
    await removeManifestIfEmpty(getProjectManifestPath(projectDir));
  }

  if (Object.keys(localManifest.skills).length > 0) {
    await saveProjectLocalManifest(projectDir, localManifest);
  } else {
    await removeManifestIfEmpty(getProjectLocalManifestPath(projectDir));
  }

  await trackProject(config, projectDir);
  const result = await syncProject(projectDir, config);

  const parts: string[] = [];
  if (result.linked.length > 0)
    parts.push(`${result.linked.length} personal (linked)`);
  if (result.copied.length > 0)
    parts.push(`${result.copied.length} repo (copied)`);
  if (result.removed.length > 0) parts.push(`${result.removed.length} removed`);

  p.outro(
    `${pc.green("Synced project skills")} (${parts.join(", ") || "none"}).\n` +
      `  Tip: run ${pc.cyan("skillctl raycast use")} anytime to expose this project's skills to Raycast.`,
  );
}
