import fs from "node:fs/promises";
import path from "node:path";
import {
  loadMergedProjectManifest,
  removeManifestIfEmpty,
  saveProjectLocalManifest,
  saveProjectManifest,
} from "./config.js";
import {
  computeDirHash,
  listLibrarySkills,
  loadLibraryIndex,
} from "./library.js";
import {
  copySkillDir,
  pathExists,
  removeProjectSkillFiles,
  syncProject,
} from "./linker.js";
import {
  getGlobalAgentsSkillsDir,
  getGlobalAntigravitySkillsDir,
  getGlobalClaudeSkillsDir,
  getGlobalCursorSkillsDir,
  getLibrarySkillsDir,
  getProjectAgentsSkillsDir,
  getProjectClaudeSkillsDir,
  getProjectLocalManifestPath,
  getProjectManifestPath,
  getRaycastSkillsDir,
} from "./paths.js";
import type { AppConfig, DoctorIssue } from "./types.js";

async function checkBrokenSymlinks(
  dirPath: string,
  scope: DoctorIssue["scope"],
  issues: DoctorIssue[],
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    let lstat;
    try {
      lstat = await fs.lstat(fullPath);
    } catch {
      continue;
    }
    if (!lstat.isSymbolicLink()) continue;

    try {
      await fs.stat(fullPath);
    } catch {
      issues.push({
        severity: "error",
        scope,
        code: "broken-symlink",
        message: `Broken symlink: ${fullPath}`,
        fixable: true,
        fix: async () => {
          await fs.unlink(fullPath);
        },
      });
    }
  }
}

