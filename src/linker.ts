import fs from "node:fs/promises";
import path from "node:path";
import {
  loadMergedProjectManifest,
  saveProjectLocalManifest,
  saveProjectManifest,
} from "./config.js";
import { computeDirHash } from "./library.js";
import {
  getGlobalAgentsSkillsDir,
  getGlobalAntigravitySkillsDir,
  getGlobalClaudeSkillsDir,
  getLibrarySkillsDir,
  getProjectAgentsSkillsDir,
  getProjectClaudeSkillsDir,
  getProjectLocalManifestPath,
  getRaycastSkillsDir,
} from "./paths.js";
import type { AppConfig, LibraryIndex, ProjectManifest } from "./types.js";

const GIT_EXCLUDE_START = "# >>> skillctl managed >>>";
const GIT_EXCLUDE_END = "# <<< skillctl managed <<<";

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

export async function isSymlinkToLibrary(
  entryPath: string,
  librarySkillsDir: string,
): Promise<boolean> {
  try {
    const stat = await fs.lstat(entryPath);
    if (!stat.isSymbolicLink()) return false;
    const rawTarget = await fs.readlink(entryPath);
    const resolvedTarget = path.resolve(path.dirname(entryPath), rawTarget);
    const resolvedLib = path.resolve(librarySkillsDir);
    return (
      resolvedTarget === resolvedLib ||
      resolvedTarget.startsWith(resolvedLib + path.sep)
    );
  } catch {
    return false;
  }
}

export async function ensureRealDirectory(dirPath: string): Promise<void> {
  try {
    const stat = await fs.lstat(dirPath);
    if (stat.isSymbolicLink()) {
      throw new Error(
        `"${dirPath}" is currently a symlink. Remove or migrate it first so skillctl can manage individual skill links inside it.`,
      );
    }
    if (!stat.isDirectory()) {
      throw new Error(`"${dirPath}" exists and is not a directory.`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      await fs.mkdir(dirPath, { recursive: true });
      return;
    }
    throw err;
  }
}

export async function ensureSymlink(
  targetPath: string,
  linkPath: string,
): Promise<"created" | "updated" | "unchanged"> {
  await fs.mkdir(path.dirname(linkPath), { recursive: true });
  const resolvedTarget = path.resolve(targetPath);

  try {
    const stat = await fs.lstat(linkPath);
    if (stat.isSymbolicLink()) {
      const existing = await fs.readlink(linkPath);
      const resolvedExisting = path.resolve(path.dirname(linkPath), existing);
      if (resolvedExisting === resolvedTarget) {
        return "unchanged";
      }
      await fs.unlink(linkPath);
      await fs.symlink(resolvedTarget, linkPath, "dir");
      return "updated";
    }
    await fs.rm(linkPath, { recursive: true, force: true });
    await fs.symlink(resolvedTarget, linkPath, "dir");
    return "updated";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      await fs.symlink(resolvedTarget, linkPath, "dir");
      return "created";
    }
    throw err;
  }
}

export async function copySkillDir(
  sourceDir: string,
  destDir: string,
): Promise<string> {
  await fs.mkdir(path.dirname(destDir), { recursive: true });
  await fs.rm(destDir, { recursive: true, force: true });
  await fs.cp(sourceDir, destDir, { recursive: true });
  return computeDirHash(destDir);
}

export interface SyncResult {
  linked: string[];
  copied: string[];
  removed: string[];
  missing: string[];
  skippedGlobal?: string[];
}

async function cleanupStaleLibraryLinks(
  targetDir: string,
  librarySkillsDir: string,
  keepNames: Set<string>,
): Promise<string[]> {
  const removed: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(targetDir, { withFileTypes: true });
  } catch {
    return removed;
  }

  for (const entry of entries) {
    if (keepNames.has(entry.name)) continue;
    const fullPath = path.join(targetDir, entry.name);
    if (await isSymlinkToLibrary(fullPath, librarySkillsDir)) {
      await fs.unlink(fullPath);
      removed.push(entry.name);
    }
  }
  return removed;
}

