#!/usr/bin/env node

import { ClaudeCommandCLI } from './cli';
import { CommandManager } from './commands/command-manager';
import { FileSystemManager } from './core/filesystem';
import { ClaudeCommandAPI } from './core/api';
import { colorize } from './utils/colors';
import { validateSkillFile, printValidationResult } from './commands/skill-validator';
import { PluginInitManager } from './commands/plugin-init-manager';
import { PluginManager } from './commands/plugin-manager';
import * as path from 'path';
import * as os from 'os';

// Configuration constants
const DEFAULT_COMMANDS_URL = 'https://raw.githubusercontent.com/kiliczsh/claude-cmd/main/commands/commands.json';
const LOCAL_COMMANDS_PATH = 'commands/commands.json';

// Command-line interface functions
async function listCommands(): Promise<void> {
  const fs = new FileSystemManager();
  const commandsUrl = process.env.CLAUDE_CMD_URL || DEFAULT_COMMANDS_URL;
  const commandManager = new CommandManager(fs, new ClaudeCommandAPI(commandsUrl));
  await commandManager.listInstalledCommands();
}

async function installCommand(commandName: string): Promise<void> {
  const fs = new FileSystemManager();
  const commandsUrl = process.env.CLAUDE_CMD_URL || DEFAULT_COMMANDS_URL;
  const api = new ClaudeCommandAPI(commandsUrl);
  const commandManager = new CommandManager(fs, api);
  await commandManager.installSpecificCommand(commandName);
}

async function searchCommands(query: string): Promise<void> {
  const commandsUrl = process.env.CLAUDE_CMD_URL || DEFAULT_COMMANDS_URL;
  const api = new ClaudeCommandAPI(commandsUrl);
  
  console.log(`Searching for commands matching: ${query}...`);
  
  try {
    const results = await api.searchCommands(query);
    
    if (!results || !results.commands || results.commands.length === 0) {
      console.log(`No commands found matching '${query}'.`);
      return;
    }
    
    console.log(`Found ${results.commands.length} command(s):`);
    results.commands.forEach(command => {
      console.log(`\n- ${command.name}`);
      if (command.description) {
        console.log(`  ${command.description}`);
      }
      if (command.author) {
        console.log(`  Author: ${command.author}`);
      }
      if (command.tags) {
        console.log(`  Tags: ${command.tags.join(', ')}`);
      }
    });
  } catch (error) {
    console.error(`Search failed: ${(error as Error).message}`);
  }
}

function showHelp(): void {
  console.log(`
claude-cmd - A CLI tool to manage Claude commands

USAGE:
  claude-cmd [OPTIONS] [COMMAND]

OPTIONS:
  -h, --help                    Show this help message
  --local                       Use local commands folder (./commands/commands.json)

COMMANDS:
  list                          List all installed Claude command files
  install <command-name>        Install a command from the repository
  search <query>                Search available commands in the repository
  validate <skill-path>         Validate a SKILL.md file (use --json for machine-readable output)
  plugin install <input>         Install a plugin (@anthropic/name, ./path, or bare-name)
  plugin install --local <path>  Install a plugin from local directory
  plugin install <input> --no-cross-client  Skip cross-client (~/.agents/skills/) write
  plugin list                   List installed plugins (name, version, source, status, skills count)
  plugin list --json             Machine-readable JSON output (CI-friendly)
  plugin list --check-updates   Also check for available updates
  plugin update [name]          Update a specific plugin or all installed plugins
  plugin update [name] --dry-run  Show what would change without applying updates
  plugin remove <name>           Remove an installed plugin (prompts for confirmation)
  plugin init                   Scaffold a new plugin directory interactively
  plugin init --name <n>        Scaffold non-interactively (also: --description, --author, --skill)

DESCRIPTION:
  Interactive CLI tool for managing Claude commands, configurations, and workflows.
  Run without arguments to enter interactive mode with full features.

EXAMPLES:
  claude-cmd                              Launch interactive mode (recommended)
  claude-cmd --local                      Launch interactive mode with local commands
  claude-cmd list                         List all Claude command files
  claude-cmd --local search api          Search local commands for 'api'
  claude-cmd install git-helper           Install the 'git-helper' command
  claude-cmd validate ./skills/foo/SKILL.md   Validate a SKILL.md file
  claude-cmd validate ./skills/foo/SKILL.md --json  Validate with JSON output
  claude-cmd plugin install @anthropic/pdf          Install from Anthropic marketplace
  claude-cmd plugin install ./my-skill              Install from local path
  claude-cmd plugin install --local ./my-skill      Install from local path (--local flag)
  claude-cmd plugin install git-helper              Install from claude-cmd registry
  claude-cmd plugin list                            List all installed plugins
  claude-cmd plugin list --json                     List plugins as JSON (CI-friendly)
  claude-cmd plugin list --check-updates            List plugins and check for updates
  claude-cmd plugin update                          Update all installed plugins
  claude-cmd plugin update git-helper               Update a specific plugin
  claude-cmd plugin update git-helper --dry-run     Preview update without applying
  claude-cmd plugin remove git-helper               Remove an installed plugin
  claude-cmd plugin init                            Scaffold a new plugin interactively
  claude-cmd plugin init --name my-plugin --description "My plugin" --author "Me"
  claude-cmd --help                       Show this help message
`);
}

