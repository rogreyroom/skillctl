import fs from "node:fs/promises";
import path from "node:path";
import {
  expandHome,
  getConfigDir,
  getConfigPath,
  getDefaultLibraryPath,
  getProjectLocalManifestPath,
  getProjectManifestPath,
} from "./paths.js";
import type { AppConfig, ProjectManifest } from "./types.js";

export function createDefaultConfig(): AppConfig {
  return {
    libraryPath: getDefaultLibraryPath(),
    agents: {
      claude: false,
    },
    raycast: {
      pinned: [],
    },
    trackedProjects: [],
  };
}

export async function configExists(): Promise<boolean> {
  try {
    await fs.access(getConfigPath());
    return true;
  } catch {
    return false;
  }
}

export async function loadConfig(): Promise<AppConfig> {
  try {
    const raw = await fs.readFile(getConfigPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    const defaults = createDefaultConfig();
    return {
      libraryPath: parsed.libraryPath
        ? expandHome(parsed.libraryPath)
        : defaults.libraryPath,
      agents: {
        claude: parsed.agents?.claude ?? defaults.agents.claude,
      },
      raycast: {
        activeProject: parsed.raycast?.activeProject,
        pinned: Array.isArray(parsed.raycast?.pinned)
          ? [...new Set(parsed.raycast.pinned)]
          : [],
      },
      trackedProjects: Array.isArray(parsed.trackedProjects)
        ? [...new Set(parsed.trackedProjects)]
        : [],
    };
  } catch {
    return createDefaultConfig();
  }
}

export async function saveConfig(config: AppConfig): Promise<void> {
  await fs.mkdir(getConfigDir(), { recursive: true });
  const normalized: AppConfig = {
    libraryPath: expandHome(config.libraryPath),
    agents: {
      claude: Boolean(config.agents.claude),
    },
    raycast: {
      ...(config.raycast.activeProject
        ? { activeProject: path.resolve(config.raycast.activeProject) }
        : {}),
      pinned: [...new Set(config.raycast.pinned)].sort(),
    },
    trackedProjects: [
      ...new Set(config.trackedProjects.map((p) => path.resolve(p))),
    ].sort(),
  };
  await fs.writeFile(
    getConfigPath(),
    JSON.stringify(normalized, null, 2) + "\n",
    "utf8",
  );
}

export async function trackProject(
  config: AppConfig,
  projectDir: string,
): Promise<AppConfig> {
  const abs = path.resolve(projectDir);
  if (!config.trackedProjects.includes(abs)) {
    config.trackedProjects.push(abs);
    await saveConfig(config);
  }
  return config;
}

async function readManifestFile(
  filePath: string,
): Promise<ProjectManifest | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<ProjectManifest>;
    return {
      skills: parsed.skills ?? {},
      claude: parsed.claude,
      gitExclude: parsed.gitExclude,
    };
  } catch {
    return null;
  }
}

async function writeManifestFile(
  filePath: string,
  manifest: ProjectManifest,
): Promise<void> {
  const sortedSkills: ProjectManifest["skills"] = {};
  for (const key of Object.keys(manifest.skills).sort()) {
    sortedSkills[key] = manifest.skills[key];
  }
  const output: ProjectManifest = {
    skills: sortedSkills,
    ...(manifest.claude !== undefined ? { claude: manifest.claude } : {}),
    ...(manifest.gitExclude !== undefined
      ? { gitExclude: manifest.gitExclude }
      : {}),
  };
  await fs.writeFile(
    filePath,
    JSON.stringify(output, null, 2) + "\n",
    "utf8",
  );
}

export async function loadProjectManifest(
  projectDir: string,
): Promise<ProjectManifest | null> {
  return readManifestFile(getProjectManifestPath(projectDir));
}

export async function saveProjectManifest(
  projectDir: string,
  manifest: ProjectManifest,
): Promise<void> {
  await writeManifestFile(getProjectManifestPath(projectDir), manifest);
}

export async function loadProjectLocalManifest(
  projectDir: string,
): Promise<ProjectManifest | null> {
  return readManifestFile(getProjectLocalManifestPath(projectDir));
}

export async function saveProjectLocalManifest(
  projectDir: string,
  manifest: ProjectManifest,
): Promise<void> {
  await writeManifestFile(getProjectLocalManifestPath(projectDir), manifest);
}

export async function removeManifestIfEmpty(filePath: string): Promise<void> {
  const manifest = await readManifestFile(filePath);
  if (manifest && Object.keys(manifest.skills).length === 0) {
    await fs.rm(filePath, { force: true });
  }
}

export interface MergedProjectManifest {
  shared: ProjectManifest | null;
  local: ProjectManifest | null;
  merged: ProjectManifest | null;
}

export async function loadMergedProjectManifest(
  projectDir: string,
): Promise<MergedProjectManifest> {
  const [shared, local] = await Promise.all([
    loadProjectManifest(projectDir),
    loadProjectLocalManifest(projectDir),
  ]);

  if (!shared && !local) {
    return { shared: null, local: null, merged: null };
  }

  const merged: ProjectManifest = {
    skills: {
      ...(shared?.skills ?? {}),
      ...(local?.skills ?? {}),
    },
    claude: local?.claude ?? shared?.claude,
    gitExclude: local?.gitExclude ?? shared?.gitExclude,
  };

  return { shared, local, merged };
}
