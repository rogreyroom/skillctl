import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import {
  getLibraryIndexPath,
  getLibrarySkillsDir,
  getProjectAgentsSkillsDir,
  getProjectClaudeSkillsDir,
  getProjectCursorSkillsDir,
} from "./paths.js";
import type {
  LibraryIndex,
  SkillInfo,
  SkillValidationIssue,
} from "./types.js";

const KEBAB_CASE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function createStarterIndex(): LibraryIndex {
  return {
    global: [],
    skills: {},
  };
}

export async function ensureLibraryScaffold(
  libraryPath: string,
): Promise<void> {
  const skillsDir = getLibrarySkillsDir(libraryPath);
  const indexPath = getLibraryIndexPath(libraryPath);
  await fs.mkdir(skillsDir, { recursive: true });
  try {
    await fs.access(indexPath);
  } catch {
    const starter = `# skillctl library index
# Skills listed under "global" are linked into ~/.agents/skills/
# Rules under "skills" are used by \`skillctl init\` to suggest matching skills per project.
global: []
skills: {}
`;
    await fs.writeFile(indexPath, starter, "utf8");
  }
}

export async function loadLibraryIndex(
  libraryPath: string,
): Promise<LibraryIndex> {
  const indexPath = getLibraryIndexPath(libraryPath);
  try {
    const raw = await fs.readFile(indexPath, "utf8");
    const parsed = (YAML.parse(raw) ?? {}) as Partial<LibraryIndex>;
    return {
      global: Array.isArray(parsed.global)
        ? [...new Set(parsed.global.map(String))]
        : [],
      skills:
        parsed.skills && typeof parsed.skills === "object"
          ? parsed.skills
          : {},
    };
  } catch {
    return createStarterIndex();
  }
}

