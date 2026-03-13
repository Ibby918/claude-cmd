#!/usr/bin/env node

import { ClaudeCommandCLI } from './cli';
import { CommandManager } from './commands/command-manager';
import { FileSystemManager } from './core/filesystem';
import { ClaudeCommandAPI } from './core/api';
import { colorize } from './utils/colors';
import { validateSkillFile, printValidationResult } from './commands/skill-validator';
import { PluginInitManager } from './commands/plugin-init-manager';
import { PluginManager } from './commands/plugin-manager';
import { login, whoami, logout } from './commands/auth-manager';
import { publish } from './commands/publish-manager';
import { SubAgentFrontMatter, AVAILABLE_TOOLS, DEFAULT_SUB_AGENT_TOOLS } from './types';
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

const CLAUDE_MODELS = [
  'claude-opus-4-5',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
  'claude-opus-4-5-20251101',
  'claude-sonnet-4-5-20251101',
  'claude-haiku-4-5-20251001',
];

async function agentInit(args: string[]): Promise<void> {
  const fs = new FileSystemManager();

  // Parse flags for non-interactive mode
  const nameIdx = args.indexOf('--name');
  const descIdx = args.indexOf('--description');
  const modelIdx = args.indexOf('--model');
  const toolsIdx = args.indexOf('--tools');
  const localFlag = args.includes('--local');
  const nonInteractive = nameIdx !== -1;

  let name: string;
  let description: string;
  let model: string | undefined;
  let tools: string[];
  let targetLocation: 'global' | 'local';

  if (nonInteractive) {
    // Non-interactive mode
    name = args[nameIdx + 1];
    if (!name) {
      console.error(colorize.error('Usage: claude-cmd agent init --name <name> [--description <desc>] [--model <model>] [--tools <tool1,tool2>] [--global|--local]'));
      process.exit(1);
    }
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(name)) {
      console.error(colorize.error('Agent name must use only lowercase letters, numbers, and hyphens (no leading/trailing hyphens).'));
      process.exit(1);
    }
    description = descIdx !== -1 ? args[descIdx + 1] : `${name} agent`;
    model = modelIdx !== -1 ? args[modelIdx + 1] : undefined;
    const toolsRaw = toolsIdx !== -1 ? args[toolsIdx + 1] : undefined;
    tools = toolsRaw ? toolsRaw.split(',').map(t => t.trim()).filter(t => AVAILABLE_TOOLS.includes(t)) : DEFAULT_SUB_AGENT_TOOLS;
    targetLocation = localFlag ? 'local' : 'global';
  } else {
    // Interactive mode
    const { input, select, confirm } = await import('@inquirer/prompts');

    console.log(`\n${colorize.highlight('🤖 Agent Template Scaffold')}`);
    console.log(colorize.info('Creates a new Claude Code agent in ~/.claude/agents/<name>.md\n'));

    name = await input({
      message: 'Agent name (lowercase, hyphens allowed):',
      validate: (v) => {
        if (!v.trim()) return 'Name is required';
        if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(v.trim())) {
          return 'Use only lowercase letters, numbers, and hyphens (no leading/trailing hyphens)';
        }
        return true;
      }
    });

    description = await input({
      message: 'Description (role/purpose of this agent):',
      validate: (v) => v.trim() !== '' || 'Description is required'
    });

    const modelChoice = await select<string>({
      message: 'Model (leave default to use Claude\'s default):',
      choices: [
        { name: '(default — inherit from context)', value: '' },
        ...CLAUDE_MODELS.map(m => ({ name: m, value: m })),
        { name: 'Other (type manually)', value: '__custom__' },
      ]
    });

    if (modelChoice === '__custom__') {
      model = await input({ message: 'Model ID:' });
    } else {
      model = modelChoice || undefined;
    }

    // Tool selection via checkboxes
    console.log(`\n${colorize.info('Select tools for this agent:')}`);
    const selectedTools: string[] = [];
    for (const tool of AVAILABLE_TOOLS) {
      const isDefault = DEFAULT_SUB_AGENT_TOOLS.includes(tool);
      const include = await confirm({ message: `Include ${tool}?`, default: isDefault });
      if (include) selectedTools.push(tool);
    }
    tools = selectedTools.length > 0 ? selectedTools : DEFAULT_SUB_AGENT_TOOLS;

    const locationChoice = await select<'global' | 'local'>({
      message: 'Installation location:',
      choices: [
        { name: '🌍 Global (~/.claude/agents)', value: 'global' },
        { name: '📂 Project local (./.claude/agents)', value: 'local' },
      ]
    });
    targetLocation = locationChoice;
  }

  // Build system prompt template
  const systemPrompt = `You are ${name}, a specialized AI assistant.

## Role
${description}

## Capabilities
- [List key capabilities here]
- [Add specific skills or knowledge areas]
- [Define what tasks this agent handles best]

## Guidelines
- Be concise and focused on your specific role
- Use available tools when appropriate
- Ask for clarification when requirements are ambiguous`;

  // Validate before saving
  const issues: string[] = [];
  if (!name.trim()) issues.push('Name is required');
  if (!description.trim()) issues.push('Description is required');
  if (tools.length === 0) issues.push('At least one tool must be selected');
  const invalidTools = tools.filter(t => !AVAILABLE_TOOLS.includes(t));
  if (invalidTools.length > 0) issues.push(`Unknown tools: ${invalidTools.join(', ')}`);

  if (issues.length > 0) {
    console.error(colorize.error('Validation failed:'));
    issues.forEach(i => console.error(colorize.error(`  • ${i}`)));
    process.exit(1);
  }

  const frontMatter: SubAgentFrontMatter = { name, description, tools, model };

  try {
    if (targetLocation === 'global') {
      fs.ensureAgentsDirectory();
    } else {
      fs.ensureProjectAgentsDirectory();
    }
    const filePath = fs.saveSubAgent(name, frontMatter, systemPrompt, targetLocation);
    const locationText = targetLocation === 'global' ? 'globally' : 'in project';
    console.log(colorize.success(`\n✅ Agent '${name}' created ${locationText}`));
    console.log(colorize.info(`📁 ${filePath}`));
    console.log(colorize.info(`🛠️  Tools: ${tools.join(', ')}`));
    if (model) console.log(colorize.info(`🧠 Model: ${model}`));
    console.log(colorize.dim('\nEdit the system prompt in the file above to customize agent behavior.'));
  } catch (error) {
    console.error(colorize.error(`Failed to create agent: ${(error as Error).message}`));
    process.exit(1);
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
  agent init                    Scaffold a new Claude Code agent template interactively
  agent init --name <n>         Scaffold non-interactively (also: --description, --model, --tools, --global/--local)
  login                         Authenticate with GitHub via device flow
  login --token <pat>           Authenticate with a GitHub Personal Access Token
  whoami                        Show currently authenticated GitHub user
  logout                        Remove stored authentication credentials
  publish [--dir <path>]        Publish plugin skills to the community registry
  publish --dry-run             Validate without uploading

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
  claude-cmd agent init                             Scaffold a new agent template interactively
  claude-cmd agent init --name my-agent --description "My agent" --model claude-opus-4-5
  claude-cmd agent init --name my-agent --tools Read,Edit,Bash --global
  claude-cmd login                                      Authenticate with GitHub (opens browser)
  claude-cmd login --token ghp_xxx                      Authenticate with a PAT
  claude-cmd whoami                                     Show authenticated user
  claude-cmd logout                                     Remove stored credentials
  claude-cmd publish                                    Publish plugin in current directory
  claude-cmd publish --dir ./my-plugin                  Publish plugin at given path
  claude-cmd publish --dry-run                          Validate without uploading
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
      } else if (filteredArgs[0] === 'agent' && filteredArgs[1] === 'init') {
        await agentInit(filteredArgs.slice(2));
      } else if (filteredArgs[0] === 'login') {
        const tokenIdx = filteredArgs.indexOf('--token');
        const token = tokenIdx !== -1 ? filteredArgs[tokenIdx + 1] : undefined;
        await login(token);
      } else if (filteredArgs[0] === 'whoami') {
        whoami();
      } else if (filteredArgs[0] === 'logout') {
        logout();
      } else if (filteredArgs[0] === 'publish') {
        const dirIdx = filteredArgs.indexOf('--dir');
        const dir = dirIdx !== -1 ? filteredArgs[dirIdx + 1] : undefined;
        const dryRun = filteredArgs.includes('--dry-run');
        await publish({ dir, dryRun });
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