async function validateSkill(skillPath: string, jsonMode: boolean): Promise<void> {
  const resolvedPath = path.resolve(skillPath);
  const result = validateSkillFile(resolvedPath);
  printValidationResult(result, jsonMode);

  if (result.errors.length > 0) {
    process.exit(1);
  } else if (result.warnings.length > 0) {
    process.exit(2);
  }
  // exit code 0 implicitly
}

async function pluginInstall(args: string[]): Promise<void> {
  const noCrossClient = args.includes('--no-cross-client');
  const localIdx = args.indexOf('--local');

  let input: string | undefined;
  if (localIdx !== -1) {
    // --local <path> → resolve and pass as absolute path
    const localPath = args[localIdx + 1];
    if (!localPath) {
      console.error(colorize.error('Usage: claude-cmd plugin install --local <path>'));
      process.exit(1);
    }
    input = path.resolve(localPath);
  } else {
    input = args.find((a) => !a.startsWith('--'));
  }

  if (!input) {
    console.error(colorize.error('Usage: claude-cmd plugin install <@anthropic/name|./path|--local <path>|name>'));
    process.exit(1);
  }
  const manager = new PluginManager();
  await manager.installPluginByInput(input, { crossClientWrite: !noCrossClient });
}

async function pluginRemove(args: string[]): Promise<void> {
  const name = args.find((a) => !a.startsWith('--'));
  if (!name) {
    console.error(colorize.error('Usage: claude-cmd plugin remove <name>'));
    process.exit(1);
  }

  const manager = new PluginManager();
  const plugins = manager.listInstalledPlugins();
  const plugin = plugins.find((p) => p.name === name);

  if (!plugin) {
    console.error(colorize.error(`Plugin '${name}' is not installed.`));
    process.exit(1);
  }

  const { confirm } = await import('@inquirer/prompts');
  const pluginPath = path.join(os.homedir(), '.claude', 'skills', plugin.name);

  console.log(colorize.highlight(`\n┌─ Plugin Remove ──────────────────────────────────`));
  console.log(`│  Name:    ${colorize.bold(plugin.name)}`);
  console.log(`│  Version: ${plugin.version}`);
  console.log(`│  Path:    ${pluginPath}`);
  console.log(`│  Skills:  ${plugin.skills.length > 0 ? plugin.skills.join(', ') : '(none)'}`);
  console.log(colorize.highlight(`└──────────────────────────────────────────────────`));
  console.log('');

  const proceed = await confirm({ message: `Remove plugin '${plugin.name}'?`, default: false });
  if (!proceed) {
    console.log(colorize.warning('Remove cancelled.'));
    return;
  }

  await manager.uninstallPlugin(name);
}

async function pluginList(args: string[]): Promise<void> {
  const jsonMode = args.includes('--json');
  const checkUpdates = args.includes('--check-updates');
  const manager = new PluginManager();

  const plugins = await manager.listPluginsWithStatus(checkUpdates);

  if (jsonMode) {
    console.log(JSON.stringify(plugins, null, 2));
    return;
  }

  if (plugins.length === 0) {
    console.log(colorize.warning('No plugins installed.'));
    return;
  }

  console.log(colorize.highlight(`\nInstalled Plugins (${plugins.length}):\n`));
  for (const p of plugins) {
    const status = p.enabled ? colorize.success('enabled') : colorize.dim('disabled');
    const updateBadge = p.availableUpdate ? colorize.warning(` [update: v${p.availableUpdate}]`) : '';
    console.log(`  ${colorize.bold(p.name)}  v${p.version}  [${p.scope}]  ${status}${updateBadge}`);
    console.log(`    source: ${p.source.type}:${p.source.ref}`);
    if (p.skills.length > 0) {
      console.log(`    skills: ${p.skills.join(', ')} (${p.skills.length})`);
    }
    if (p.agents.length > 0) {
      console.log(`    agents: ${p.agents.join(', ')}`);
    }
  }
}