export async function saveLibraryIndex(
  libraryPath: string,
  index: LibraryIndex,
): Promise<void> {
  await fs.mkdir(path.dirname(getLibraryIndexPath(libraryPath)), {
    recursive: true,
  });
  const normalized: LibraryIndex = {
    global: [...new Set(index.global)].sort(),
    skills: Object.fromEntries(
      Object.entries(index.skills).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
  await fs.writeFile(
    getLibraryIndexPath(libraryPath),
    YAML.stringify(normalized),
    "utf8",
  );
}

export function parseSkillFrontmatter(content: string): {
  name?: string;
  description?: string;
  error?: string;
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    return { error: "Missing YAML frontmatter delimited by ---" };
  }
  try {
    const data = YAML.parse(match[1]) as Record<string, unknown> | null;
    if (!data || typeof data !== "object") {
      return { error: "Frontmatter must be a YAML mapping" };
    }
    return {
      name: typeof data.name === "string" ? data.name.trim() : undefined,
      description:
        typeof data.description === "string"
          ? data.description.trim()
          : undefined,
    };
  } catch (err) {
    return {
      error: `Invalid YAML frontmatter: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function inspectSkillDir(
  skillDir: string,
): Promise<SkillInfo> {
  const folderName = path.basename(skillDir);
  const skillMdPath = path.join(skillDir, "SKILL.md");
  const issues: SkillValidationIssue[] = [];

  if (!KEBAB_CASE_RE.test(folderName)) {
    issues.push({
      code: "invalid-name-format",
      message: `Folder name "${folderName}" must be kebab-case (lowercase letters, digits, hyphens).`,
    });
  }

  let content: string;
  try {
    content = await fs.readFile(skillMdPath, "utf8");
  } catch {
    issues.push({
      code: "missing-skill-md",
      message: `Missing SKILL.md in ${skillDir}.`,
    });
    return {
      name: folderName,
      dirPath: skillDir,
      skillMdPath,
      issues,
    };
  }

  const parsed = parseSkillFrontmatter(content);
  if (parsed.error) {
    issues.push({
      code: "invalid-frontmatter",
      message: parsed.error,
    });
  } else {
    if (!parsed.name) {
      issues.push({
        code: "missing-name",
        message: "SKILL.md frontmatter is missing a `name` field.",
      });
    } else {
      if (!KEBAB_CASE_RE.test(parsed.name)) {
        issues.push({
          code: "invalid-name-format",
          message: `Frontmatter name "${parsed.name}" must be kebab-case.`,
        });
      }
      if (parsed.name !== folderName) {
        issues.push({
          code: "name-mismatch",
          message: `Folder name "${folderName}" does not match frontmatter name "${parsed.name}" (Raycast will ignore it).`,
        });
      }
    }

    if (!parsed.description) {
      issues.push({
        code: "missing-description",
        message: "SKILL.md frontmatter is missing a `description` field.",
      });
    }
  }

  return {
    name: folderName,
    dirPath: skillDir,
    skillMdPath,
    frontmatterName: parsed.name,
    description: parsed.description,
    issues,
  };
}

export async function listLibrarySkills(
  libraryPath: string,
): Promise<SkillInfo[]> {
  const skillsDir = getLibrarySkillsDir(libraryPath);
  let entries;
  try {
    entries = await fs.readdir(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const results: SkillInfo[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const fullPath = path.join(skillsDir, entry.name);
    try {
      const stat = await fs.stat(fullPath);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }
    results.push(await inspectSkillDir(fullPath));
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

export async function computeDirHash(dirPath: string): Promise<string> {
  const hash = crypto.createHash("sha256");

  async function walk(currentDir: string, relBase: string): Promise<void> {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (entry.name === ".DS_Store") continue;
      const fullPath = path.join(currentDir, entry.name);
      const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        hash.update(`dir:${relPath}\n`);
        await walk(fullPath, relPath);
      } else if (entry.isFile()) {
        hash.update(`file:${relPath}\n`);
        const data = await fs.readFile(fullPath);
        hash.update(data);
        hash.update("\n");
      }
    }
  }

  await walk(dirPath, "");
  return hash.digest("hex").slice(0, 16);
}

export interface UnmanagedProjectSkill {
  name: string;
  sourcePath: string;
  relativeSource: string;
  info: SkillInfo;
}

export async function discoverProjectUnmanagedSkills(
  projectDir: string,
  libraryPath: string,
): Promise<UnmanagedProjectSkill[]> {
  const librarySkills = await listLibrarySkills(libraryPath);
  const libraryNames = new Set(librarySkills.map((s) => s.name));
  const librarySkillsDir = path.resolve(getLibrarySkillsDir(libraryPath));

  const scanDirs = [
    getProjectAgentsSkillsDir(projectDir),
    getProjectClaudeSkillsDir(projectDir),
    getProjectCursorSkillsDir(projectDir),
  ];

  const found = new Map<string, UnmanagedProjectSkill>();

  for (const dir of scanDirs) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = path.join(dir, entry.name);

      try {
        const lstat = await fs.lstat(fullPath);
        if (lstat.isSymbolicLink()) {
          const rawTarget = await fs.readlink(fullPath);
          const resolved = path.resolve(path.dirname(fullPath), rawTarget);
          if (resolved.startsWith(librarySkillsDir + path.sep)) {
            continue;
          }
        }
        const stat = await fs.stat(fullPath);
        if (!stat.isDirectory()) continue;
        await fs.access(path.join(fullPath, "SKILL.md"));
      } catch {
        continue;
      }

      const info = await inspectSkillDir(fullPath);
      const skillName = info.frontmatterName || info.name;
      if (libraryNames.has(skillName) || found.has(skillName)) continue;

      found.set(skillName, {
        name: skillName,
        sourcePath: fullPath,
        relativeSource: path.relative(projectDir, fullPath),
        info,
      });
    }
  }

  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function importSkillDirToLibrary(
  sourceDir: string,
  libraryPath: string,
  skillName: string,
): Promise<string> {
  await ensureLibraryScaffold(libraryPath);
  const destDir = path.join(getLibrarySkillsDir(libraryPath), skillName);
  await fs.rm(destDir, { recursive: true, force: true });
  await fs.cp(sourceDir, destDir, { recursive: true });
  return destDir;
}
