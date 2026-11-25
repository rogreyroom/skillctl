import fs from "node:fs/promises";
import path from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { loadConfig, saveConfig } from "../config.js";
import { ensureLibraryScaffold, loadLibraryIndex } from "../library.js";
import { syncGlobal } from "../linker.js";
import {
  expandHome,
  getDefaultLibraryPath,
  getGlobalAgentsSkillsDir,
  getGlobalClaudeSkillsDir,
  getLibrarySkillsDir,
} from "../paths.js";

export interface SetupOptions {
  library?: string;
  claude?: boolean;
  yes?: boolean;
}

async function findMigratableSkills(
  sourceDir: string,
  librarySkillsDir: string,
): Promise<Array<{ name: string; path: string }>> {
  const found: Array<{ name: string; path: string }> = [];
  let entries;
  try {
    const stat = await fs.lstat(sourceDir);
    if (stat.isSymbolicLink()) return found;
    entries = await fs.readdir(sourceDir, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(sourceDir, entry.name);
    const destPath = path.join(librarySkillsDir, entry.name);
    try {
      const lstat = await fs.lstat(fullPath);
      if (lstat.isSymbolicLink()) continue;
      if (!lstat.isDirectory()) continue;
      await fs.access(path.join(fullPath, "SKILL.md"));
      try {
        await fs.access(destPath);
        // Already exists in library
      } catch {
        found.push({ name: entry.name, path: fullPath });
      }
    } catch {
      continue;
    }
  }
  return found;
}

export async function runSetupCommand(options: SetupOptions): Promise<void> {
  const existing = await loadConfig();

  if (options.yes) {
    const libraryPath = expandHome(
      options.library ?? existing.libraryPath ?? getDefaultLibraryPath(),
    );
    const config = {
      ...existing,
      libraryPath,
      agents: {
        claude: options.claude ?? existing.agents.claude,
      },
    };
    await ensureLibraryScaffold(libraryPath);
    await saveConfig(config);
    console.log(pc.green(`Configured skillctl library at ${libraryPath}`));
    return;
  }

  p.intro(pc.cyan("skillctl setup"));

  const libAnswer = await p.text({
    message: "Where should your central skill library live?",
    placeholder: "~/dotfiles/agent-skills",
    initialValue: options.library ?? existing.libraryPath,
    validate: (val) => {
      if (!val || !val.trim()) return "Please enter a directory path.";
    },
  });
  if (p.isCancel(libAnswer)) {
    p.cancel("Setup cancelled.");
    return;
  }

  const libraryPath = expandHome(libAnswer.trim());

  const claudeAnswer =
    options.claude !== undefined
      ? options.claude
      : await p.confirm({
          message:
            "Also sync skills to Claude Code folders (~/.claude/skills & .claude/skills)?",
          initialValue: existing.agents.claude,
        });
  if (p.isCancel(claudeAnswer)) {
    p.cancel("Setup cancelled.");
    return;
  }

  await ensureLibraryScaffold(libraryPath);

  const config = {
    ...existing,
    libraryPath,
    agents: {
      claude: Boolean(claudeAnswer),
    },
  };
  await saveConfig(config);

  const librarySkillsDir = getLibrarySkillsDir(libraryPath);
  const agentsCandidates = await findMigratableSkills(
    getGlobalAgentsSkillsDir(),
    librarySkillsDir,
  );
  const claudeCandidates = await findMigratableSkills(
    getGlobalClaudeSkillsDir(),
    librarySkillsDir,
  );
  const allCandidates = [...agentsCandidates];
  for (const c of claudeCandidates) {
    if (!allCandidates.some((x) => x.name === c.name)) {
      allCandidates.push(c);
    }
  }

  if (allCandidates.length > 0) {
    const shouldMigrate = await p.confirm({
      message: `Found ${allCandidates.length} existing skill(s) in ~/.agents/skills or ~/.claude/skills. Import them into your library?`,
      initialValue: true,
    });
    if (!p.isCancel(shouldMigrate) && shouldMigrate) {
      for (const item of allCandidates) {
        const dest = path.join(librarySkillsDir, item.name);
        await fs.cp(item.path, dest, { recursive: true });
      }
      p.log.success(
        `Imported ${allCandidates.length} skill(s) into ${librarySkillsDir}`,
      );
    }
  }

  const index = await loadLibraryIndex(libraryPath);
  if (index.global.length > 0) {
    await syncGlobal(config, index);
  }

  p.outro(
    `${pc.green("Setup complete!")} Library: ${pc.dim(libraryPath)}\n` +
      `  Next: run ${pc.cyan("skillctl global add")} to pick global skills, or ${pc.cyan("skillctl init")} inside a project.`,
  );
}
