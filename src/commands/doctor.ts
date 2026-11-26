import path from "node:path";
import pc from "picocolors";
import { loadConfig } from "../config.js";
import { runDoctor } from "../doctor.js";
import { badge, icons, sectionHeader } from "../ui.js";

export async function runDoctorCommand(options: {
  fix?: boolean;
  dir?: string;
}): Promise<void> {
  const projectDir = path.resolve(options.dir ?? process.cwd());
  const config = await loadConfig();
  const issues = await runDoctor(config, projectDir);

  console.log(sectionHeader("skillctl doctor", projectDir));

  if (issues.length === 0) {
    console.log(
      `  ${icons.ok} ${pc.green("No issues found. Everything looks healthy!")}\n`,
    );
    return;
  }

  let fixedCount = 0;
  let errorCount = 0;
  let warnCount = 0;

  for (const issue of issues) {
    if (issue.severity === "error") errorCount++;
    else warnCount++;

    const scopeTag = pc.dim(`[${issue.scope}]`);

    if (options.fix && issue.fixable && issue.fix) {
      await issue.fix();
      fixedCount++;
      console.log(
        `  ${badge("FIXED", "green")} ${scopeTag} ${issue.message}`,
      );
    } else {
      const icon = issue.severity === "error" ? icons.err : icons.warn;
      const hint = issue.fixable ? pc.dim(" (fixable with --fix)") : "";
      console.log(`  ${icon} ${scopeTag} ${issue.message}${hint}`);
    }
  }

  console.log("");
  if (options.fix) {
    const remaining = issues.length - fixedCount;
    console.log(
      `  ${icons.ok} ${pc.cyan(`Doctor finished: ${fixedCount} fixed, ${remaining} remaining.`)}\n`,
    );
  } else {
    const summary = [
      errorCount > 0 ? pc.red(`${errorCount} error(s)`) : pc.dim("0 errors"),
      warnCount > 0 ? pc.yellow(`${warnCount} warning(s)`) : pc.dim("0 warnings"),
    ].join(pc.dim(" · "));
    const fixHint = issues.some((i) => i.fixable)
      ? `  Run ${pc.cyan("skillctl doctor --fix")} to auto-repair.`
      : "";
    console.log(`  ${summary}${fixHint}\n`);
    if (errorCount > 0) {
      process.exitCode = 1;
    }
  }
}