export async function syncGlobal(
  config: AppConfig,
  index: LibraryIndex,
): Promise<SyncResult> {
  const librarySkillsDir = getLibrarySkillsDir(config.libraryPath);
  const targets = [getGlobalAgentsSkillsDir()];
  if (config.agents.claude) {
    targets.push(getGlobalClaudeSkillsDir());
  }
  if (config.agents.antigravity) {
    targets.push(getGlobalAntigravitySkillsDir());
  }

  const desired = new Set(index.global);
  const linked = new Set<string>();
  const removed = new Set<string>();
  const missing = new Set<string>();

  for (const targetDir of targets) {
    await ensureRealDirectory(targetDir);

    for (const skillName of desired) {
      const sourceDir = path.join(librarySkillsDir, skillName);
      if (!(await pathExists(sourceDir))) {
        missing.add(skillName);
        continue;
      }
      await ensureSymlink(sourceDir, path.join(targetDir, skillName));
      linked.add(skillName);
    }

    const stale = await cleanupStaleLibraryLinks(
      targetDir,
      librarySkillsDir,
      desired,
    );
    for (const s of stale) removed.add(s);
  }

  return {
    linked: [...linked].sort(),
    copied: [],
    removed: [...removed].sort(),
    missing: [...missing].sort(),
  };
}

export interface GitRepoInfo {
  isWorktree: boolean;
  gitDir: string;
  commonGitDir: string;
  mainWorktreeDir: string;
}

export async function resolveGitInfo(
  projectDir: string,
): Promise<GitRepoInfo | null> {
  const dotGit = path.join(projectDir, ".git");
  let stat;
  try {
    stat = await fs.stat(dotGit);
  } catch {
    return null;
  }

  if (stat.isDirectory()) {
    return {
      isWorktree: false,
      gitDir: dotGit,
      commonGitDir: dotGit,
      mainWorktreeDir: path.resolve(projectDir),
    };
  }

  if (stat.isFile()) {
    try {
      const content = await fs.readFile(dotGit, "utf8");
      const match = content.match(/^gitdir:\s*(.+)$/m);
      if (!match?.[1]) return null;
      const gitDir = path.resolve(projectDir, match[1].trim());
      let commonGitDir = gitDir;
      try {
        const commondirRaw = await fs.readFile(
          path.join(gitDir, "commondir"),
          "utf8",
        );
        if (commondirRaw.trim()) {
          commonGitDir = path.resolve(gitDir, commondirRaw.trim());
        }
      } catch {
        // Not a linked worktree or no commondir file
      }
      const mainWorktreeDir =
        path.basename(commonGitDir) === ".git"
          ? path.dirname(commonGitDir)
          : path.resolve(projectDir);
      return {
        isWorktree: commonGitDir !== gitDir,
        gitDir,
        commonGitDir,
        mainWorktreeDir,
      };
    } catch {
      return null;
    }
  }

  return null;
}

export async function syncGitExclude(
  projectDir: string,
  patterns: string[],
): Promise<boolean> {
  const gitInfo = await resolveGitInfo(projectDir);
  if (!gitInfo) return false;

  const excludePath = path.join(gitInfo.commonGitDir, "info", "exclude");
  await fs.mkdir(path.dirname(excludePath), { recursive: true });

  let existing = "";
  try {
    existing = await fs.readFile(excludePath, "utf8");
  } catch {
    existing = "";
  }

  const startIdx = existing.indexOf(GIT_EXCLUDE_START);
  const endIdx = existing.indexOf(GIT_EXCLUDE_END);
  let base = existing;
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = existing.slice(0, startIdx).trimEnd();
    const after = existing
      .slice(endIdx + GIT_EXCLUDE_END.length)
      .replace(/^\r?\n/, "");
    base = [before, after].filter(Boolean).join("\n");
  } else {
    base = existing.trimEnd();
  }

  const uniquePatterns = [...new Set(patterns)].sort();
  let nextContent = base;
  if (uniquePatterns.length > 0) {
    const block = [
      GIT_EXCLUDE_START,
      ...uniquePatterns,
      GIT_EXCLUDE_END,
    ].join("\n");
    nextContent = base ? `${base}\n\n${block}\n` : `${block}\n`;
  } else if (nextContent && !nextContent.endsWith("\n")) {
    nextContent += "\n";
  }

  await fs.writeFile(excludePath, nextContent, "utf8");
  return true;
}

