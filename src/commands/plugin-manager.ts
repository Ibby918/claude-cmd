import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { select } from '@inquirer/prompts';
import { colorize } from '../utils/colors';

export type Scope = 'user' | 'project' | 'local';

export interface PluginSource {
  type: 'registry' | 'github' | 'local';
  ref: string;
}

export interface InstalledPlugin {
  name: string;
  version: string;
  scope: Scope;
  source: PluginSource;
  skills: string[];
  agents: string[];
}

interface PluginJson {
  name: string;
  version: string;
  description?: string;
  author?: string;
  skills?: string[];
  agents?: string[];
}

interface InstalledManifest {
  plugins: InstalledPlugin[];
}

export class PluginManager {
  private readonly pluginsDir: string;
  private readonly cacheDir: string;
  private readonly manifestPath: string;
  private readonly settingsPath: string;

  constructor() {
    this.pluginsDir = path.join(os.homedir(), '.claude', 'plugins');
    this.cacheDir = path.join(this.pluginsDir, 'cache');
    this.manifestPath = path.join(this.pluginsDir, 'installed.json');
    this.settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  }

  private ensurePluginsDirectory(): void {
    fs.mkdirSync(this.cacheDir, { recursive: true });
  }

  private readManifest(): InstalledManifest {
    if (!fs.existsSync(this.manifestPath)) {
      return { plugins: [] };
    }
    try {
      return JSON.parse(fs.readFileSync(this.manifestPath, 'utf-8')) as InstalledManifest;
    } catch {
      return { plugins: [] };
    }
  }

