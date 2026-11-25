import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  importSkillDirToLibrary,
  inspectSkillDir,
  listLibrarySkills,
  saveLibraryIndex,
} from "../src/library.js";
import { syncGlobal, syncProject, syncRaycast } from "../src/linker.js";
import {
  getGlobalAgentsSkillsDir,
  getGlobalClaudeSkillsDir,
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
});