export async function syncProject(
  projectDir: string,
  config: AppConfig,
  manifestOverride?: ProjectManifest,
): Promise<SyncResult> {
  const loaded = await loadMergedProjectManifest(projectDir);
  const manifest = manifestOverride ?? loaded.merged;
  if (!manifest) {
    return { linked: [], copied: [], removed: [], missing: [] };
  }

  const librarySkillsDir = getLibrarySkillsDir(config.libraryPath);
  const useClaude = manifest.claude ?? config.agents.claude;

  const targets: Array<{ dir: string; relPrefix: string }> = [
    { dir: getProjectAgentsSkillsDir(projectDir), relPrefix: ".agents/skills" },
  ];
  if (useClaude) {
    targets.push({
      dir: getProjectClaudeSkillsDir(projectDir),
      relPrefix: ".claude/skills",
    });
  }

  const desired = new Set(Object.keys(manifest.skills));
  const linked = new Set<string>();
  const copied = new Set<string>();
  const removed = new Set<string>();
  const missing = new Set<string>();
  const gitExcludePatterns: string[] = [];
  let sharedDirty = false;
  let localDirty = false;
  let overrideDirty = false;

  if (await pathExists(getProjectLocalManifestPath(projectDir))) {
    gitExcludePatterns.push(".skillctl.local.json");
  }

  for (const target of targets) {
    await ensureRealDirectory(target.dir);

    for (const [skillName, entry] of Object.entries(manifest.skills)) {
      const sourceDir = path.join(librarySkillsDir, skillName);
      if (!(await pathExists(sourceDir))) {
        missing.add(skillName);
        continue;
      }

      const destPath = path.join(target.dir, skillName);
      if (entry.mode === "copy") {
        const hash = await copySkillDir(sourceDir, destPath);
        if (entry.hash !== hash) {
          entry.hash = hash;
          if (manifestOverride) {
            overrideDirty = true;
          } else if (loaded.local?.skills[skillName]) {
            loaded.local.skills[skillName].hash = hash;
            localDirty = true;
          } else if (loaded.shared?.skills[skillName]) {
            loaded.shared.skills[skillName].hash = hash;
            sharedDirty = true;
          }
        }
        copied.add(skillName);
      } else {
        await ensureSymlink(sourceDir, destPath);
        linked.add(skillName);
        gitExcludePatterns.push(`${target.relPrefix}/${skillName}`);
      }
    }

    const stale = await cleanupStaleLibraryLinks(
      target.dir,
      librarySkillsDir,
      desired,
    );
    for (const s of stale) removed.add(s);
  }

  if (manifest.gitExclude !== false) {
    await syncGitExclude(projectDir, gitExcludePatterns);
  } else {
    await syncGitExclude(projectDir, []);
  }

  if (overrideDirty && manifestOverride) {
    await saveProjectManifest(projectDir, manifestOverride);
  }
  if (sharedDirty && loaded.shared) {
    await saveProjectManifest(projectDir, loaded.shared);
  }
  if (localDirty && loaded.local) {
    await saveProjectLocalManifest(projectDir, loaded.local);
  }

  return {
    linked: [...linked].sort(),
    copied: [...copied].sort(),
    removed: [...removed].sort(),
    missing: [...missing].sort(),
  };
}

export async function removeProjectSkillFiles(
  projectDir: string,
  skillName: string,
  includeClaude: boolean,
): Promise<void> {
  const dirs = [getProjectAgentsSkillsDir(projectDir)];
  if (includeClaude) dirs.push(getProjectClaudeSkillsDir(projectDir));
  for (const dir of dirs) {
    const p = path.join(dir, skillName);
    await fs.rm(p, { recursive: true, force: true });
  }
}

export async function syncRaycast(
  config: AppConfig,
  index: LibraryIndex,
): Promise<SyncResult> {
  const librarySkillsDir = getLibrarySkillsDir(config.libraryPath);
  const raycastDir = getRaycastSkillsDir();
  await ensureRealDirectory(raycastDir);

  const globalSet = new Set(index.global);
  const candidateSkills = new Set<string>(config.raycast.pinned);

  if (config.raycast.activeProject) {
    const { merged } = await loadMergedProjectManifest(
      config.raycast.activeProject,
    );
    if (merged) {
      for (const skillName of Object.keys(merged.skills)) {
        candidateSkills.add(skillName);
      }
    }
  }

  const desired = new Set<string>();
  const skippedGlobal: string[] = [];
  for (const skill of candidateSkills) {
    if (globalSet.has(skill)) {
      skippedGlobal.push(skill);
    } else {
      desired.add(skill);
    }
  }

  const linked: string[] = [];
  const missing: string[] = [];

  for (const skillName of desired) {
    const sourceDir = path.join(librarySkillsDir, skillName);
    if (!(await pathExists(sourceDir))) {
      missing.push(skillName);
      continue;
    }
    await ensureSymlink(sourceDir, path.join(raycastDir, skillName));
    linked.push(skillName);
  }

  const removed = await cleanupStaleLibraryLinks(
    raycastDir,
    librarySkillsDir,
    desired,
  );

  return {
    linked: linked.sort(),
    copied: [],
    removed: removed.sort(),
    missing: missing.sort(),
    skippedGlobal: skippedGlobal.sort(),
  };
}
