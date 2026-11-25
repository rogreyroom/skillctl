import { loadMergedProjectManifest } from "./config.js";
import type { LibraryIndex } from "./types.js";

export function findGlobalDuplicates(
  skillNames: string[],
  index: LibraryIndex,
): string[] {
  const globalSet = new Set(index.global);
  return skillNames.filter((name) => globalSet.has(name));
}

export interface ProjectDuplicateHit {
  skill: string;
  projectDir: string;
}

export async function findProjectDuplicates(
  skillNames: string[],
  projectDirs: string[],
): Promise<ProjectDuplicateHit[]> {
  const targetSet = new Set(skillNames);
  const hits: ProjectDuplicateHit[] = [];

  for (const projectDir of projectDirs) {
    const { merged } = await loadMergedProjectManifest(projectDir);
    if (!merged) continue;
    for (const skill of Object.keys(merged.skills)) {
      if (targetSet.has(skill)) {
        hits.push({ skill, projectDir });
      }
    }
  }

  return hits;
}