export async function runDoctor(
  config: AppConfig,
  projectDir?: string,
): Promise<DoctorIssue[]> {
  const issues: DoctorIssue[] = [];
  const librarySkillsDir = getLibrarySkillsDir(config.libraryPath);
  const index = await loadLibraryIndex(config.libraryPath);

  // 1. Validate library skills (SKILL.md format, kebab-case, Raycast compatibility)
  const librarySkills = await listLibrarySkills(config.libraryPath);
  const availableNames = new Set(librarySkills.map((s) => s.name));

  for (const skill of librarySkills) {
    for (const valIssue of skill.issues) {
      issues.push({
        severity:
          valIssue.code === "missing-description" ? "warn" : "error",
        scope: "library",
        code: valIssue.code,
        message: `[${skill.name}] ${valIssue.message}`,
        fixable: false,
      });
    }
  }

  // 2. Check index.yaml references to missing skills
  for (const globalSkill of index.global) {
    if (!availableNames.has(globalSkill)) {
      issues.push({
        severity: "error",
        scope: "global",
        code: "missing-library-skill",
        message: `Global skill "${globalSkill}" in index.yaml does not exist in ${librarySkillsDir}.`,
        fixable: false,
      });
    }
  }

  // 3. Broken symlinks in global and raycast folders
  await checkBrokenSymlinks(getGlobalAgentsSkillsDir(), "global", issues);
  if (config.agents.claude) {
    await checkBrokenSymlinks(getGlobalClaudeSkillsDir(), "global", issues);
  }
  if (config.agents.antigravity) {
    await checkBrokenSymlinks(
      getGlobalAntigravitySkillsDir(),
      "global",
      issues,
    );
  }
  await checkBrokenSymlinks(getGlobalCursorSkillsDir(), "global", issues);
  await checkBrokenSymlinks(getRaycastSkillsDir(), "raycast", issues);

  // 3b. Legacy/stale duplicates in ~/.cursor/skills/ and unmanaged copies in ~/.agents/skills/
  const globalSet = new Set(index.global);
  try {
    const cursorDir = getGlobalCursorSkillsDir();
    const cursorEntries = await fs.readdir(cursorDir, { withFileTypes: true });
    for (const entry of cursorEntries) {
      if (entry.name.startsWith(".")) continue;
      if (!availableNames.has(entry.name)) continue;
      const dupPath = path.join(cursorDir, entry.name);
      issues.push({
        severity: "warn",
        scope: "global",
        code: "legacy-cursor-duplicate",
        message: `Legacy skill "${entry.name}" in ~/.cursor/skills/ duplicates your central library (Cursor already reads ~/.agents/skills/ and .agents/skills/).`,
        fixable: true,
        fix: async () => {
          await fs.rm(dupPath, { recursive: true, force: true });
        },
      });
    }
  } catch {
    // ~/.cursor/skills may not exist
  }

  try {
    const agentsDir = getGlobalAgentsSkillsDir();
    const agentsEntries = await fs.readdir(agentsDir, { withFileTypes: true });
    for (const entry of agentsEntries) {
      if (entry.name.startsWith(".")) continue;
      if (globalSet.has(entry.name) || !availableNames.has(entry.name)) continue;
      const dupPath = path.join(agentsDir, entry.name);
      const lstat = await fs.lstat(dupPath);
      if (!lstat.isSymbolicLink() && lstat.isDirectory()) {
        issues.push({
          severity: "warn",
          scope: "global",
          code: "legacy-global-copy",
          message: `Unmanaged folder "${entry.name}" in ~/.agents/skills/ duplicates your central library but is not in global.`,
          fixable: true,
          fix: async () => {
            await fs.rm(dupPath, { recursive: true, force: true });
          },
        });
      }
    }
  } catch {
    // ~/.agents/skills may not exist
  }

  // 4. Raycast duplicates with global
  try {
    const raycastEntries = await fs.readdir(getRaycastSkillsDir());
    for (const name of raycastEntries) {
      if (globalSet.has(name)) {
        const dupPath = path.join(getRaycastSkillsDir(), name);
        issues.push({
          severity: "warn",
          scope: "raycast",
          code: "raycast-global-duplicate",
          message: `"${name}" is in both ~/.agents/skills (global) and ~/.config/raycast/skills.`,
          fixable: true,
          fix: async () => {
            await fs.rm(dupPath, { recursive: true, force: true });
          },
        });
      }
    }
  } catch {
    // Raycast dir may not exist yet
  }

  // 5. Current project checks (if in a project with .skillctl.json or .agents/skills)
  if (projectDir) {
    await checkBrokenSymlinks(
      getProjectAgentsSkillsDir(projectDir),
      "project",
      issues,
    );
    await checkBrokenSymlinks(
      getProjectClaudeSkillsDir(projectDir),
      "project",
      issues,
    );

    const { merged: manifest } = await loadMergedProjectManifest(projectDir);
    if (manifest) {
      const useClaude = manifest.claude ?? config.agents.claude;

      for (const [skillName, entry] of Object.entries(manifest.skills)) {
        // Missing in library
        if (!availableNames.has(skillName)) {
          issues.push({
            severity: "error",
            scope: "project",
            code: "missing-library-skill",
            message: `Project skill "${skillName}" is not in library (${librarySkillsDir}).`,
            fixable: false,
          });
          continue;
        }

        // Duplicate with global
        if (globalSet.has(skillName)) {
          issues.push({
            severity: "warn",
            scope: "project",
            code: "project-global-duplicate",
            message: `"${skillName}" is enabled both globally and in this project.`,
            fixable: true,
            fix: async () => {
              const latest = await loadMergedProjectManifest(projectDir);
              if (latest.shared?.skills[skillName]) {
                delete latest.shared.skills[skillName];
                await saveProjectManifest(projectDir, latest.shared);
                await removeManifestIfEmpty(getProjectManifestPath(projectDir));
              }
              if (latest.local?.skills[skillName]) {
                delete latest.local.skills[skillName];
                await saveProjectLocalManifest(projectDir, latest.local);
                await removeManifestIfEmpty(
                  getProjectLocalManifestPath(projectDir),
                );
              }
              await removeProjectSkillFiles(projectDir, skillName, useClaude);
              await syncProject(projectDir, config);
            },
          });
        }

        // Missing link/copy on disk
        const installedPath = path.join(
          getProjectAgentsSkillsDir(projectDir),
          skillName,
        );
        if (!(await pathExists(installedPath))) {
          issues.push({
            severity: "warn",
            scope: "project",
            code: "missing-installed-skill",
            message: `Project skill "${skillName}" is configured in project manifest but missing from .agents/skills/.`,
            fixable: true,
            fix: async () => {
              await syncProject(projectDir, config);
            },
          });
          continue;
        }

        // Drift detection for copied skills
        if (entry.mode === "copy") {
          const librarySkillDir = path.join(librarySkillsDir, skillName);
          try {
            const libHash = await computeDirHash(librarySkillDir);
            const localHash = await computeDirHash(installedPath);
            if (libHash !== localHash) {
              issues.push({
                severity: "warn",
                scope: "project",
                code: "copied-skill-drift",
                message: `Copied skill "${skillName}" differs from the library version (local: ${localHash}, library: ${libHash}).`,
                fixable: true,
                fix: async () => {
                  const newHash = await copySkillDir(
                    librarySkillDir,
                    installedPath,
                  );
                  if (useClaude) {
                    await copySkillDir(
                      librarySkillDir,
                      path.join(
                        getProjectClaudeSkillsDir(projectDir),
                        skillName,
                      ),
                    );
                  }
                  const latest = await loadMergedProjectManifest(projectDir);
                  if (latest.shared?.skills[skillName]) {
                    latest.shared.skills[skillName].hash = newHash;
                    await saveProjectManifest(projectDir, latest.shared);
                  }
                  if (latest.local?.skills[skillName]) {
                    latest.local.skills[skillName].hash = newHash;
                    await saveProjectLocalManifest(projectDir, latest.local);
                  }
                },
              });
            }
          } catch {
            // ignore hash errors on unreadable dir
          }
        }
      }
    }
  }

  return issues;
}
