import os from "node:os";
import path from "node:path";

export function getHomeDir(): string {
  return process.env.SKILLCTL_HOME || os.homedir();
}

export function expandHome(inputPath: string): string {
  if (inputPath === "~") {
    return getHomeDir();
  }
  if (inputPath.startsWith("~/")) {
    return path.join(getHomeDir(), inputPath.slice(2));
  }
  return path.resolve(inputPath);
}

export function getConfigDir(): string {
  return (
    process.env.SKILLCTL_CONFIG_DIR ||
    path.join(getHomeDir(), ".config", "skillctl")
  );
}

export function getConfigPath(): string {
  return path.join(getConfigDir(), "config.json");
}

export function getDefaultLibraryPath(): string {
  return path.join(getHomeDir(), "dotfiles", "agent-skills");
}

export function getGlobalAgentsSkillsDir(): string {
  return path.join(getHomeDir(), ".agents", "skills");
}

export function getGlobalClaudeSkillsDir(): string {
  return path.join(getHomeDir(), ".claude", "skills");
}

export function getRaycastSkillsDir(): string {
  return path.join(getHomeDir(), ".config", "raycast", "skills");
}

export function getProjectAgentsSkillsDir(projectDir: string): string {
  return path.join(projectDir, ".agents", "skills");
}

export function getProjectClaudeSkillsDir(projectDir: string): string {
  return path.join(projectDir, ".claude", "skills");
}

export function getProjectCursorSkillsDir(projectDir: string): string {
  return path.join(projectDir, ".cursor", "skills");
}

export function getProjectManifestPath(projectDir: string): string {
  return path.join(projectDir, ".skillctl.json");
}

export function getProjectLocalManifestPath(projectDir: string): string {
  return path.join(projectDir, ".skillctl.local.json");
}

export function getLibrarySkillsDir(libraryPath: string): string {
  return path.join(expandHome(libraryPath), "skills");
}

export function getLibraryIndexPath(libraryPath: string): string {
  return path.join(expandHome(libraryPath), "index.yaml");
}
