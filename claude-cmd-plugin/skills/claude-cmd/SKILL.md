---
name: claude-cmd
description: Manages Claude Code commands, CLAUDE.md files, and MCP server configs. Use when the user wants to browse or install community commands, scaffold a CLAUDE.md, set up a new project config, or manage MCP servers.
---

# Claude CMD

Manage Claude Code commands, configurations, and MCP servers via the `claude-cmd` CLI.
184+ community commands are available from the online registry.

**Before running any `claude-cmd` command, ensure the npm package is installed:**
```bash
npm install -g claude-cmd@latest
```

## Workflow

### Finding and installing community commands

1. Search the registry:
   ```bash
   claude-cmd search <topic>
   ```
2. Review results. Install the best match:
   ```bash
   claude-cmd install <command-name>
   ```
3. Confirm install with:
   ```bash
   claude-cmd list
   ```

### Setting up a CLAUDE.md for a project

1. Navigate to the project root, then run:
   ```bash
   claude-cmd
   ```
2. Select **CLAUDE.md Management** → choose template matching project type (Node.js, React, Python, Generic).
3. Review the generated file and edit as needed.

### Managing MCP servers

1. Run `claude-cmd` and select **MCP Server Management**.
2. View currently configured servers and their status.

### Full interactive menu

```bash
claude-cmd          # Opens interactive menu covering all features
claude-cmd list     # List installed commands only
claude-cmd --help   # Full CLI reference
```

## Reference

| Command | Action |
|---|---|
| `claude-cmd search <q>` | Search 184+ community commands |
| `claude-cmd install <n>` | Install a command globally |
| `claude-cmd --local search <q>` | Search local repo only |
| `claude-cmd --local install <n>` | Install locally |
| `claude-cmd list` | List installed commands |
| `claude-cmd --version` | Show version |
