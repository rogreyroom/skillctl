import pc from "picocolors";

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, "");
}

export function visibleLength(str: string): number {
  return stripAnsi(str).length;
}

export function getTerminalWidth(): number {
  return Math.max(60, Math.min(process.stdout.columns || 100, 120));
}

export function truncate(text: string, maxLen: number): string {
  if (maxLen <= 1) return "";
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1).trimEnd() + "…";
}

export function padEndVisible(str: string, targetLen: number): string {
  const diff = targetLen - visibleLength(str);
  return diff > 0 ? str + " ".repeat(diff) : str;
}

export const icons = {
  brand: pc.cyan("◆"),
  ok: pc.green("✓"),
  warn: pc.yellow("▲"),
  err: pc.red("✕"),
  bullet: pc.dim("•"),
  arrow: pc.dim("→"),
};

export function badge(
  text: string,
  color: "cyan" | "green" | "blue" | "magenta" | "yellow" | "red" | "dim",
): string {
  const label = ` ${text} `;
  switch (color) {
    case "cyan":
      return pc.bgCyan(pc.black(label));
    case "green":
      return pc.bgGreen(pc.black(label));
    case "blue":
      return pc.bgBlue(pc.white(label));
    case "magenta":
      return pc.bgMagenta(pc.white(label));
    case "yellow":
      return pc.bgYellow(pc.black(label));
    case "red":
      return pc.bgRed(pc.white(label));
    case "dim":
      return pc.dim(`[${text}]`);
  }
}

export function sectionHeader(title: string, subtitle?: string): string {
  const sub = subtitle ? ` ${pc.dim(subtitle)}` : "";
  return `\n${icons.brand} ${pc.bold(title)}${sub}`;
}

function wrapText(text: string, maxWidth: number): string[] {
  if (visibleLength(text) <= maxWidth || text.includes("\x1b[")) {
    return [text];
  }
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (!current) {
      current = word;
    } else if (current.length + 1 + word.length <= maxWidth) {
      current += " " + word;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

export function renderCard(title: string, rows: Array<[string, string]>): string {
  const labelWidth = Math.max(...rows.map(([k]) => visibleLength(k)), 10);
  const maxInner = getTerminalWidth() - 4;
  const maxValueWidth = Math.max(24, maxInner - labelWidth - 2);

  const contentLines: string[] = [];
  for (const [label, value] of rows) {
    const wrapped = wrapText(value, maxValueWidth);
    wrapped.forEach((line, idx) => {
      const prefix =
        idx === 0
          ? pc.dim(padEndVisible(label, labelWidth))
          : " ".repeat(labelWidth);
      contentLines.push(`${prefix}  ${line}`);
    });
  }

  const maxContentWidth = Math.max(
    visibleLength(title) + 2,
    ...contentLines.map((l) => visibleLength(l)),
  );
  const innerWidth = Math.min(Math.max(maxContentWidth, 44), maxInner);

  const titlePart = ` ${pc.bold(pc.cyan(title))} `;
  const topFill = Math.max(
    1,
    innerWidth + 2 - visibleLength(titlePart) - 1,
  );
  const top = `${pc.dim("╭─")}${titlePart}${pc.dim("─".repeat(topFill) + "╮")}`;
  const bottom = pc.dim(`╰${"─".repeat(innerWidth + 2)}╯`);

  const body = contentLines.map((line) => {
    const padded = padEndVisible(line, innerWidth);
    return `${pc.dim("│")} ${padded} ${pc.dim("│")}`;
  });

  return [top, ...body, bottom].join("\n");
}

export function formatSkillRow(opts: {
  name: string;
  nameWidth: number;
  badges?: string[];
  description?: string;
}): string {
  const termWidth = getTerminalWidth();
  const paddedName = padEndVisible(pc.bold(opts.name), opts.nameWidth);
  const badgeStr =
    opts.badges && opts.badges.length > 0 ? ` ${opts.badges.join(" ")}` : "";
  const prefix = `  ${icons.bullet} ${paddedName}${badgeStr}`;

  if (!opts.description) return prefix;

  const remaining = termWidth - visibleLength(prefix) - 3;
  if (remaining < 16) return prefix;

  return `${prefix}  ${pc.dim(truncate(opts.description, remaining))}`;
}
