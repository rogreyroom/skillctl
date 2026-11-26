import * as p from "@clack/prompts";
import pc from "picocolors";
import { loadConfig } from "../config.js";
import {
  isValidSkillName,
  listLibrarySkills,
  loadLibraryIndex,
  saveLibraryIndex,
} from "../library.js";
import { badge, icons, padEndVisible, sectionHeader } from "../ui.js";

export async function runGroupListCommand(): Promise<void> {
  const config = await loadConfig();
  const index = await loadLibraryIndex(config.libraryPath);
  const groups = Object.entries(index.groups ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  );

  console.log(sectionHeader(`Skill groups (${groups.length})`, "index.yaml"));
  if (groups.length === 0) {
    console.log(
      pc.dim(
        "  (none — create one with `skillctl group add <name> <skills...>`)\n",
      ),
    );
    return;
  }

  const nameWidth = Math.max(12, ...groups.map(([g]) => g.length + 1));
  for (const [groupName, members] of groups) {
    const label = padEndVisible(pc.bold(pc.magenta(`@${groupName}`)), nameWidth);
    console.log(
      `  ${icons.bullet} ${label} ${badge(`${members.length}`, "dim")}  ${pc.dim(members.join(", "))}`,
    );
  }
  console.log("");
}

export async function runGroupAddCommand(
  rawGroupName: string,
  skillNames: string[],
): Promise<void> {
  const groupName = rawGroupName.replace(/^@/, "");
  if (!isValidSkillName(groupName)) {
    console.error(
      pc.red(
        `Invalid group name "${groupName}". Use kebab-case (e.g. "nuxt", "ui-kit").`,
      ),
    );
    process.exitCode = 1;
    return;
  }

  const config = await loadConfig();
  const index = await loadLibraryIndex(config.libraryPath);
  const librarySkills = await listLibrarySkills(config.libraryPath);
  const available = new Set(librarySkills.map((s) => s.name));
  const currentMembers = new Set(index.groups?.[groupName] ?? []);

  let targets = skillNames;
  if (targets.length === 0) {
    const candidates = librarySkills.filter((s) => !currentMembers.has(s.name));
    if (candidates.length === 0) {
      console.log(pc.yellow(`All library skills are already in @${groupName}.`));
      return;
    }
    const chosen = await p.multiselect({
      message: `Select skills to add to @${groupName}:`,
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

  const missing = targets.filter((n) => !available.has(n));
  if (missing.length > 0) {
    console.error(
      pc.red(`Unknown skill(s) not in library: ${missing.join(", ")}`),
    );
    process.exitCode = 1;
    return;
  }

  index.groups = index.groups ?? {};
  index.groups[groupName] = [
    ...new Set([...(index.groups[groupName] ?? []), ...targets]),
  ].sort();

  await saveLibraryIndex(config.libraryPath, index);
  console.log(
    `${icons.ok} ${pc.green(`Group @${groupName} now has ${index.groups[groupName].length} skill(s):`)} ${pc.dim(index.groups[groupName].join(", "))}`,
  );
}

export async function runGroupRmCommand(
  rawGroupName: string,
  skillNames: string[],
): Promise<void> {
  const groupName = rawGroupName.replace(/^@/, "");
  const config = await loadConfig();
  const index = await loadLibraryIndex(config.libraryPath);
  const members = index.groups?.[groupName];

  if (!members) {
    console.error(pc.red(`Group "@${groupName}" not found in index.yaml.`));
    process.exitCode = 1;
    return;
  }

  if (skillNames.length === 0) {
    delete index.groups![groupName];
    await saveLibraryIndex(config.libraryPath, index);
    console.log(`${icons.ok} ${pc.green(`Deleted group @${groupName}.`)}`);
    return;
  }

  const removeSet = new Set(skillNames);
  const nextMembers = members.filter((m) => !removeSet.has(m));
  if (nextMembers.length === 0) {
    delete index.groups![groupName];
    await saveLibraryIndex(config.libraryPath, index);
    console.log(
      `${icons.ok} ${pc.green(`Removed all skills and deleted empty group @${groupName}.`)}`,
    );
    return;
  }

  index.groups![groupName] = nextMembers;
  await saveLibraryIndex(config.libraryPath, index);
  console.log(
    `${icons.ok} ${pc.green(`Updated @${groupName} (${nextMembers.length} remaining):`)} ${pc.dim(nextMembers.join(", "))}`,
  );
}
