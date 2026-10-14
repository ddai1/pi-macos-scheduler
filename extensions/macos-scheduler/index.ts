import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { mkdir, readdir, readFile, stat, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { idFromText, plistEscape, scriptQuote } from "./helpers.mjs";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const execFileAsync = promisify(execFile);
const home = homedir();
const agentsDir = join(home, "Library", "LaunchAgents");
const scriptsDir = join(home, ".pi", "scheduled-tasks");
const labelPrefix = "com.pi.schedule.";

const scheduleTask = defineTool({
  name: "schedule_task",
  label: "Schedule task",
  description: "Create a macOS launchd schedule. Use only after understanding the user's natural-language request. The user will be shown a confirmation before creation.",
  parameters: Type.Object({
    name: Type.String({ description: "Short human-readable task name" }),
    frequency: Type.Union([Type.Literal("daily"), Type.Literal("weekly")]),
    weekday: Type.Optional(Type.Number({ description: "launchd weekday: 1 Sunday through 7 Saturday; required for weekly tasks" })),
    hour: Type.Number({ description: "Hour in local time, 0-23" }),
    minute: Type.Number({ description: "Minute, 0-59" }),
    kind: Type.Union([Type.Literal("shell"), Type.Literal("pi")]),
    task: Type.String({ description: "Shell command for shell tasks, or natural-language prompt for Pi tasks" }),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    if (process.platform !== "darwin") {
      return { content: [{ type: "text", text: "Scheduling currently supports macOS launchd only." }], details: {} };
    }

    const p = params as {
      name: string; frequency: "daily" | "weekly"; weekday?: number;
      hour: number; minute: number; kind: "shell" | "pi"; task: string;
    };
    if (!Number.isInteger(p.hour) || p.hour < 0 || p.hour > 23 || !Number.isInteger(p.minute) || p.minute < 0 || p.minute > 59) {
      throw new Error("Invalid time; hour must be 0-23 and minute must be 0-59.");
    }
    if (p.frequency === "weekly" && (!Number.isInteger(p.weekday) || p.weekday! < 1 || p.weekday! > 7)) {
      throw new Error("Weekly tasks require weekday 1-7 (Sunday-Saturday).");
    }
    if (!p.task.trim()) throw new Error("Task cannot be empty.");

    const id = `${idFromText(p.name)}-${Date.now().toString(36)}`;
    const label = `${labelPrefix}${id}`;
    const scriptPath = join(scriptsDir, `${id}.sh`);
    const plistPath = join(agentsDir, `${label}.plist`);
    const logPath = join(home, "Library", "Logs", `${label}.log`);

    const dangerous = /(^|[;&|])\s*(sudo|rm\s+-rf|shutdown|reboot|diskutil)\b/i.test(p.task);
    const summary = [
      `Name: ${p.name}`,
      `When: ${p.frequency === "weekly" ? `weekday ${p.weekday}` : "every day"} at ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`,
      `Type: ${p.kind}`,
      `Task: ${p.task}`,
      dangerous ? "WARNING: this task contains a potentially destructive command." : "",
    ].filter(Boolean).join("\n");

    if (ctx.hasUI && !(await ctx.ui.confirm("Create scheduled task?", summary))) {
      return { content: [{ type: "text", text: "Schedule cancelled." }], details: { cancelled: true } };
    }

    await mkdir(scriptsDir, { recursive: true });
    await mkdir(agentsDir, { recursive: true });

    const body = p.kind === "shell"
      ? `#!/bin/zsh\nset -u\nexport PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"\nLOG=${scriptQuote(logPath)}\nmkdir -p "${home}/Library/Logs"\n{ echo "===== $(date -u '+%Y-%m-%dT%H:%M:%SZ') ====="; ${p.task}; } >> "$LOG" 2>&1\n`
      : `#!/bin/zsh\nset -u\nexport PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"\nLOG=${scriptQuote(logPath)}\n{ echo "===== $(date -u '+%Y-%m-%dT%H:%M:%SZ') ====="; pi --print --no-session --no-approve --tools read,grep,find,ls ${scriptQuote(p.task)}; } >> "$LOG" 2>&1\n`;
    await writeFile(scriptPath, body, "utf8");
    await chmod(scriptPath, 0o700);

    const weekdayXml = p.frequency === "weekly" ? `\n    <key>Weekday</key>\n    <integer>${p.weekday}</integer>` : "";
    const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple Computer//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n  <key>Label</key><string>${plistEscape(label)}</string>\n  <key>ProgramArguments</key><array><string>${plistEscape(scriptPath)}</string></array>\n  <key>StartCalendarInterval</key><dict>${weekdayXml}\n    <key>Hour</key><integer>${p.hour}</integer>\n    <key>Minute</key><integer>${p.minute}</integer>\n  </dict>\n  <key>ProcessType</key><string>Background</string>\n</dict></plist>\n`;
    await writeFile(plistPath, plist, "utf8");

    const domain = `gui/${process.getuid?.() ?? ""}`;
    await execFileAsync("launchctl", ["bootstrap", domain, plistPath]);
    return { content: [{ type: "text", text: `Scheduled ${p.name}. ID: ${id}\nLog: ${logPath}` }], details: { id, label, plistPath, logPath } };
  },
});

export default function schedulerExtension(pi: ExtensionAPI) {
  pi.registerTool(scheduleTask);

  pi.registerCommand("schedule", {
    description: "Create a scheduled task from natural language",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify("Usage: /schedule <natural-language task>", "warning");
        return;
      }
      await pi.sendUserMessage(
        `Interpret this scheduling request. Use the schedule_task tool to create it, but do not run the task now. Ask a clarification question if the time, frequency, or action is ambiguous. Request: ${args.trim()}`,
        { deliverAs: "followUp" },
      );
    },
  });

  pi.registerCommand("schedules", {
    description: "Show active and inactive Pi schedules",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/schedules requires TUI mode", "error");
        return;
      }

      type ScheduleRow = { id: string; state: "SCHEDULED" | "RUNNING" | "DISABLED" | "INACTIVE" };
      let rows: ScheduleRow[] = [];
      let loading = true;
      let selected = 0;
      let detail = false;
      let detailLoading = false;
      let detailLines: string[] = [];
      let detailOffset = 0;

      const refresh = async (tui: { requestRender: () => void }) => {
        loading = true;
        tui.requestRender();
        try {
          const files = (await readdir(agentsDir)).filter((f) => f.startsWith(labelPrefix) && f.endsWith(".plist"));
          const domain = `gui/${process.getuid?.() ?? ""}`;
          rows = await Promise.all(files.map(async (file) => {
            const id = file.replace(/^com\.pi\.schedule\./, "").replace(/\.plist$/, "");
            const label = `${labelPrefix}${id}`;
            try {
              const result = await execFileAsync("launchctl", ["print", `${domain}/${label}`]);
              const state = /state = running/.test(result.stdout) ? "RUNNING" : "SCHEDULED";
              return { id, state };
            } catch {
              try {
                const disabled = await execFileAsync("launchctl", ["print-disabled", domain]);
                if (new RegExp(`\\"${label}\\"\\s*=>\\s*true`).test(disabled.stdout)) {
                  return { id, state: "DISABLED" as const };
                }
              } catch {}
              return { id, state: "INACTIVE" as const };
            }
          }));
        } catch {
          rows = [];
        } finally {
          loading = false;
          tui.requestRender();
        }
      };

      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        const openLogs = async (row: { id: string }) => {
          const logPath = join(home, "Library", "Logs", `${labelPrefix}${row.id}.log`);
          const logText = await readFile(logPath, "utf8").catch(() => "");
          type Run = { timestamp: string; lines: string[] };
          const runs: Run[] = [];
          let current: Run | undefined;
          for (const line of logText.split("\n")) {
            const marker = line.match(/^===== (.+) =====$/);
            if (marker) {
              current = { timestamp: marker[1], lines: [] };
              runs.push(current);
            } else if (current) {
              current.lines.push(line);
            }
          }
          if (!runs.length && logText.trim()) runs.push({ timestamp: "Legacy log (timestamp unavailable in UTC)", lines: logText.split("\n") });
          let selectedRun = Math.max(0, runs.length - 1);
          let viewingRun = false;
          let offset = 0;

          await ctx.ui.custom<void>((logTui, logTheme, _logKeys, logDone) => {
            const logComponent = {
              render(width: number): string[] {
                const innerWidth = Math.max(20, width - 4);
                const content: string[] = [];
                if (!viewingRun) {
                  content.push(logTheme.fg("muted", "↑↓ select run   Enter view logs   Esc close"), "");
                  if (!runs.length) content.push(logTheme.fg("dim", "No runs recorded yet."));
                  else runs.forEach((run, index) => {
                    const marker = index === selectedRun ? "❯ " : "  ";
                    const zone = run.timestamp.startsWith("Legacy") ? "" : " UTC";
                    content.push(`${logTheme.fg("accent", marker)}${run.timestamp}${zone}`);
                  });
                } else {
                  const run = runs[selectedRun];
                  content.push(logTheme.fg("muted", "↑↓ scroll   Esc back to run list"), "");
                  const runZone = run?.timestamp?.startsWith("Legacy") ? "" : " UTC";
                  content.push(logTheme.fg("accent", `${run?.timestamp ?? "Unknown"}${runZone}`), "");
                  const lines = run?.lines ?? ["No log output."];
                  content.push(...lines.slice(offset, offset + 22).map((line) => logTheme.fg("text", line)));
                  if (offset + 22 < lines.length) content.push(logTheme.fg("dim", "… more below"));
                }
                const fit = (line: string) => {
                  const clipped = truncateToWidth(line, innerWidth, "");
                  return `│ ${clipped}${" ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)))} │`;
                };
                const title = `─ Logs: ${row.id} ${"─".repeat(Math.max(0, innerWidth - row.id.length - 9))}`;
                return [
                  logTheme.fg("borderAccent", `┌${truncateToWidth(title, innerWidth, "─")}┐`),
                  ...content.map(fit),
                  logTheme.fg("borderAccent", `└${"─".repeat(innerWidth)}┘`),
                ].map((line) => logTheme.bg("toolPendingBg", truncateToWidth(line, width, "")));
              },
              handleInput(data: string) {
                if (matchesKey(data, Key.escape)) {
                  if (viewingRun) { viewingRun = false; offset = 0; logTui.requestRender(); }
                  else logDone();
                } else if (matchesKey(data, Key.up)) {
                  if (viewingRun) offset = Math.max(0, offset - 1); else selectedRun = Math.max(0, selectedRun - 1);
                  logTui.requestRender();
                } else if (matchesKey(data, Key.down)) {
                  if (viewingRun) offset = Math.min(Math.max(0, (runs[selectedRun]?.lines.length ?? 1) - 22), offset + 1);
                  else selectedRun = Math.min(Math.max(0, runs.length - 1), selectedRun + 1);
                  logTui.requestRender();
                } else if (matchesKey(data, Key.enter) && !viewingRun && runs.length) {
                  viewingRun = true; offset = 0; logTui.requestRender();
                }
              },
              invalidate() {},
            };
            return logComponent;
          }, { overlay: true, overlayOptions: { width: "85%", maxHeight: "75%", anchor: "center" } });
        };

        const openDetail = async () => {
          const row = rows[selected];
          if (!row) return;
          detailLoading = true;
          detail = true;
          detailOffset = 0;
          tui.requestRender();
          try {
            const plistPath = join(agentsDir, `${labelPrefix}${row.id}.plist`);
            const scriptPath = join(scriptsDir, `${row.id}.sh`);
            const logPath = join(home, "Library", "Logs", `${labelPrefix}${row.id}.log`);
            const [plist, script, logInfo] = await Promise.all([
              readFile(plistPath, "utf8").catch(() => "(plist is missing)"),
              readFile(scriptPath, "utf8").catch(() => "(script is missing)"),
              stat(logPath).catch(() => undefined),
            ]);
            detailLines = [
              `Task: ${row.id}`,
              `Status: ${row.state}`,
              `LaunchAgent: ${plistPath}`,
              `Script: ${scriptPath}`,
              `Log: ${logPath}`,
              `Last run/log update (UTC): ${logInfo ? new Date(logInfo.mtimeMs).toISOString() : "never"}`,
              "",
              "Description / command:",
              ...script.split("\n").filter((line) => line.trim() && !line.startsWith("#!")),
              "",
              "Schedule definition:",
              ...plist.split("\n").filter((line) => line.trim()),
            ];
          } finally {
            detailLoading = false;
            tui.requestRender();
          }
        };

        const component = {
          render(width: number): string[] {
            const innerWidth = Math.max(20, width - 4);
            const content: string[] = [];
            if (detail) {
              content.push(theme.fg("muted", "↑↓ scroll   l logs   Esc back to list"));
              content.push("");
              if (detailLoading) content.push(theme.fg("dim", "Loading task details…"));
              else {
                const visibleDetail = detailLines.slice(detailOffset, detailOffset + 18);
                content.push(...visibleDetail.map((line) => theme.fg("text", line)));
                if (detailOffset + 18 < detailLines.length) content.push(theme.fg("dim", "… more below"));
              }
            } else {
              content.push(theme.fg("muted", "↑↓ select   Enter details   r refresh   q / Esc close"));
              content.push("");
              if (loading) content.push(theme.fg("dim", "Loading launchd schedules…"));
              else if (!rows.length) content.push(theme.fg("dim", "No Pi schedules found."));
              else {
                // Keep the header aligned with the selection marker and task column.
              content.push(theme.fg("muted", "  STATUS     TASK"));
                rows.forEach((row, index) => {
                  const color = row.state === "RUNNING" || row.state === "SCHEDULED" ? "success" : "error";
                  const marker = index === selected ? "❯ " : "  ";
                  content.push(`${theme.fg("accent", marker)}${theme.fg(color, row.state)}  ${row.id}`);
                });
              }
              content.push("");
              content.push(theme.fg("dim", "SCHEDULED = loaded  RUNNING = executing  INACTIVE = not loaded"));
            }

            const fit = (line: string) => {
              const clipped = truncateToWidth(line, innerWidth, "");
              return `│ ${clipped}${" ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)))} │`;
            };
            const titleText = detail ? "Task Details" : "Scheduled Tasks";
            const title = `─ ${titleText} ${"─".repeat(Math.max(0, innerWidth - titleText.length - 3))}`;
            const top = `┌${truncateToWidth(title, innerWidth, "─")}┐`;
            const bottom = `└${"─".repeat(innerWidth)}┘`;
            const framed = [
              theme.fg("borderAccent", top),
              ...content.map(fit),
              theme.fg("borderAccent", bottom),
            ];
            // Paint the complete rectangle so transcript text behind the overlay
            // does not visually bleed into the schedule window.
            return framed.map((line) => theme.bg("toolPendingBg", truncateToWidth(line, width, "")));
          },
          handleInput(data: string) {
            if (detail) {
              if (matchesKey(data, Key.escape)) {
                detail = false;
                tui.requestRender();
              } else if (data === "l") {
                const row = rows[selected];
                if (row) void openLogs(row);
              } else if (matchesKey(data, Key.up)) {
                detailOffset = Math.max(0, detailOffset - 1);
                tui.requestRender();
              } else if (matchesKey(data, Key.down)) {
                detailOffset = Math.min(Math.max(0, detailLines.length - 18), detailOffset + 1);
                tui.requestRender();
              }
              return;
            }
            if (matchesKey(data, Key.escape) || data === "q") done();
            else if (matchesKey(data, Key.up) && rows.length) {
              selected = Math.max(0, selected - 1);
              tui.requestRender();
            } else if (matchesKey(data, Key.down) && rows.length) {
              selected = Math.min(rows.length - 1, selected + 1);
              tui.requestRender();
            } else if (matchesKey(data, Key.enter)) void openDetail();
            else if (data === "r") void refresh(tui);
          },
          invalidate() {},
        };
        void refresh(tui);
        return component;
      }, {
        overlay: true,
        overlayOptions: { width: "70%", maxHeight: "60%", anchor: "center" },
      });
    },
  });
}
