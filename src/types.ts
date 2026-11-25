export type InstallMode = "link" | "copy";

export interface AppConfig {
  libraryPath: string;
  agents: {
    claude: boolean;
  };
  raycast: {
    activeProject?: string;
    pinned: string[];
  };
  trackedProjects: string[];
}

export interface SkillMatchRule {
  deps?: string[];
  files?: string[];
}

export interface SkillIndexEntry {
  match?: SkillMatchRule;
  defaultMode?: InstallMode;
  description?: string;
}

export interface LibraryIndex {
  global: string[];
  skills: Record<string, SkillIndexEntry>;
}

export interface ProjectSkillEntry {
  mode: InstallMode;
  hash?: string;
}

export interface ProjectManifest {
  skills: Record<string, ProjectSkillEntry>;
  claude?: boolean;
  gitExclude?: boolean;
}

export interface SkillValidationIssue {
  code:
    | "missing-skill-md"
    | "invalid-frontmatter"
    | "missing-name"
    | "invalid-name-format"
    | "name-mismatch"
    | "missing-description";
  message: string;
}

export interface SkillInfo {
  name: string;
  dirPath: string;
  skillMdPath: string;
  frontmatterName?: string;
  description?: string;
  issues: SkillValidationIssue[];
}

export interface DetectionMatch {
  skill: string;
  reasons: string[];
}

export interface DoctorIssue {
  severity: "error" | "warn";
  scope: "library" | "global" | "project" | "raycast";
  code: string;
  message: string;
  fixable: boolean;
  fix?: () => Promise<void>;
}
