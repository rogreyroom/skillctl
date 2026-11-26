import fs from "node:fs/promises";
import path from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { loadConfig, loadMergedProjectManifest } from "../config.js";
import {
  ensureLibraryScaffold,
  isValidSkillName,
  listLibrarySkills,
  loadLibraryIndex,
  saveLibraryIndex,
} from "../library.js";
import { pathExists, syncGlobal } from "../linker.js";
import { getLibrarySkillsDir } from "../paths.js";

export interface NewSkillOptions {
  description?: string;
  deps?: string;
  files?: string;
  global?: boolean;
}

export async function runNewSkillCommand(
  name: string,
  options: NewSkillOptions,
): Promise<void> {
  if (!isValidSkillName(name)) {
    console.error(
      pc.red(
        `Invalid skill name "${name}". Use kebab-case (lowercase letters, digits, hyphens — e.g. "my-skill").`,
      ),
    );
    process.exitCode = 1;
    return;
  }

  const config = await loadConfig();
  await ensureLibraryScaffold(config.libraryPath);
  const skillDir = path.join(getLibrarySkillsDir(config.libraryPath), name);

  if (await pathExists(skillDir)) {
    console.error(
      pc.red(`Skill "${name}" already exists at ${skillDir}.`),
    );
    process.exitCode = 1;
    return;
  }

  let description = options.description?.trim();
  if (!description) {
    const answer = await p.text({
      message: 'Description (start with "Use when..."):',
      placeholder: "Use when working with ...",
      validate: (val) =>
        !val || !val.trim() ? "Description is required for agents and Raycast." : undefined,
    });
    if (p.isCancel(answer)) {
      p.cancel("Cancelled.");
      return;
    }
    description = answer.trim();
  }

  const title = name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

  const content = `---
name: ${name}
description: ${description}
---

# ${title}

## When to Use

${description}

## Instructions

- Add clear, actionable guidelines here.
`;

  await fs.mkdir(skillDir, { recursive: true });
  const skillMdPath = path.join(skillDir, "SKILL.md");
  await fs.writeFile(skillMdPath, content, "utf8");

  const index = await loadLibraryIndex(config.libraryPath);
  const deps = options.deps
    ? options.deps
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const files = options.files
    ? options.files
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  index.skills[name] = {
    ...(deps.length > 0 || files.length > 0
      ? {
          match: {
            ...(deps.length > 0 ? { deps } : {}),
            ...(files.length > 0 ? { files } : {}),
          },
        }
      : {}),
  };

  if (options.global && !index.global.includes(name)) {
    index.global.push(name);
  }

  await saveLibraryIndex(config.libraryPath, index);
  if (options.global) {
    await syncGlobal(config, index);
  }

  console.log(pc.green(`Created skill "${name}" at ${skillMdPath}`));
  if (options.global) {
    console.log(pc.cyan(`Linked "${name}" globally.`));
  }
}

export async function runSearchCommand(query: string): Promise<void> {
  const config = await loadConfig();
  const index = await loadLibraryIndex(config.libraryPath);
  const skills = await listLibrarySkills(config.libraryPath);
  const needle = query.toLowerCase();
  const globalSet = new Set(index.global);

  const skillGroups = new Map<string, string[]>();
  for (const [groupName, members] of Object.entries(index.groups ?? {})) {
    for (const m of members) {
      const list = skillGroups.get(m) ?? [];
      list.push(`@${groupName}`);
      skillGroups.set(m, list);
    }
  }

  const matches = skills.filter((skill) => {
    const entry = index.skills[skill.name];
    const groups = skillGroups.get(skill.name) ?? [];
    const haystack = [
      skill.name,
      skill.description ?? "",
      ...(entry?.match?.deps ?? []),
      ...(entry?.match?.files ?? []),
      ...groups,
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle);
  });

  if (matches.length === 0) {
    console.log(pc.yellow(`No skills matching "${query}".`));
    return;
  }

  console.log(pc.bold(`Matches for "${query}" (${matches.length}):`));
  for (const skill of matches) {
    const badges: string[] = [];
    if (globalSet.has(skill.name)) badges.push(pc.cyan("global"));
    for (const g of skillGroups.get(skill.name) ?? []) {
      badges.push(pc.magenta(g));
    }
    const badgeStr = badges.length > 0 ? ` [${badges.join(", ")}]` : "";
    const desc = skill.description ? pc.dim(` — ${skill.description}`) : "";
    console.log(`  • ${pc.bold(skill.name)}${badgeStr}${desc}`);
  }
}

export async function runInfoCommand(skillName: string): Promise<void> {
  const config = await loadConfig();
  const index = await loadLibraryIndex(config.libraryPath);
  const skills = await listLibrarySkills(config.libraryPath);
  const skill = skills.find((s) => s.name === skillName);

  if (!skill) {
    console.error(pc.red(`Skill "${skillName}" not found in library.`));
    process.exitCode = 1;
    return;
  }

  const entry = index.skills[skillName];
  const isGlobal = index.global.includes(skillName);
  const isRaycastPinned = config.raycast.pinned.includes(skillName);
  const groups = Object.entries(index.groups ?? {})
    .filter(([, members]) => members.includes(skillName))
    .map(([g]) => `@${g}`);

  const usedIn: Array<{ projectDir: string; scope: string }> = [];
  for (const projectDir of config.trackedProjects) {
    const existing = await loadMergedProjectManifest(projectDir);
    if (existing.shared?.skills[skillName]) {
      usedIn.push({
        projectDir,
        scope: `repo:${existing.shared.skills[skillName].mode}`,
      });
    }
    if (existing.local?.skills[skillName]) {
      usedIn.push({
        projectDir,
        scope: `local:${existing.local.skills[skillName].mode}`,
      });
    }
  }

  console.log(pc.bold(skill.name));
  console.log(`  Path:        ${pc.dim(skill.skillMdPath)}`);
  console.log(
    `  Description: ${skill.description ?? pc.yellow("(missing)")}`,
  );
  console.log(
    `  Global:      ${isGlobal ? pc.cyan("yes") : pc.dim("no")}`,
  );
  if (isRaycastPinned) {
    console.log(`  Raycast:     ${pc.magenta("pinned")}`);
  }
  if (groups.length > 0) {
    console.log(`  Groups:      ${pc.magenta(groups.join(", "))}`);
  }
  if (entry?.source) {
    console.log(`  Source:      ${pc.dim(entry.source)}`);
  }
  if (entry?.match) {
    const parts: string[] = [];
    if (entry.match.deps?.length) {
      parts.push(`deps=[${entry.match.deps.join(", ")}]`);
    }
    if (entry.match.files?.length) {
      parts.push(`files=[${entry.match.files.join(", ")}]`);
    }
    if (parts.length > 0) {
      console.log(`  Match rules: ${pc.dim(parts.join(" "))}`);
    }
  }
  if (usedIn.length > 0) {
    console.log(`  Used in:`);
    for (const u of usedIn) {
      console.log(`    • ${u.projectDir} ${pc.dim(`[${u.scope}]`)}`);
    }
  } else {
    console.log(`  Used in:     ${pc.dim("(no tracked projects)")}`);
  }
  if (skill.issues.length > 0) {
    console.log(`  Issues:`);
    for (const i of skill.issues) {
      console.log(`    • ${pc.red(i.message)}`);
    }
  }
}
