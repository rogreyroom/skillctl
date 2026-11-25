import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import pc from "picocolors";
import { loadConfig } from "../config.js";
import { ensureLibraryScaffold, inspectSkillDir } from "../library.js";
import {
  getGlobalAgentsSkillsDir,
  getGlobalClaudeSkillsDir,
  getHomeDir,
  getLibrarySkillsDir,
} from "../paths.js";

const execFileAsync = promisify(execFile);

async function findSkillDirsRecursive(
  rootDir: string,
  maxDepth = 3,
): Promise<string[]> {
  const found: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    try {
      await fs.access(path.join(dir, "SKILL.md"));
      found.push(dir);
      return;
    } catch {
      // keep searching
    }

    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), depth + 1);
      }
    }
  }

  await walk(rootDir, 0);
  return found;
}

function normalizeRepoUrl(source: string): string | null {
  if (/^https?:\/\//.test(source) || /^git@/.test(source)) {
    return source;
  }
  // GitHub shorthand: owner/repo
  if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(source)) {
    return `https://github.com/${source}.git`;
  }
  return null;
}

export async function runInstallCommand(
  source: string,
  options: { overwrite?: boolean },
): Promise<void> {
  const config = await loadConfig();
  await ensureLibraryScaffold(config.libraryPath);
  const librarySkillsDir = getLibrarySkillsDir(config.libraryPath);

  let searchRoot = path.resolve(source);
  let tempDir: string | null = null;

  try {
    let isLocal = false;
    try {
      await fs.access(searchRoot);
      isLocal = true;
    } catch {
      isLocal = false;
    }

    if (!isLocal) {
      const repoUrl = normalizeRepoUrl(source);
      if (!repoUrl) {
        console.error(
          pc.red(
            `Source "${source}" is neither an existing local path nor a valid git URL / owner/repo.`,
          ),
        );
        process.exitCode = 1;
        return;
      }
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "skillctl-install-"));
      console.log(pc.dim(`Cloning ${repoUrl}...`));
      await execFileAsync("git", ["clone", "--depth", "1", repoUrl, tempDir]);
      searchRoot = tempDir;
    }

    const skillDirs = await findSkillDirsRecursive(searchRoot);
    if (skillDirs.length === 0) {
      console.error(pc.red(`No SKILL.md folders found in ${source}.`));
      process.exitCode = 1;
      return;
    }

    const installed: string[] = [];
    const skipped: string[] = [];

    for (const dir of skillDirs) {
      const info = await inspectSkillDir(dir);
      const skillName = info.frontmatterName || info.name;
      const destDir = path.join(librarySkillsDir, skillName);

      let exists = false;
      try {
        await fs.access(destDir);
        exists = true;
      } catch {
        exists = false;
      }

      if (exists && !options.overwrite) {
        skipped.push(skillName);
        continue;
      }

      await fs.rm(destDir, { recursive: true, force: true });
      await fs.cp(dir, destDir, { recursive: true });
      installed.push(skillName);
    }

    if (installed.length > 0) {
      console.log(
        pc.green(
          `Installed ${installed.length} skill(s) into library: ${installed.join(", ")}`,
        ),
      );
    }
    if (skipped.length > 0) {
      console.log(
        pc.yellow(
          `Skipped existing skill(s) (pass --overwrite to replace): ${skipped.join(", ")}`,
        ),
      );
    }
  } finally {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
}

export async function runMigrateCommand(options: {
  overwrite?: boolean;
}): Promise<void> {
  const config = await loadConfig();
  await ensureLibraryScaffold(config.libraryPath);
  const librarySkillsDir = getLibrarySkillsDir(config.libraryPath);

  const home = getHomeDir();
  const sources = [
    getGlobalAgentsSkillsDir(),
    getGlobalClaudeSkillsDir(),
    path.join(home, ".cursor", "skills"),
    path.join(home, ".codegpt", "skills"),
  ];
  const migrated: string[] = [];
  const skipped: string[] = [];

  for (const srcRoot of sources) {
    let entries;
    try {
      const stat = await fs.lstat(srcRoot);
      if (stat.isSymbolicLink()) continue;
      entries = await fs.readdir(srcRoot, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = path.join(srcRoot, entry.name);
      try {
        const lstat = await fs.lstat(fullPath);
        if (lstat.isSymbolicLink() || !lstat.isDirectory()) continue;
        await fs.access(path.join(fullPath, "SKILL.md"));
      } catch {
        continue;
      }

      const destDir = path.join(librarySkillsDir, entry.name);
      let exists = false;
      try {
        await fs.access(destDir);
        exists = true;
      } catch {
        exists = false;
      }

      if (exists && !options.overwrite) {
        skipped.push(entry.name);
        continue;
      }

      await fs.rm(destDir, { recursive: true, force: true });
      await fs.cp(fullPath, destDir, { recursive: true });
      migrated.push(entry.name);
    }
  }

  if (migrated.length > 0) {
    console.log(
      pc.green(
        `Migrated ${migrated.length} skill(s) into ${librarySkillsDir}: ${migrated.join(", ")}`,
      ),
    );
  } else {
    console.log(pc.dim("No new skills found to migrate."));
  }
  if (skipped.length > 0) {
    console.log(pc.yellow(`Skipped (already in library): ${skipped.join(", ")}`));
  }
}