async function pluginUpdate(args: string[]): Promise<void> {
  const dryRun = args.includes('--dry-run');
  const name = args.find((a) => !a.startsWith('--'));
  const manager = new PluginManager();

  if (name) {
    await manager.updatePluginWithRollback(name, dryRun);
  } else {
    // Check all for updates
    const plugins = manager.listInstalledPlugins();
    if (plugins.length === 0) {
      console.log(colorize.warning('No plugins installed.'));
      return;
    }

    console.log(colorize.info('Checking all installed plugins for updates...'));
    const updates = await manager.checkAllForUpdates();

    if (updates.length === 0) {
      console.log(colorize.success('All plugins are up to date.'));
      return;
    }

    console.log(colorize.highlight(`\nUpdates available for ${updates.length} plugin(s):\n`));
    for (const { plugin, newVersion } of updates) {
      console.log(`  ${colorize.bold(plugin.name)}: v${plugin.version} → v${newVersion}`);
    }
    console.log('');

    if (dryRun) {
      console.log(colorize.warning('[dry-run] No changes made.'));
      return;
    }

    for (const { plugin } of updates) {
      await manager.updatePluginWithRollback(plugin.name, false);
    }
  }
}

async function pluginInit(args: string[]): Promise<void> {
  const manager = new PluginInitManager();

  // Parse flags
  const nameIdx = args.indexOf('--name');
  const descIdx = args.indexOf('--description');
  const authorIdx = args.indexOf('--author');
  const skillIdx = args.indexOf('--skill');
  const nonInteractive = nameIdx !== -1;

  const opts = {
    name: nameIdx !== -1 ? args[nameIdx + 1] : undefined,
    description: descIdx !== -1 ? args[descIdx + 1] : undefined,
    author: authorIdx !== -1 ? args[authorIdx + 1] : undefined,
    skills: skillIdx !== -1 ? [args[skillIdx + 1]] : undefined,
    nonInteractive,
  };

  await manager.initPlugin(opts);
}

// Parse command line arguments
const args = process.argv.slice(2);

async function main(): Promise<void> {
  try {
    // Check for --local flag
    const useLocal = args.includes('--local');
    const filteredArgs = args.filter(arg => arg !== '--local');
    
    // If --local flag is present, temporarily override the commandsUrl
    if (useLocal) {
      const fs = new FileSystemManager();
      const localPath = path.join(process.cwd(), LOCAL_COMMANDS_PATH);
      
      // Check if local file exists
      if (!fs.fileExists(localPath)) {
        console.error(colorize.error(`Local commands file not found at: ${localPath}`));
        console.log(colorize.info('Run "npm run parse-commands" to generate it from markdown files.'));
        process.exit(1);
      }
      
      // Temporarily update config for this session
      process.env.CLAUDE_CMD_URL = localPath;
    }
    
    if (filteredArgs.includes('--help') || filteredArgs.includes('-h')) {
      showHelp();
      process.exit(0);
    } else if (filteredArgs.length > 0) {
      // Handle command-line interface
      if (filteredArgs[0] === 'install' && filteredArgs[1]) {
        await installCommand(filteredArgs[1]);
      } else if (filteredArgs[0] === 'list') {
        await listCommands();
      } else if (filteredArgs[0] === 'search' && filteredArgs[1]) {
        await searchCommands(filteredArgs.slice(1).join(' '));
      } else if (filteredArgs[0] === 'validate' && filteredArgs[1]) {
        const jsonMode = filteredArgs.includes('--json');
        await validateSkill(filteredArgs[1], jsonMode);
      } else if (filteredArgs[0] === 'plugin' && filteredArgs[1] === 'install') {
        await pluginInstall(filteredArgs.slice(2));
      } else if (filteredArgs[0] === 'plugin' && filteredArgs[1] === 'remove' && filteredArgs[2]) {
        await pluginRemove(filteredArgs.slice(2));
      } else if (filteredArgs[0] === 'plugin' && filteredArgs[1] === 'list') {
        await pluginList(filteredArgs.slice(2));
      } else if (filteredArgs[0] === 'plugin' && filteredArgs[1] === 'update') {
        await pluginUpdate(filteredArgs.slice(2));
      } else if (filteredArgs[0] === 'plugin' && filteredArgs[1] === 'init') {
        await pluginInit(filteredArgs.slice(2));
      } else {
        console.error(colorize.error(`Unknown command: ${filteredArgs[0]}`));
        console.log('Run "claude-cmd --help" for usage information or run without arguments for interactive mode.');
        process.exit(1);
      }
    } else {
      // Interactive mode - default behavior
      const cli = new ClaudeCommandCLI();
      console.clear();
      cli.showWelcome();
      await cli.mainMenu();
    }
  } catch (error) {
    console.error(colorize.error(`An error occurred: ${(error as Error).message}`));
    process.exit(1);
  }
}

// Export for programmatic use
export {
  ClaudeCommandCLI
};

// Run if called directly
if (require.main === module) {
  main();
} 