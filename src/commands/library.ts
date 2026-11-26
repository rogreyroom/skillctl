import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { loadConfig, loadMergedProjectManifest } from "../config.js";
import {
  ensureLibraryScaffold,
  inspectSkillDir,
  isValidSkillName,
  listLibrarySkills,
  loadLibraryIndex,
  saveLibraryIndex,
} from "../library.js";
import { pathExists, syncGlobal } from "../linker.js";
import { getLibrarySkillsDir } from "../paths.js";
import {
  badge,
  formatSkillRow,
  icons,
  renderCard,
  sectionHeader,
} from "../ui.js";

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

  console.log(
    sectionHeader(`Search: "${query}"`, `${matches.length} match(es)`),
  );
  const nameWidth = Math.min(
    30,
    Math.max(14, ...matches.map((s) => s.name.length)),
  );
  for (const skill of matches) {
    const badges: string[] = [];
    if (globalSet.has(skill.name)) badges.push(badge("global", "cyan"));
    for (const g of skillGroups.get(skill.name) ?? []) {
      badges.push(badge(g, "magenta"));
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
  console.log("");
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

  const rows: Array<[string, string]> = [
    ["Path", pc.dim(skill.skillMdPath)],
    ["Description", skill.description ?? pc.yellow("(missing)")],
    ["Global", isGlobal ? badge("global", "cyan") : pc.dim("no")],
  ];
  if (isRaycastPinned) {
    rows.push(["Raycast", badge("pinned", "magenta")]);
  }
  if (groups.length > 0) {
    rows.push(["Groups", groups.map((g) => badge(g, "magenta")).join(" ")]);
  }
  if (entry?.source) {
    rows.push(["Source", pc.dim(entry.source)]);
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
      rows.push(["Match rules", pc.dim(parts.join(" "))]);
    }
  }
  if (usedIn.length > 0) {
    rows.push([
      "Used in",
      usedIn
        .map((u) => `${path.basename(u.projectDir)} ${pc.dim(`[${u.scope}]`)}`)
        .join(pc.dim(", ")),
    ]);
  } else {
    rows.push(["Used in", pc.dim("(no tracked projects)")]);
  }

  console.log("");
  console.log(renderCard(skill.name, rows));
  if (skill.issues.length > 0) {
    console.log("");
    for (const i of skill.issues) {
      console.log(`  ${icons.err} ${pc.red(i.message)}`);
    }
  }
  console.log("");
}

export async function runEditCommand(skillName?: string): Promise<void> {
  const config = await loadConfig();
  const skills = await listLibrarySkills(config.libraryPath);

  if (skills.length === 0) {
    console.log(pc.yellow("No skills found in library."));
    return;
  }

  let targetName = skillName;
  if (!targetName) {
    const chosen = await p.select({
      message: "Select a skill to edit:",
      options: skills.map((s) => ({
        value: s.name,
        label: s.name,
        hint: s.description,
      })),
    });
    if (p.isCancel(chosen)) {
      p.cancel("Cancelled.");
      return;
    }
    targetName = String(chosen);
  }

  const skill = skills.find((s) => s.name === targetName);
  if (!skill) {
    console.error(pc.red(`Skill "${targetName}" not found in library.`));
    process.exitCode = 1;
    return;
  }

  const editorCmd = process.env.VISUAL || process.env.EDITOR || "vi";
  const parts = editorCmd.split(/\s+/).filter(Boolean);
  const bin = parts[0]!;
  const args = [...parts.slice(1), skill.skillMdPath];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", () => resolve());
  });

  // Post-edit validation so Raycast never silently drops a broken edit
  const updated = await inspectSkillDir(skill.dirPath);
  if (updated.issues.length === 0) {
    console.log(
      `${icons.ok} ${pc.green(`${updated.name}/SKILL.md is valid.`)}`,
    );
  } else {
    console.log(
      `${icons.warn} ${pc.yellow(`Validation issues in ${updated.name}/SKILL.md:`)}`,
    );
    for (const issue of updated.issues) {
      console.log(`  ${icons.err} ${pc.red(issue.message)}`);
    }
    process.exitCode = 1;
  }
}
