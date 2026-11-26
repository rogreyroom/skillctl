import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateCompletionScript } from "../src/commands/completion.js";
import { runGroupAddCommand, runGroupRmCommand } from "../src/commands/group.js";
import {
  runInstallCommand,
  runUpdateCommand,
} from "../src/commands/install.js";
import {
  runInfoCommand,
  runNewSkillCommand,
  runSearchCommand,
} from "../src/commands/library.js";
import {
  runListCommand,
  runProjectSyncCommand,
} from "../src/commands/project.js";
import {
  createDefaultConfig,
  loadMergedProjectManifest,
  loadProjectManifest,
  saveConfig,
  saveProjectLocalManifest,
  saveProjectManifest,
} from "../src/config.js";
import { detectProjectSkills } from "../src/detect.js";
import { runDoctor } from "../src/doctor.js";
import {
  findGlobalDuplicates,
  findProjectDuplicates,
} from "../src/duplicates.js";
import {
  discoverProjectUnmanagedSkills,
  ensureLibraryScaffold,
  expandSkillTargets,
  importSkillDirToLibrary,
  inspectSkillDir,
  listLibrarySkills,
  loadLibraryIndex,
  saveLibraryIndex,
} from "../src/library.js";
import {
  resolveGitInfo,
  syncGlobal,
  syncProject,
  syncRaycast,
} from "../src/linker.js";
import {
  getGlobalAgentsSkillsDir,
  getGlobalAntigravitySkillsDir,
  getGlobalClaudeSkillsDir,
  getGlobalCursorSkillsDir,
  getLibrarySkillsDir,
  getProjectAgentsSkillsDir,
  getProjectClaudeSkillsDir,
  getRaycastSkillsDir,
} from "../src/paths.js";

