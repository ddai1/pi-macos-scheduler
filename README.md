# pi-macos-scheduler

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A standalone [Pi](https://github.com/earendil-works/pi) extension for scheduling shell commands and Pi prompts on macOS using `launchd`. It is designed for macOS, including Apple Silicon Macs, and uses Homebrew's standard `/opt/homebrew/bin` path.

## Installation

Install globally so the extension is available in every Pi project:

```sh
pi install git:github.com/ddai1/pi-macos-scheduler
```

For a project-only installation:

```sh
pi install --local git:github.com/ddai1/pi-macos-scheduler
```

Run `/reload` in an existing Pi session, or start a new session after installing.

## Usage

Create a schedule from natural language:

```text
/schedule every weekday at 9:00 AM, check the deployment status and summarize it
```

Pi asks for clarification when the time, frequency, or action is ambiguous. Before creating a schedule, the extension shows a confirmation containing the parsed schedule and task.

The `/schedule` command supports:

- **Daily** or **weekly** schedules through macOS `launchd`.
- **Shell commands**, executed by a zsh LaunchAgent.
- **Pi prompts**, executed with `pi --print --no-session --no-approve` and read-only tools (`read`, `grep`, `find`, and `ls`).
- UTC-timestamped logs in `~/Library/Logs/`.

View installed schedules and their status:

```text
/schedules
```

In the schedule viewer, use Up/Down to select a task, Enter to inspect details, `r` to refresh, and `q` or Escape to close. From task details, press `l` to inspect recorded runs.

## How it works

Each schedule creates:

- A shell script under `~/.pi/scheduled-tasks/`.
- A LaunchAgent plist under `~/Library/LaunchAgents/` with the label `com.pi.schedule.*`.
- A log file under `~/Library/Logs/`.

The extension loads the LaunchAgent into the current user's GUI launchd domain. It does not require root privileges.

## Requirements

- macOS (the scheduler uses `launchctl` and LaunchAgents).
- Pi with support for TypeScript extensions.
- Node.js 22 or newer in the Pi runtime.
- For Pi tasks, the `pi` executable must be available through the scheduled process PATH.

## Safety

Review the confirmation carefully before creating a schedule. Scheduled shell commands run with your user account and can modify your files or system. The extension highlights commands containing common destructive operations, but this is only a warning and not a security boundary.

Pi tasks are started with `--no-approve` and a read-only tool allowlist. Do not schedule prompts containing sensitive data unless you understand how the task will access and log it.

## License

[MIT](LICENSE)
