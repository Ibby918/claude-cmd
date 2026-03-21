---
name: claude-cmd
description: Manage Claude Code commands, CLAUDE.md files, and MCP servers. Use when the user wants to browse, install, or manage Claude commands, set up project configurations, or manage MCP servers.
---

# Claude CMD — Claude Code Commands Manager

A CLI tool for managing Claude commands, configurations, and workflows. 184+ commands available from the community repository.

## When to Use This Skill

- User wants to browse or install Claude commands
- User wants to create or manage a CLAUDE.md file
- User wants to manage MCP servers
- User wants to set up a new project configuration
- User says "find a command for X" or "install a Claude command"

## Available Commands

```bash
claude-cmd                    # Interactive mode - full menu
claude-cmd list               # List installed commands
claude-cmd search <query>     # Search 184+ community commands
claude-cmd install <name>     # Install a command
claude-cmd --local search     # Search local repository
```

## Key Features

- Browse and install 184+ community commands
- Create project-specific CLAUDE.md templates (Node.js, React, Python, etc.)
- Manage MCP server configurations
- Security profile management (strict, moderate, permissive)
- Works with both local and remote command sources

## Setup Requirement

Requires npm package installed globally:
```bash
npm install -g claude-cmd@latest
```

## Usage Examples

```bash
# Search for git-related commands
claude-cmd search git

# Install a specific command
claude-cmd install git-helper

# Interactive menu
claude-cmd
```