async function writeSkill(
  libraryPath: string,
  folderName: string,
  frontmatterName: string,
  description = "Use when testing skillctl.",
  body = "# Skill body\n",
): Promise<string> {
  const dir = path.join(getLibrarySkillsDir(libraryPath), folderName);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${frontmatterName}\ndescription: ${description}\n---\n\n${body}`,
    "utf8",
  );
  return dir;
}

describe("skillctl core", () => {
  let tmpHome: string;
  let libraryPath: string;
  let projectDir: string;
  let prevHome: string | undefined;
  let prevConfigDir: string | undefined;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "skillctl-test-"));
    prevHome = process.env.SKILLCTL_HOME;
    prevConfigDir = process.env.SKILLCTL_CONFIG_DIR;
    process.env.SKILLCTL_HOME = tmpHome;
    process.env.SKILLCTL_CONFIG_DIR = path.join(tmpHome, ".config", "skillctl");

    libraryPath = path.join(tmpHome, "dotfiles", "agent-skills");
    projectDir = path.join(tmpHome, "projects", "demo-app");
    await ensureLibraryScaffold(libraryPath);
    await fs.mkdir(path.join(projectDir, ".git", "info"), { recursive: true });
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.SKILLCTL_HOME;
    else process.env.SKILLCTL_HOME = prevHome;
    if (prevConfigDir === undefined) delete process.env.SKILLCTL_CONFIG_DIR;
    else process.env.SKILLCTL_CONFIG_DIR = prevConfigDir;

    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it("detects matching project skills from package.json, composer.json, and file globs", async () => {
    await writeSkill(libraryPath, "vitest", "vitest");
    await writeSkill(libraryPath, "nuxt-slice", "nuxt-slice");
    await writeSkill(libraryPath, "laravel-api", "laravel-api");

    await fs.writeFile(
      path.join(projectDir, "package.json"),
      JSON.stringify({ devDependencies: { vitest: "^3.0.0" } }),
      "utf8",
    );
    await fs.writeFile(path.join(projectDir, "nuxt.config.ts"), "", "utf8");

    const index = {
      global: [],
      skills: {
        vitest: { match: { deps: ["vitest"] } },
        "nuxt-slice": { match: { files: ["nuxt.config.*"] } },
        "laravel-api": { match: { files: ["composer.json", "artisan"] } },
      },
    };
    await saveLibraryIndex(libraryPath, index);

    const available = new Set(
      (await listLibrarySkills(libraryPath)).map((s) => s.name),
    );
    const matches = await detectProjectSkills(projectDir, index, available);

    expect(matches.map((m) => m.skill)).toEqual(["nuxt-slice", "vitest"]);
    expect(matches[0].reasons).toContain('file "nuxt.config.ts"');
    expect(matches[1].reasons).toContain('dep "vitest"');
  });

  it("syncs global skills to ~/.agents/skills and optionally ~/.claude/skills", async () => {
    await writeSkill(libraryPath, "find-skills", "find-skills");
    await writeSkill(libraryPath, "commit-style", "commit-style");

    const config = createDefaultConfig();
    config.libraryPath = libraryPath;
    config.agents.claude = true;
    await saveConfig(config);

    const index = { global: ["find-skills", "commit-style"], skills: {} };
    const result = await syncGlobal(config, index);

    expect(result.linked).toEqual(["commit-style", "find-skills"]);
    const agentsLink = await fs.lstat(
      path.join(getGlobalAgentsSkillsDir(), "find-skills"),
    );
    const claudeLink = await fs.lstat(
      path.join(getGlobalClaudeSkillsDir(), "find-skills"),
    );
    expect(agentsLink.isSymbolicLink()).toBe(true);
    expect(claudeLink.isSymbolicLink()).toBe(true);

    // Removing one from global unlinks it cleanly
    const res2 = await syncGlobal(config, {
      global: ["find-skills"],
      skills: {},
    });
    expect(res2.removed).toEqual(["commit-style"]);
    await expect(
      fs.lstat(path.join(getGlobalAgentsSkillsDir(), "commit-style")),
    ).rejects.toThrow();
  });

  it("supports symlink mode (with .git/info/exclude) and copy mode (with hash tracking)", async () => {
    await writeSkill(libraryPath, "personal-skill", "personal-skill");
    await writeSkill(libraryPath, "team-skill", "team-skill");

    const config = createDefaultConfig();
    config.libraryPath = libraryPath;
    config.agents.claude = true;

    const manifest = {
      skills: {
        "personal-skill": { mode: "link" as const },
        "team-skill": { mode: "copy" as const },
      },
      claude: true,
      gitExclude: true,
    };
    await saveProjectManifest(projectDir, manifest);
    const result = await syncProject(projectDir, config, manifest);

    expect(result.linked).toEqual(["personal-skill"]);
    expect(result.copied).toEqual(["team-skill"]);

    const linkedStat = await fs.lstat(
      path.join(getProjectAgentsSkillsDir(projectDir), "personal-skill"),
    );
    const copiedStat = await fs.lstat(
      path.join(getProjectAgentsSkillsDir(projectDir), "team-skill"),
    );
    const claudeStat = await fs.lstat(
      path.join(getProjectClaudeSkillsDir(projectDir), "personal-skill"),
    );
    expect(linkedStat.isSymbolicLink()).toBe(true);
    expect(copiedStat.isSymbolicLink()).toBe(false);
    expect(copiedStat.isDirectory()).toBe(true);
    expect(claudeStat.isSymbolicLink()).toBe(true);

    const excludeContent = await fs.readFile(
      path.join(projectDir, ".git", "info", "exclude"),
      "utf8",
    );
    expect(excludeContent).toContain(".agents/skills/personal-skill");
    expect(excludeContent).toContain(".claude/skills/personal-skill");
    expect(excludeContent).not.toContain("team-skill");

    const reloaded = await loadProjectManifest(projectDir);
    expect(reloaded?.skills["team-skill"]?.hash).toBeTruthy();
  });

  it("exposes active project + pinned skills to Raycast without duplicating globals", async () => {
    await writeSkill(libraryPath, "global-one", "global-one");
    await writeSkill(libraryPath, "proj-skill", "proj-skill");
    await writeSkill(libraryPath, "pinned-skill", "pinned-skill");

    await saveProjectManifest(projectDir, {
      skills: {
        "proj-skill": { mode: "link" },
        "global-one": { mode: "link" },
      },
    });

    const config = createDefaultConfig();
    config.libraryPath = libraryPath;
    config.raycast = {
      activeProject: projectDir,
      pinned: ["pinned-skill"],
    };
    await saveConfig(config);

    const index = { global: ["global-one"], skills: {} };
    const result = await syncRaycast(config, index);

    expect(result.linked).toEqual(["pinned-skill", "proj-skill"]);
    expect(result.skippedGlobal).toEqual(["global-one"]);

    const entries = await fs.readdir(getRaycastSkillsDir());
    expect(entries.sort()).toEqual(["pinned-skill", "proj-skill"]);

    // Clearing active project removes proj-skill but keeps pinned-skill
    delete config.raycast.activeProject;
    const res2 = await syncRaycast(config, index);
    expect(res2.removed).toEqual(["proj-skill"]);
    expect(res2.linked).toEqual(["pinned-skill"]);
  });

  it("checks duplicates bidirectionally between global and projects", async () => {
    await saveProjectManifest(projectDir, {
      skills: { vitest: { mode: "link" } },
    });

    expect(
      findGlobalDuplicates(["vitest", "nuxt"], {
        global: ["vitest"],
        skills: {},
      }),
    ).toEqual(["vitest"]);

    const hits = await findProjectDuplicates(["vitest", "nuxt"], [projectDir]);
    expect(hits).toEqual([{ skill: "vitest", projectDir }]);
  });

  it("doctor detects and fixes broken symlinks, duplicates, copy drift, and reports SKILL.md errors", async () => {
    await writeSkill(libraryPath, "good-skill", "good-skill");
    await writeSkill(libraryPath, "bad-name", "wrong-name");
    await writeSkill(libraryPath, "copied-skill", "copied-skill", "Use when copying", "v1\n");

    const config = createDefaultConfig();
    config.libraryPath = libraryPath;
    await saveConfig(config);

    const index = { global: ["good-skill"], skills: {} };
    await saveLibraryIndex(libraryPath, index);
    await syncGlobal(config, index);

    // Create a broken symlink in global agents dir
    await fs.symlink(
      path.join(libraryPath, "skills", "nonexistent"),
      path.join(getGlobalAgentsSkillsDir(), "stale-link"),
    );

    // Project has duplicate of global + copied skill that will drift
    const manifest = {
      skills: {
        "good-skill": { mode: "link" as const },
        "copied-skill": { mode: "copy" as const },
      },
    };
    await saveProjectManifest(projectDir, manifest);
    await syncProject(projectDir, config, manifest);

    // Modify library copy to induce drift
    await writeSkill(libraryPath, "copied-skill", "copied-skill", "Use when copying", "v2 updated\n");

    const issues = await runDoctor(config, projectDir);
    const codes = issues.map((i) => i.code);
    expect(codes).toContain("name-mismatch");
    expect(codes).toContain("broken-symlink");
    expect(codes).toContain("project-global-duplicate");
    expect(codes).toContain("copied-skill-drift");

    // Apply all auto-fixes
    for (const issue of issues) {
      if (issue.fixable && issue.fix) {
        await issue.fix();
      }
    }

    const remaining = await runDoctor(config, projectDir);
    expect(remaining.map((i) => i.code)).toEqual(["name-mismatch"]);

    // Verify copied skill was updated to v2
    const updatedMd = await fs.readFile(
      path.join(getProjectAgentsSkillsDir(projectDir), "copied-skill", "SKILL.md"),
      "utf8",
    );
    expect(updatedMd).toContain("v2 updated");

    // Validate inspectSkillDir directly
    const badInfo = await inspectSkillDir(
      path.join(getLibrarySkillsDir(libraryPath), "bad-name"),
    );
    expect(badInfo.issues.some((i) => i.code === "name-mismatch")).toBe(true);
  });

  it("supports mixed repo (.skillctl.json copy) + personal (.skillctl.local.json link excluded from git)", async () => {
    await writeSkill(libraryPath, "team-shared", "team-shared");
    await writeSkill(libraryPath, "my-personal", "my-personal");

    const config = createDefaultConfig();
    config.libraryPath = libraryPath;

    await saveProjectManifest(projectDir, {
      skills: { "team-shared": { mode: "copy" } },
    });
    await saveProjectLocalManifest(projectDir, {
      skills: { "my-personal": { mode: "link" } },
      gitExclude: true,
    });

    const result = await syncProject(projectDir, config);
    expect(result.copied).toEqual(["team-shared"]);
    expect(result.linked).toEqual(["my-personal"]);

    const excludeContent = await fs.readFile(
      path.join(projectDir, ".git", "info", "exclude"),
      "utf8",
    );
    expect(excludeContent).toContain(".skillctl.local.json");
    expect(excludeContent).toContain(".agents/skills/my-personal");
    expect(excludeContent).not.toContain("team-shared");
    expect(excludeContent).not.toContain(".skillctl.json\n");

    const merged = await loadMergedProjectManifest(projectDir);
    expect(Object.keys(merged.merged?.skills ?? {}).sort()).toEqual([
      "my-personal",
      "team-shared",
    ]);
  });

  it("discovers unmanaged project skills not in library and imports them", async () => {
    await writeSkill(libraryPath, "existing-lib", "existing-lib");

    // Create a project-local skill in .agents/skills and another in .cursor/skills
    const projSkillDir = path.join(projectDir, ".agents", "skills", "repo-only-skill");
    await fs.mkdir(projSkillDir, { recursive: true });
    await fs.writeFile(
      path.join(projSkillDir, "SKILL.md"),
      "---\nname: repo-only-skill\ndescription: Custom repo skill\n---\n\n# Repo Skill\n",
      "utf8",
    );

    const cursorSkillDir = path.join(projectDir, ".cursor", "skills", "cursor-only-skill");
    await fs.mkdir(cursorSkillDir, { recursive: true });
    await fs.writeFile(
      path.join(cursorSkillDir, "SKILL.md"),
      "---\nname: cursor-only-skill\ndescription: Cursor repo skill\n---\n\n# Cursor Skill\n",
      "utf8",
    );

    const unmanaged = await discoverProjectUnmanagedSkills(projectDir, libraryPath);
    expect(unmanaged.map((u) => u.name)).toEqual([
      "cursor-only-skill",
      "repo-only-skill",
    ]);

    // Import one into library and verify it's no longer unmanaged
    await importSkillDirToLibrary(projSkillDir, libraryPath, "repo-only-skill");
    const afterImport = await discoverProjectUnmanagedSkills(projectDir, libraryPath);
    expect(afterImport.map((u) => u.name)).toEqual(["cursor-only-skill"]);
  });

  it("list --project shows only active project, unmanaged, and global skills", async () => {
    await writeSkill(libraryPath, "global-skill", "global-skill");
    await writeSkill(libraryPath, "shared-skill", "shared-skill");
    await writeSkill(libraryPath, "personal-skill", "personal-skill");
    await writeSkill(libraryPath, "unused-lib-skill", "unused-lib-skill");

    const config = createDefaultConfig();
    config.libraryPath = libraryPath;
    await saveConfig(config);
    await saveLibraryIndex(libraryPath, {
      global: ["global-skill"],
      skills: {},
    });

    await saveProjectManifest(projectDir, {
      skills: { "shared-skill": { mode: "copy" } },
    });
    await saveProjectLocalManifest(projectDir, {
      skills: { "personal-skill": { mode: "link" } },
      gitExclude: true,
    });
    await syncProject(projectDir, config);

    const unmanagedDir = path.join(projectDir, ".agents", "skills", "custom-local");
    await fs.mkdir(unmanagedDir, { recursive: true });
    await fs.writeFile(
      path.join(unmanagedDir, "SKILL.md"),
      "---\nname: custom-local\ndescription: Unmanaged skill\n---\n\n# Custom\n",
      "utf8",
    );

    const lines: string[] = [];
    const spy = vi
      .spyOn(console, "log")
      .mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      });

    try {
      await runListCommand({ dir: projectDir, project: true });
    } finally {
      spy.mockRestore();
    }

    const output = lines.join("\n");
    expect(output).toContain("shared-skill");
    expect(output).toContain("repo:copy");
    expect(output).toContain("personal-skill");
    expect(output).toContain("local:link");
    expect(output).toContain("custom-local");
    expect(output).toContain("unmanaged:");
    expect(output).toContain("global-skill");
    expect(output).not.toContain("unused-lib-skill");
  });

  it("syncs global skills to Antigravity (~/.gemini/config/skills) when enabled", async () => {
    await writeSkill(libraryPath, "find-skills", "find-skills");
    const config = createDefaultConfig();
    config.libraryPath = libraryPath;
    config.agents.antigravity = true;
    await saveConfig(config);

    await syncGlobal(config, { global: ["find-skills"], skills: {} });
    const agyLink = await fs.lstat(
      path.join(getGlobalAntigravitySkillsDir(), "find-skills"),
    );
    expect(agyLink.isSymbolicLink()).toBe(true);
  });

  it("doctor detects and fixes legacy duplicates in ~/.cursor/skills and unmanaged ~/.agents/skills copies", async () => {
    await writeSkill(libraryPath, "vitest", "vitest");
    await writeSkill(libraryPath, "nuxt-code-review", "nuxt-code-review");

    const config = createDefaultConfig();
    config.libraryPath = libraryPath;
    await saveConfig(config);
    await saveLibraryIndex(libraryPath, { global: [], skills: {} });

    // Simulate legacy copy in ~/.cursor/skills and unmanaged copy in ~/.agents/skills
    const legacyCursor = path.join(getGlobalCursorSkillsDir(), "nuxt-code-review");
    await fs.mkdir(legacyCursor, { recursive: true });
    await fs.writeFile(path.join(legacyCursor, "SKILL.md"), "old", "utf8");

    const legacyAgents = path.join(getGlobalAgentsSkillsDir(), "vitest");
    await fs.mkdir(legacyAgents, { recursive: true });
    await fs.writeFile(path.join(legacyAgents, "SKILL.md"), "old", "utf8");

    const issues = await runDoctor(config);
    const codes = issues.map((i) => i.code);
    expect(codes).toContain("legacy-cursor-duplicate");
    expect(codes).toContain("legacy-global-copy");

    for (const issue of issues) {
      if (issue.fixable && issue.fix) await issue.fix();
    }

    await expect(fs.lstat(legacyCursor)).rejects.toThrow();
    await expect(fs.lstat(legacyAgents)).rejects.toThrow();
  });

  it("resolves git worktree .git files and writes excludes to common git dir", async () => {
    await writeSkill(libraryPath, "vitest", "vitest");

    // Simulate a linked worktree pointing to projectDir/.git/worktrees/wt-1
    const wtGitDir = path.join(projectDir, ".git", "worktrees", "wt-1");
    await fs.mkdir(wtGitDir, { recursive: true });
    await fs.writeFile(path.join(wtGitDir, "commondir"), "../..\n", "utf8");

    const worktreeDir = path.join(tmpHome, "projects", "demo-app-wt1");
    await fs.mkdir(worktreeDir, { recursive: true });
    await fs.writeFile(
      path.join(worktreeDir, ".git"),
      `gitdir: ${wtGitDir}\n`,
      "utf8",
    );

    const gitInfo = await resolveGitInfo(worktreeDir);
    expect(gitInfo?.isWorktree).toBe(true);
    expect(gitInfo?.mainWorktreeDir).toBe(path.resolve(projectDir));

    const config = createDefaultConfig();
    config.libraryPath = libraryPath;
    await saveProjectLocalManifest(worktreeDir, {
      skills: { vitest: { mode: "link" } },
      gitExclude: true,
    });
    await syncProject(worktreeDir, config);

    const excludeContent = await fs.readFile(
      path.join(projectDir, ".git", "info", "exclude"),
      "utf8",
    );
    expect(excludeContent).toContain(".skillctl.local.json");
    expect(excludeContent).toContain(".agents/skills/vitest");
  });

  it("expands @group targets from index.yaml", () => {
    const index = {
      global: [],
      groups: {
        nuxt: ["nuxt-api", "nuxt-ui"],
      },
      skills: {},
    };
    const res = expandSkillTargets(["@nuxt", "vitest", "@missing"], index);
    expect(res.resolved).toEqual(["nuxt-api", "nuxt-ui", "vitest"]);
    expect(res.unknownGroups).toEqual(["@missing"]);
  });

  it("scaffolds a new skill, searches for it, and displays info", async () => {
    const config = createDefaultConfig();
    config.libraryPath = libraryPath;
    await saveConfig(config);

    await runNewSkillCommand("my-custom-skill", {
      description: "Use when testing skillctl new.",
      deps: "vitest,zod",
      files: "vitest.config.*",
    });

    const info = await inspectSkillDir(
      path.join(getLibrarySkillsDir(libraryPath), "my-custom-skill"),
    );
    expect(info.issues).toEqual([]);
    expect(info.frontmatterName).toBe("my-custom-skill");

    const index = await loadLibraryIndex(libraryPath);
    expect(index.skills["my-custom-skill"]?.match?.deps).toEqual([
      "vitest",
      "zod",
    ]);

    const lines: string[] = [];
    const spy = vi
      .spyOn(console, "log")
      .mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      });
    try {
      await runSearchCommand("zod");
      await runInfoCommand("my-custom-skill");
    } finally {
      spy.mockRestore();
    }

    const out = lines.join("\n");
    expect(out).toContain("my-custom-skill");
    expect(out).toContain("Use when testing skillctl new.");
  });

  it("records source on install, updates from source, and syncs all tracked projects", async () => {
    const config = createDefaultConfig();
    config.libraryPath = libraryPath;
    config.trackedProjects = [projectDir];
    await saveConfig(config);

    // Local upstream source folder
    const upstreamDir = path.join(tmpHome, "upstream", "cool-skill");
    await fs.mkdir(upstreamDir, { recursive: true });
    await fs.writeFile(
      path.join(upstreamDir, "SKILL.md"),
      "---\nname: cool-skill\ndescription: Upstream v1\n---\n\n# v1\n",
      "utf8",
    );

    await runInstallCommand(upstreamDir, {});
    const index = await loadLibraryIndex(libraryPath);
    expect(index.skills["cool-skill"]?.source).toBe(path.resolve(upstreamDir));

    // Add as copy in tracked project
    await saveProjectManifest(projectDir, {
      skills: { "cool-skill": { mode: "copy" } },
    });
    await syncProject(projectDir, config);

    // Update upstream to v2
    await fs.writeFile(
      path.join(upstreamDir, "SKILL.md"),
      "---\nname: cool-skill\ndescription: Upstream v2\n---\n\n# v2\n",
      "utf8",
    );

    await runUpdateCommand(["cool-skill"]);
    await runProjectSyncCommand({ all: true });

    const syncedMd = await fs.readFile(
      path.join(getProjectAgentsSkillsDir(projectDir), "cool-skill", "SKILL.md"),
      "utf8",
    );
    expect(syncedMd).toContain("Upstream v2");
  });

  it("manages @group bundles via group add/rm and generates shell completion scripts", async () => {
    await writeSkill(libraryPath, "nuxt-api", "nuxt-api");
    await writeSkill(libraryPath, "nuxt-ui", "nuxt-ui");

    const config = createDefaultConfig();
    config.libraryPath = libraryPath;
    await saveConfig(config);

    await runGroupAddCommand("nuxt", ["nuxt-api", "nuxt-ui"]);
    let index = await loadLibraryIndex(libraryPath);
    expect(index.groups?.nuxt).toEqual(["nuxt-api", "nuxt-ui"]);

    await runGroupRmCommand("nuxt", ["nuxt-api"]);
    index = await loadLibraryIndex(libraryPath);
    expect(index.groups?.nuxt).toEqual(["nuxt-ui"]);

    await runGroupRmCommand("nuxt", []);
    index = await loadLibraryIndex(libraryPath);
    expect(index.groups?.nuxt).toBeUndefined();

    expect(generateCompletionScript("zsh")).toContain("compdef _skillctl skillctl");
    expect(generateCompletionScript("bash")).toContain("_skillctl_completions");
    expect(generateCompletionScript("fish")).toContain("complete -c skillctl");
    expect(generateCompletionScript("invalid")).toBeNull();
  });

  it("blocks path traversal in SKILL.md frontmatter and .skillctl.json, and strips symlinks on install", async () => {
    const config = createDefaultConfig();
    config.libraryPath = libraryPath;
    await saveConfig(config);

    // 1. Untrusted repo with path-traversal SKILL.md name + malicious symlink
    const evilRepo = path.join(tmpHome, "evil-repo");
    const evilTraversal = path.join(evilRepo, "bad-skill");
    await fs.mkdir(evilTraversal, { recursive: true });
    await fs.writeFile(
      path.join(evilTraversal, "SKILL.md"),
      "---\nname: ../../escaped\ndescription: Evil\n---\n",
      "utf8",
    );

    const safeSkill = path.join(evilRepo, "safe-skill");
    await fs.mkdir(safeSkill, { recursive: true });
    await fs.writeFile(
      path.join(safeSkill, "SKILL.md"),
      "---\nname: safe-skill\ndescription: Safe skill with sneaky symlink\n---\n",
      "utf8",
    );
    await fs.symlink("/etc/hosts", path.join(safeSkill, "leaked-link"));

    // Create a sentinel directory outside skills/ that must NOT be touched
    const sentinel = path.join(tmpHome, "escaped");
    await fs.mkdir(sentinel, { recursive: true });

    await runInstallCommand(evilRepo, { overwrite: true });

    // Sentinel untouched, traversal skipped
    expect((await fs.stat(sentinel)).isDirectory()).toBe(true);
    // Safe skill installed, but symlink stripped
    const installedSafe = path.join(getLibrarySkillsDir(libraryPath), "safe-skill");
    expect((await fs.stat(path.join(installedSafe, "SKILL.md"))).isFile()).toBe(true);
    await expect(fs.lstat(path.join(installedSafe, "leaked-link"))).rejects.toThrow();

    // 2. Malicious .skillctl.json with traversal skill name is rejected on sync
    await saveProjectManifest(projectDir, {
      skills: { "../../escaped": { mode: "copy" } },
    });
    await expect(syncProject(projectDir, config)).rejects.toThrow(/unsafe skill name/i);
  });
});
