---
name: claude-cmd
description: >
  Use when the user wants to find, install, or manage Claude Code commands from the community
  repository (184+ available). Trigger phrases: "find a command for X", "is there a Claude
  command that does Y", "install a command", "search for Claude commands", "set up CLAUDE.md",
  "create a project config", "initialise a new project", "manage MCP servers via CLI".
  Do NOT trigger for: general Claude usage questions, built-in Claude capabilities, writing
  code, or anything not explicitly about managing commands/configs. This is a management
  tool — not a coding assistant.
---

# Claude CMD — Claude Code Commands Manager

Manages Claude Code slash commands, CLAUDE.md project configs, and MCP server listings.
Run `npm install -g claude-cmd@latest` if not already installed.

## Workflow

1. **Start interactive mode** (recommended for first-time or exploratory use):
   ```bash
   claude-cmd
   ```
   Choose from: Command Management / CLAUDE.md / Security / MCP Servers / Project Init

2. **Direct search** (when user knows what they want):
   ```bash
   claude-cmd search <topic>        # e.g. claude-cmd search git
   claude-cmd search <topic> --local
   ```

3. **Install a found command**:
   ```bash
   claude-cmd install <command-name>
   claude-cmd list                  # verify it was installed
   ```

4. **Set up a CLAUDE.md** for a new project:
   ```bash
   cd /path/to/project
   claude-cmd   # → CLAUDE.md Management → choose template
   ```
   Templates: Node.js, React, Python, Generic. Supports `CLAUDE.local.md` overrides (gitignored).

5. **Configure security profile** when user needs to lock down permissions:
   ```bash
   claude-cmd   # → Security & Permissions → Strict / Moderate / Permissive
   ```

## Commands

```bash
claude-cmd                    # Interactive menu
claude-cmd list               # List installed commands
claude-cmd search <query>     # Search 184+ community commands
claude-cmd install <n>        # Install by name
claude-cmd --local search <q> # Search local repo only
claude-cmd --version
claude-cmd --help
```

## File Locations

```
~/.claude/commands/     # All installed commands live here
~/.claude/settings.json # Global config
~/.claude/CLAUDE.md     # Global Claude instructions
project/CLAUDE.md       # Project-specific (created by this tool)
project/CLAUDE.local.md # Local overrides (gitignored)
```

## Common Mistakes

- **Don't run `claude-cmd` from wrong directory** when creating project CLAUDE.md — always `cd` to the project root first
- **Don't confuse community commands with built-in `/` commands** — community commands are installed to `~/.claude/commands/` and appear as `/project:command-name`
- **Check `claude-cmd list`** after install to confirm it registered correctly

## Decision Guide

Use `claude-cmd` when the user wants to **manage** Claude — not when they want Claude to **do** something. If the user says "help me build X", use GSD instead.
