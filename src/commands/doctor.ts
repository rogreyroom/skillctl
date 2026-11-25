import path from "node:path";
import pc from "picocolors";
import { loadConfig } from "../config.js";
import { runDoctor } from "../doctor.js";

export async function runDoctorCommand(options: {
  fix?: boolean;
  dir?: string;
}): Promise<void> {
  const projectDir = path.resolve(options.dir ?? process.cwd());
  const config = await loadConfig();
  const issues = await runDoctor(config, projectDir);

  if (issues.length === 0) {
    console.log(pc.green("✓ No issues found. Everything looks healthy!"));
    return;
  }

  let fixedCount = 0;
  let errorCount = 0;
  let warnCount = 0;

  for (const issue of issues) {
    if (issue.severity === "error") errorCount++;
    else warnCount++;

    const tag =
      issue.severity === "error"
        ? pc.red("ERROR")
        : pc.yellow("WARN ");
    const scope = pc.dim(`[${issue.scope}]`);

    if (options.fix && issue.fixable && issue.fix) {
      await issue.fix();
      fixedCount++;
      console.log(`${pc.green("FIXED")} ${scope} ${issue.message}`);
    } else {
      const hint = issue.fixable ? pc.dim(" (fixable with --fix)") : "";
      console.log(`${tag} ${scope} ${issue.message}${hint}`);
    }
  }

  console.log("");
  if (options.fix) {
    console.log(
      pc.cyan(
        `Doctor finished: ${fixedCount} fixed, ${issues.length - fixedCount} remaining.`,
      ),
    );
  } else {
    console.log(
      `Found ${pc.red(`${errorCount} error(s)`)} and ${pc.yellow(`${warnCount} warning(s)`)}.` +
        (issues.some((i) => i.fixable)
          ? ` Run ${pc.cyan("skillctl doctor --fix")} to auto-repair fixable issues.`
          : ""),
    );
    if (errorCount > 0) {
      process.exitCode = 1;
    }
  }
}
