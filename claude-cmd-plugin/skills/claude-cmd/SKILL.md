---
name: claude-cmd
description: >
  Use this skill whenever the user wants to browse, search, install, or manage Claude Code
  commands from the community repository. Trigger when the user says things like "find a
  command for X", "is there a Claude command that does Y", "install a command", "manage my
  Claude commands", "set up a CLAUDE.md", "create a project configuration", or "manage MCP
  servers". Also trigger for any request to scaffold a new Claude Code project with templates
  (Node.js, React, Python, etc.) or configure security profiles. Skip for general Claude Code
  usage questions that don't involve command management, and skip when the user is asking
  about Claude's built-in capabilities rather than community commands.
---

# Claude CMD — Claude Code Commands Manager

A lightweight CLI tool for managing Claude commands, CLAUDE.md configurations, and MCP servers.
184+ community commands available from the online repository.

## Prerequisites

```bash
npm install -g claude-cmd@latest
```

Verify install: `claude-cmd --version`

## Core Usage

```bash
claude-cmd                        # Launch interactive menu (recommended)
claude-cmd list                   # List all installed commands
claude-cmd search <query>         # Search 184+ community commands
claude-cmd install <name>         # Install a specific command
claude-cmd --local search <q>     # Search local command repository
claude-cmd --version              # Show version
claude-cmd --help                 # Full help
```

## Interactive Menu Options

When you run `claude-cmd` without arguments, you get a full interactive menu covering:

- **Command Management** — Browse, search and install from 184+ commands
- **CLAUDE.md Management** — Create project-specific Claude instructions with templates
- **Security & Permissions** — Configure strict/moderate/permissive security profiles
- **MCP Server Management** — List and view locally configured MCP servers
- **Project Initialisation** — Quick setup for new Claude Code projects

## CLAUDE.md Templates Available

| Template | Best for |
|---|---|
| Node.js | Express APIs, npm projects |
| React | Frontend SPA projects |
| Python | Scripts, data projects, FastAPI |
| Generic | Any project type |

Templates include local override support via `CLAUDE.local.md` (gitignored).

## File Structure Managed

```
~/.claude/
├── commands/           # Installed community commands
├── settings.json       # Global Claude Code config
└── CLAUDE.md           # Global Claude instructions

project/
├── CLAUDE.md           # Project-specific instructions
└── CLAUDE.local.md     # Local overrides (gitignored)
```

## Common Workflows

**Find and install a git workflow command:**
```bash
claude-cmd search git
claude-cmd install git-helper
```

**Set up a Python project:**
```bash
cd my-python-project
claude-cmd  # → Project Initialisation → Python template
```

**Configure strict security for production work:**
```bash
claude-cmd  # → Security & Permissions → Strict profile
```
