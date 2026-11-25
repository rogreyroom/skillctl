import fs from "node:fs/promises";
import path from "node:path";
import type { DetectionMatch, LibraryIndex } from "./types.js";

export interface ProjectFacts {
  deps: Set<string>;
  files: Set<string>;
}

async function readJsonSafe(
  filePath: string,
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function scanProjectFacts(
  projectDir: string,
): Promise<ProjectFacts> {
  const deps = new Set<string>();
  const files = new Set<string>();

  // Top-level files & directories
  try {
    const entries = await fs.readdir(projectDir, { withFileTypes: true });
    for (const entry of entries) {
      files.add(entry.name);
    }
  } catch {
    return { deps, files };
  }

  // package.json dependencies
  const pkg = await readJsonSafe(path.join(projectDir, "package.json"));
  if (pkg) {
    for (const field of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      const group = pkg[field];
      if (group && typeof group === "object") {
        for (const dep of Object.keys(group as Record<string, unknown>)) {
          deps.add(dep);
        }
      }
    }
  }

  // composer.json dependencies (PHP / Laravel)
  const composer = await readJsonSafe(path.join(projectDir, "composer.json"));
  if (composer) {
    for (const field of ["require", "require-dev"]) {
      const group = composer[field];
      if (group && typeof group === "object") {
        for (const dep of Object.keys(group as Record<string, unknown>)) {
          deps.add(dep);
        }
      }
    }
  }

  // pyproject.toml (best-effort package name extraction)
  if (files.has("pyproject.toml")) {
    try {
      const raw = await fs.readFile(
        path.join(projectDir, "pyproject.toml"),
        "utf8",
      );
      const matches = raw.matchAll(/["']([a-zA-Z0-9_.-]+)(?:[><=!~;[\s"'])/g);
      for (const m of matches) {
        if (m[1]) deps.add(m[1].toLowerCase());
      }
    } catch {
      // ignore
    }
  }

  // Cargo.toml (best-effort crate name extraction)
  if (files.has("Cargo.toml")) {
    try {
      const raw = await fs.readFile(path.join(projectDir, "Cargo.toml"), "utf8");
      let inDeps = false;
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.startsWith("[")) {
          inDeps = /dependencies\]/i.test(trimmed);
          continue;
        }
        if (inDeps && trimmed && !trimmed.startsWith("#")) {
          const eq = trimmed.indexOf("=");
          if (eq > 0) {
            deps.add(trimmed.slice(0, eq).trim());
          }
        }
      }
    } catch {
      // ignore
    }
  }

  return { deps, files };
}

function fileMatchesPattern(fileName: string, pattern: string): boolean {
  if (!pattern.includes("*")) {
    return fileName === pattern;
  }
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(fileName);
}

async function projectHasFilePattern(
  projectDir: string,
  topLevelFiles: Set<string>,
  pattern: string,
): Promise<string | null> {
  // Nested path like .github/workflows or src/app.vue
  if (pattern.includes("/")) {
    try {
      await fs.access(path.join(projectDir, pattern));
      return pattern;
    } catch {
      return null;
    }
  }

  for (const file of topLevelFiles) {
    if (fileMatchesPattern(file, pattern)) {
      return file;
    }
  }
  return null;
}

export async function detectProjectSkills(
  projectDir: string,
  index: LibraryIndex,
  availableSkillNames: Set<string>,
): Promise<DetectionMatch[]> {
  const facts = await scanProjectFacts(projectDir);
  const matches: DetectionMatch[] = [];

  for (const [skillName, entry] of Object.entries(index.skills)) {
    if (!availableSkillNames.has(skillName)) continue;
    const rule = entry.match;
    if (!rule) continue;

    const reasons: string[] = [];

    for (const dep of rule.deps ?? []) {
      if (facts.deps.has(dep)) {
        reasons.push(`dep "${dep}"`);
      }
    }

    for (const filePattern of rule.files ?? []) {
      const matched = await projectHasFilePattern(
        projectDir,
        facts.files,
        filePattern,
      );
      if (matched) {
        reasons.push(`file "${matched}"`);
      }
    }

    if (reasons.length > 0) {
      matches.push({ skill: skillName, reasons });
    }
  }

  return matches.sort((a, b) => a.skill.localeCompare(b.skill));
}