  private writeManifest(manifest: InstalledManifest): void {
    this.ensurePluginsDirectory();
    fs.writeFileSync(this.manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  }

  private getEnabledPluginsMap(settings: Record<string, unknown>): Record<string, boolean> {
    const val = settings['enabledPlugins'];
    if (!val || typeof val !== 'object' || Array.isArray(val)) {
      return {};
    }
    return val as Record<string, boolean>;
  }

  private readSettings(): Record<string, unknown> {
    if (!fs.existsSync(this.settingsPath)) {
      return {};
    }
    try {
      return JSON.parse(fs.readFileSync(this.settingsPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private writeSettings(settings: Record<string, unknown>): void {
    fs.mkdirSync(path.dirname(this.settingsPath), { recursive: true });
    fs.writeFileSync(this.settingsPath, JSON.stringify(settings, null, 2) + '\n');
  }

  private readPluginJson(pluginDir: string): PluginJson {
    // Support both .claude-plugin/plugin.json and plugin.json at root
    const candidates = [
      path.join(pluginDir, '.claude-plugin', 'plugin.json'),
      path.join(pluginDir, 'plugin.json'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return JSON.parse(fs.readFileSync(candidate, 'utf-8')) as PluginJson;
      }
    }
    throw new Error(`No plugin.json found in ${pluginDir}`);
  }

  private copyDir(src: string, dest: string): void {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        this.copyDir(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  async installPlugin(source: PluginSource, scope: Scope = 'user'): Promise<void> {
    if (source.type !== 'local') {
      throw new Error(`Source type '${source.type}' is not yet supported. Only 'local' installs are available.`);
    }

    const localPath = path.resolve(source.ref);
    if (!fs.existsSync(localPath)) {
      throw new Error(`Local plugin path not found: ${localPath}`);
    }

    const pluginJson = this.readPluginJson(localPath);
    const { name, version = '0.0.0', skills = [], agents = [] } = pluginJson;

    if (!name) {
      throw new Error('plugin.json is missing required field: name');
    }

    this.ensurePluginsDirectory();
    const destDir = path.join(this.cacheDir, name);

    // Remove existing cached version if present
    if (fs.existsSync(destDir)) {
      fs.rmSync(destDir, { recursive: true });
    }

    this.copyDir(localPath, destDir);

    const manifest = this.readManifest();
    const existing = manifest.plugins.findIndex(p => p.name === name);
    const entry: InstalledPlugin = { name, version, scope, source, skills, agents };

    if (existing !== -1) {
      manifest.plugins[existing] = entry;
    } else {
      manifest.plugins.push(entry);
    }

    this.writeManifest(manifest);
    console.log(colorize.success(`Plugin '${name}' v${version} installed successfully.`));

    if (skills.length > 0) {
      console.log(colorize.info(`  Skills: ${skills.join(', ')}`));
    }
    if (agents.length > 0) {
      console.log(colorize.info(`  Agents: ${agents.join(', ')}`));
    }
  }

  async uninstallPlugin(name: string): Promise<void> {
    const manifest = this.readManifest();
    const idx = manifest.plugins.findIndex(p => p.name === name);

    if (idx === -1) {
      throw new Error(`Plugin '${name}' is not installed.`);
    }

    manifest.plugins.splice(idx, 1);
    this.writeManifest(manifest);

    const destDir = path.join(this.cacheDir, name);
    if (fs.existsSync(destDir)) {
      fs.rmSync(destDir, { recursive: true });
    }

    // Also remove from enabledPlugins if present
    const settings = this.readSettings();
    const enabled = this.getEnabledPluginsMap(settings);
    if (name in enabled) {
      delete enabled[name];
      settings['enabledPlugins'] = enabled;
      this.writeSettings(settings);
    }

    console.log(colorize.success(`Plugin '${name}' uninstalled.`));
  }

  async updatePlugin(name: string): Promise<void> {
    const manifest = this.readManifest();
    const plugin = manifest.plugins.find(p => p.name === name);

    if (!plugin) {
      throw new Error(`Plugin '${name}' is not installed.`);
    }

    console.log(colorize.info(`Updating plugin '${name}'...`));
    await this.installPlugin(plugin.source, plugin.scope);
  }

  listInstalledPlugins(): InstalledPlugin[] {
    return this.readManifest().plugins;
  }

  enablePlugin(name: string, scope: Scope): void {
    const manifest = this.readManifest();
    if (!manifest.plugins.some(p => p.name === name)) {
      throw new Error(`Plugin '${name}' is not installed.`);
    }

    const settings = this.readSettings();
    const enabled = this.getEnabledPluginsMap(settings);
    enabled[name] = true;
    settings['enabledPlugins'] = enabled;
    this.writeSettings(settings);

    // Update scope in manifest
    const plugin = manifest.plugins.find(p => p.name === name)!;
    plugin.scope = scope;
    this.writeManifest(manifest);

    console.log(colorize.success(`Plugin '${name}' enabled (scope: ${scope}).`));
  }

  disablePlugin(name: string, _scope: Scope): void {
    const settings = this.readSettings();
    const enabled = this.getEnabledPluginsMap(settings);

    if (!(name in enabled)) {
      console.log(colorize.warning(`Plugin '${name}' was not enabled.`));
      return;
    }

    delete enabled[name];
    settings['enabledPlugins'] = enabled;
    this.writeSettings(settings);
    console.log(colorize.success(`Plugin '${name}' disabled.`));
  }

  // ── Interactive TUI methods ───────────────────────────────────────────────

  async handlePluginsMenu(): Promise<void> {
    const { globalNavigator, NavigationUtils } = await import('../utils/navigation');
    globalNavigator.enterMenu('Plugin Manager');

    while (true) {
      globalNavigator.displayBreadcrumb();

      const action = await NavigationUtils.enhancedSelect<string>({
        message: 'Plugin Management',
        choices: [
          { name: '📋 List installed plugins', value: 'list' },
          { name: '📦 Install plugin from local path', value: 'install_local' },
          { name: '🗑️  Uninstall plugin', value: 'uninstall' },
          { name: '🔄 Update plugin', value: 'update' },
          { name: '✅ Enable plugin', value: 'enable' },
          { name: '⛔ Disable plugin', value: 'disable' },
          { name: '← Back to main menu', value: 'back' },
        ],
        allowEscBack: true,
      });

      console.log('');

      try {
        switch (action) {
          case 'list':
            await this.showPluginList();
            await globalNavigator.pauseForUser();
            break;

          case 'install_local':
            await this.interactiveInstallLocal();
            await globalNavigator.pauseForUser();
            break;

          case 'uninstall':
            await this.interactiveUninstall();
            await globalNavigator.pauseForUser();
            break;

          case 'update':
            await this.interactiveUpdate();
            await globalNavigator.pauseForUser();
            break;

          case 'enable':
            await this.interactiveToggle('enable');
            await globalNavigator.pauseForUser();
            break;

          case 'disable':
            await this.interactiveToggle('disable');
            await globalNavigator.pauseForUser();
            break;

          case 'back':
          case 'cancel':
            globalNavigator.exitMenu();
            return;

          default:
            break;
        }
      } catch (error) {
        console.log(colorize.error(`Error: ${(error as Error).message}`));
        await globalNavigator.pauseForUser();
      }
    }
  }

  private async showPluginList(): Promise<void> {
    const plugins = this.listInstalledPlugins();

    if (plugins.length === 0) {
      console.log(colorize.warning('No plugins installed yet.'));
      return;
    }

    const settings = this.readSettings();
    const enabledMap = this.getEnabledPluginsMap(settings);
    const enabled = new Set(Object.keys(enabledMap).filter(k => enabledMap[k]));

    console.log(colorize.highlight(`\nInstalled Plugins (${plugins.length}):\n`));
    for (const p of plugins) {
      const status = enabled.has(p.name) ? colorize.success('enabled') : colorize.dim('disabled');
      console.log(`  ${colorize.bold(p.name)}  v${p.version}  [${p.scope}]  ${status}`);
      console.log(`    source: ${p.source.type}:${p.source.ref}`);
      if (p.skills.length > 0) {
        console.log(`    skills: ${p.skills.join(', ')}`);
      }
      if (p.agents.length > 0) {
        console.log(`    agents: ${p.agents.join(', ')}`);
      }
    }
  }

  private async interactiveInstallLocal(): Promise<void> {
    const { input } = await import('@inquirer/prompts');
    const localPath = await input({
      message: 'Path to local plugin directory:',
      validate: (v) => {
        if (!v.trim()) return 'Path is required';
        if (!fs.existsSync(path.resolve(v))) return `Path not found: ${v}`;
        return true;
      },
    });

    const scopeAnswer = await select<Scope>({
      message: 'Scope:',
      choices: [
        { name: 'user  (~/.claude)', value: 'user' },
        { name: 'project (./.claude)', value: 'project' },
        { name: 'local (current dir)', value: 'local' },
      ],
    });

    await this.installPlugin({ type: 'local', ref: localPath.trim() }, scopeAnswer);
  }

  private async interactiveUninstall(): Promise<void> {
    const plugins = this.listInstalledPlugins();
    if (plugins.length === 0) {
      console.log(colorize.warning('No plugins installed.'));
      return;
    }

    const choices = plugins.map(p => ({ name: `${p.name} v${p.version}`, value: p.name }));
    choices.push({ name: '← Cancel', value: 'cancel' });

    const selected = await select<string>({ message: 'Select plugin to uninstall:', choices });
    if (selected === 'cancel') return;
    await this.uninstallPlugin(selected);
  }

  private async interactiveUpdate(): Promise<void> {
    const plugins = this.listInstalledPlugins();
    if (plugins.length === 0) {
      console.log(colorize.warning('No plugins installed.'));
      return;
    }

    const choices = plugins.map(p => ({ name: `${p.name} v${p.version}`, value: p.name }));
    choices.push({ name: '← Cancel', value: 'cancel' });

    const selected = await select<string>({ message: 'Select plugin to update:', choices });
    if (selected === 'cancel') return;
    await this.updatePlugin(selected);
  }

  private async interactiveToggle(action: 'enable' | 'disable'): Promise<void> {
    const plugins = this.listInstalledPlugins();
    if (plugins.length === 0) {
      console.log(colorize.warning('No plugins installed.'));
      return;
    }

    const choices = plugins.map(p => ({ name: `${p.name} v${p.version}`, value: p.name }));
    choices.push({ name: '← Cancel', value: 'cancel' });

    const selected = await select<string>({ message: `Select plugin to ${action}:`, choices });
    if (selected === 'cancel') return;

    if (action === 'enable') {
      const scopeAnswer = await select<Scope>({
        message: 'Scope:',
        choices: [
          { name: 'user  (~/.claude)', value: 'user' },
          { name: 'project (./.claude)', value: 'project' },
          { name: 'local (current dir)', value: 'local' },
        ],
      });
      this.enablePlugin(selected, scopeAnswer);
    } else {
      this.disablePlugin(selected, 'user');
    }
  }
}
