import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { select, confirm } from '@inquirer/prompts';
import { colorize } from '../utils/colors';
import { ClaudeCommandAPI } from '../core/api';
import { validateSkillContent } from './skill-validator';

export type Scope = 'user' | 'project' | 'local';

export interface PluginSource {
  type: 'registry' | 'github' | 'local' | 'anthropic';
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

// ── SourceAdapter types ──────────────────────────────────────────────────────

export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  author?: string;
  skills: string[];
  agents: string[];
  files: PluginFile[];
}

export interface PluginFile {
  path: string; // relative path within the skill/plugin
  content: string;
}

export interface InstallOptions {
  crossClientWrite?: boolean; // default: true
}

export interface SourceAdapter {
  name: string;
  canResolve(input: string): boolean;
  resolve(input: string): Promise<PluginManifest>;
  fetch(manifest: PluginManifest, destDir: string): Promise<void>;
}

// ── AnthropicMarketplaceAdapter ──────────────────────────────────────────────

interface MarketplaceEntry {
  name: string;
  description?: string;
  path: string; // directory path within the repo
  version?: string;
}

interface MarketplaceJson {
  skills?: MarketplaceEntry[];
  plugins?: MarketplaceEntry[];
}

interface GitHubTreeItem {
  path: string;
  type: string;
  url: string;
  sha: string;
}

interface GitHubTreeResponse {
  tree: GitHubTreeItem[];
}

export class AnthropicMarketplaceAdapter implements SourceAdapter {
  name = 'AnthropicMarketplaceAdapter';

  private readonly marketplaceUrl =
    'https://raw.githubusercontent.com/anthropics/skills/main/.claude-plugin/marketplace.json';
  private readonly rawBase = 'https://raw.githubusercontent.com/anthropics/skills/main';
  private readonly treesApiUrl =
    'https://api.github.com/repos/anthropics/skills/git/trees/main?recursive=1';
  private readonly cacheDir = path.join(os.homedir(), '.claude', '.cache');
  private readonly cacheFile = path.join(
    os.homedir(),
    '.claude',
    '.cache',
    'anthropic-marketplace-v1.json',
  );
  private readonly cacheETagFile = path.join(
    os.homedir(),
    '.claude',
    '.cache',
    'anthropic-marketplace-v1.etag',
  );
  private readonly CACHE_TTL = 10 * 60 * 1000; // 10 minutes

  canResolve(input: string): boolean {
    return input.startsWith('@anthropic/');
  }

  private ensureCacheDir(): void {
    fs.mkdirSync(this.cacheDir, { recursive: true });
  }

  private readCached(): { data: MarketplaceJson; etag: string | null; ts: number } | null {
    try {
      if (!fs.existsSync(this.cacheFile)) return null;
      const stat = fs.statSync(this.cacheFile);
      const ts = stat.mtimeMs;
      if (Date.now() - ts > this.CACHE_TTL) return null;
      const data = JSON.parse(fs.readFileSync(this.cacheFile, 'utf-8')) as MarketplaceJson;
      const etag = fs.existsSync(this.cacheETagFile)
        ? fs.readFileSync(this.cacheETagFile, 'utf-8').trim()
        : null;
      return { data, etag, ts };
    } catch {
      return null;
    }
  }

  private writeCached(data: MarketplaceJson, etag: string | null): void {
    this.ensureCacheDir();
    fs.writeFileSync(this.cacheFile, JSON.stringify(data, null, 2));
    if (etag) fs.writeFileSync(this.cacheETagFile, etag);
  }

  private async fetchMarketplace(): Promise<MarketplaceJson> {
    const cached = this.readCached();
    const headers: Record<string, string> = { 'User-Agent': 'claude-cmd' };
    if (cached?.etag) {
      headers['If-None-Match'] = cached.etag;
    }

    const response = await fetch(this.marketplaceUrl, { headers });

    if (response.status === 304 && cached) {
      return cached.data;
    }

    if (!response.ok) {
      if (cached) {
        // Stale cache as fallback
        return cached.data;
      }
      throw new Error(`Failed to fetch Anthropic marketplace (${response.status}): ${response.statusText}`);
    }

    const etag = response.headers.get('etag');
    const data = (await response.json()) as MarketplaceJson;
    this.writeCached(data, etag);
    return data;
  }

  async resolve(input: string): Promise<PluginManifest> {
    const skillName = input.replace(/^@anthropic\//, '');
    const marketplace = await this.fetchMarketplace();
    const entries: MarketplaceEntry[] = [
      ...(marketplace.skills ?? []),
      ...(marketplace.plugins ?? []),
    ];

    // Find matching entry by name or path basename
    const entry = entries.find(
      (e) => e.name === skillName || path.basename(e.path) === skillName,
    );

    if (!entry) {
      throw new Error(
        `Skill '@anthropic/${skillName}' not found in Anthropic marketplace. Available: ${entries.map((e) => e.name || path.basename(e.path)).join(', ')}`,
      );
    }

    // Enumerate files in the skill directory via GitHub Trees API
    const treeResp = await fetch(this.treesApiUrl, {
      headers: { 'User-Agent': 'claude-cmd' },
    });
    if (!treeResp.ok) {
      throw new Error(`Failed to fetch GitHub tree (${treeResp.status})`);
    }
    const tree = ((await treeResp.json()) as GitHubTreeResponse).tree;

    const skillPath = entry.path;
    const skillFiles = tree.filter(
      (item) => item.type === 'blob' && item.path.startsWith(skillPath + '/'),
    );

    // Download each file
    const files: PluginFile[] = await Promise.all(
      skillFiles.map(async (item) => {
        const rawUrl = `${this.rawBase}/${item.path}`;
        const resp = await fetch(rawUrl, { headers: { 'User-Agent': 'claude-cmd' } });
        if (!resp.ok) {
          throw new Error(`Failed to fetch file ${item.path} (${resp.status})`);
        }
        const content = await resp.text();
        const relativePath = item.path.slice(skillPath.length + 1);
        return { path: relativePath, content };
      }),
    );

    return {
      name: entry.name || skillName,
      version: entry.version || '0.0.0',
      description: entry.description,
      skills: [entry.name || skillName],
      agents: [],
      files,
    };
  }

  async fetch(manifest: PluginManifest, destDir: string): Promise<void> {
    fs.mkdirSync(destDir, { recursive: true });
    for (const file of manifest.files) {
      const filePath = path.join(destDir, file.path);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, file.content, 'utf-8');
    }
  }
}

// ── LocalPathAdapter ─────────────────────────────────────────────────────────

export class LocalPathAdapter implements SourceAdapter {
  name = 'LocalPathAdapter';

  canResolve(input: string): boolean {
    return input.startsWith('./') || input.startsWith('/') || input.startsWith('../');
  }

  async resolve(input: string): Promise<PluginManifest> {
    const localPath = path.resolve(input);
    if (!fs.existsSync(localPath)) {
      throw new Error(`Local plugin path not found: ${localPath}`);
    }

    // Try to read plugin.json
    const pluginJsonCandidates = [
      path.join(localPath, '.claude-plugin', 'plugin.json'),
      path.join(localPath, 'plugin.json'),
    ];

    let pluginJson: PluginJson | null = null;
    for (const candidate of pluginJsonCandidates) {
      if (fs.existsSync(candidate)) {
        pluginJson = JSON.parse(fs.readFileSync(candidate, 'utf-8')) as PluginJson;
        break;
      }
    }

    // Fall back to SKILL.md frontmatter name
    const skillMdPath = path.join(localPath, 'SKILL.md');
    let skillName = path.basename(localPath);
    if (fs.existsSync(skillMdPath)) {
      const content = fs.readFileSync(skillMdPath, 'utf-8');
      const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
      if (match) {
        const nameLine = match[1].match(/^name:\s*(.+)$/m);
        if (nameLine) skillName = nameLine[1].trim();
      }
    }

    const name = pluginJson?.name || skillName;
    const version = pluginJson?.version || '0.0.0';

    // Collect files: SKILL.md + scripts/ + references/ + assets/
    const files: PluginFile[] = this.collectFiles(localPath);

    return {
      name,
      version,
      description: pluginJson?.description,
      skills: pluginJson?.skills || [name],
      agents: pluginJson?.agents || [],
      files,
    };
  }

  private collectFiles(baseDir: string): PluginFile[] {
    const files: PluginFile[] = [];
    const collect = (dir: string, relBase: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          collect(fullPath, rel);
        } else {
          files.push({ path: rel, content: fs.readFileSync(fullPath, 'utf-8') });
        }
      }
    };
    collect(baseDir, '');
    return files;
  }

  async fetch(manifest: PluginManifest, destDir: string): Promise<void> {
    fs.mkdirSync(destDir, { recursive: true });
    for (const file of manifest.files) {
      const filePath = path.join(destDir, file.path);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, file.content, 'utf-8');
    }
  }
}

// ── ClaudeCmdRegistryAdapter ─────────────────────────────────────────────────

export class ClaudeCmdRegistryAdapter implements SourceAdapter {
  name = 'ClaudeCmdRegistryAdapter';

  constructor(private readonly api: ClaudeCommandAPI) {}

  canResolve(input: string): boolean {
    // Bare name — no prefix
    return !input.startsWith('@') && !input.startsWith('./') && !input.startsWith('/') && !input.startsWith('../');
  }

  async resolve(input: string): Promise<PluginManifest> {
    const results = await this.api.searchCommands(input);
    const cmd = results.commands.find((c) => c.name === input || c.id === input);

    if (!cmd) {
      throw new Error(`Skill '${input}' not found in claude-cmd registry.`);
    }

    // Fetch the raw content of the skill
    if (!cmd.content) {
      throw new Error(`Skill '${input}' has no content URL in registry.`);
    }
    const content = await fetch(cmd.content).then((r) => {
      if (!r.ok) throw new Error(`Failed to fetch skill content (${r.status})`);
      return r.text();
    });

    return {
      name: cmd.name,
      version: '0.0.0',
      description: cmd.description,
      skills: [cmd.name],
      agents: [],
      files: [{ path: 'SKILL.md', content }],
    };
  }

  async fetch(manifest: PluginManifest, destDir: string): Promise<void> {
    fs.mkdirSync(destDir, { recursive: true });
    for (const file of manifest.files) {
      const filePath = path.join(destDir, file.path);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, file.content, 'utf-8');
    }
  }
}

// ── PluginManager ─────────────────────────────────────────────────────────────

export class PluginManager {
  private readonly pluginsDir: string;
  private readonly cacheDir: string;
  private readonly manifestPath: string;
  private readonly settingsPath: string;
  private readonly skillsDir: string;
  private readonly agentSkillsDir: string;
  private readonly adapters: SourceAdapter[];

  constructor() {
    this.pluginsDir = path.join(os.homedir(), '.claude', 'plugins');
    this.cacheDir = path.join(this.pluginsDir, 'cache');
    this.manifestPath = path.join(this.pluginsDir, 'installed.json');
    this.settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    this.skillsDir = path.join(os.homedir(), '.claude', 'skills');
    this.agentSkillsDir = path.join(os.homedir(), '.agents', 'skills');

    const api = new ClaudeCommandAPI();
    this.adapters = [
      new AnthropicMarketplaceAdapter(),
      new LocalPathAdapter(),
      new ClaudeCmdRegistryAdapter(api),
    ];
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

  private isCrossClientWriteEnabled(): boolean {
    const settings = this.readSettings();
    const pluginSettings = settings['plugin'];
    if (pluginSettings && typeof pluginSettings === 'object' && !Array.isArray(pluginSettings)) {
      const crossClientWrite = (pluginSettings as Record<string, unknown>)['crossClientWrite'];
      if (crossClientWrite === false) return false;
    }
    return true; // default ON
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

  /**
   * Install a plugin by input string (e.g. "@anthropic/pdf", "./local-path", "bare-name").
   * Resolves adapter automatically, dual-writes to ~/.claude/skills/ and ~/.agents/skills/.
   */
  async installPluginByInput(input: string, options: InstallOptions = {}): Promise<void> {
    const crossClientWrite = options.crossClientWrite ?? this.isCrossClientWriteEnabled();

    const adapter = this.adapters.find((a) => a.canResolve(input));
    if (!adapter) {
      throw new Error(`No adapter found for input: ${input}`);
    }

    console.log(colorize.info(`Resolving '${input}' via ${adapter.name}...`));
    const manifest = await adapter.resolve(input);

    // Idempotent: skip if same name + version already installed
    const existingManifest = this.readManifest();
    const alreadyInstalled = existingManifest.plugins.find(
      (p) => p.name === manifest.name && p.version === manifest.version,
    );
    if (alreadyInstalled) {
      console.log(colorize.info(`Plugin '${manifest.name}' v${manifest.version} is already installed. Nothing to do.`));
      return;
    }

    // Validate SKILL.md files before writing
    const skillFiles = manifest.files.filter((f) => f.path === 'SKILL.md' || f.path.endsWith('/SKILL.md'));
    for (const skillFile of skillFiles) {
      const syntheticPath = path.join(this.skillsDir, manifest.name, skillFile.path);
      const result = validateSkillContent(skillFile.content, syntheticPath);
      if (result.errors.length > 0) {
        result.errors.forEach((e) => {
          const field = e.field ? ` [${e.field}]` : '';
          console.error(colorize.error(`  ERROR${field}: ${e.message}`));
        });
        throw new Error(`Validation failed for '${skillFile.path}' in plugin '${manifest.name}'. Install aborted.`);
      }
      if (result.warnings.length > 0) {
        result.warnings.forEach((w) => {
          const field = w.field ? ` [${w.field}]` : '';
          console.log(colorize.warning(`  WARN${field}: ${w.message}`));
        });
      }
    }

    // Primary install: ~/.claude/skills/<name>/
    const primaryDest = path.join(this.skillsDir, manifest.name);
    if (fs.existsSync(primaryDest)) {
      fs.rmSync(primaryDest, { recursive: true });
    }
    await adapter.fetch(manifest, primaryDest);
    console.log(colorize.success(`✓ Installed to ~/.claude/skills/${manifest.name}/`));

    // Cross-client write: ~/.agents/skills/<name>/
    if (crossClientWrite) {
      const crossDest = path.join(this.agentSkillsDir, manifest.name);
      if (fs.existsSync(crossDest)) {
        fs.rmSync(crossDest, { recursive: true });
      }
      await adapter.fetch(manifest, crossDest);
      console.log(colorize.success(`✓ Cross-client install to ~/.agents/skills/${manifest.name}/`));
    }

    // Update installed.json manifest
    this.ensurePluginsDirectory();
    const sourceType: PluginSource['type'] = input.startsWith('@anthropic/')
      ? 'anthropic'
      : input.startsWith('./') || input.startsWith('/')
        ? 'local'
        : 'registry';

    const installedEntry: InstalledPlugin = {
      name: manifest.name,
      version: manifest.version,
      scope: 'user',
      source: { type: sourceType, ref: input },
      skills: manifest.skills,
      agents: manifest.agents,
    };

    const installedManifest = this.readManifest();
    const existing = installedManifest.plugins.findIndex((p) => p.name === manifest.name);
    if (existing !== -1) {
      installedManifest.plugins[existing] = installedEntry;
    } else {
      installedManifest.plugins.push(installedEntry);
    }
    this.writeManifest(installedManifest);

    console.log(colorize.success(`\nPlugin '${manifest.name}' v${manifest.version} installed successfully.`));
    if (manifest.skills.length > 0) {
      console.log(colorize.info(`  Skills: ${manifest.skills.join(', ')}`));
    }
  }

  async installPlugin(source: PluginSource, scope: Scope = 'user'): Promise<void> {
    if (source.type === 'local') {
      // Legacy local path install
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

      if (fs.existsSync(destDir)) {
        fs.rmSync(destDir, { recursive: true });
      }

      this.copyDir(localPath, destDir);

      const manifest = this.readManifest();
      const existing = manifest.plugins.findIndex((p) => p.name === name);
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
      return;
    }

    throw new Error(`Source type '${source.type}' is not yet supported via legacy installPlugin. Use installPluginByInput instead.`);
  }

  async uninstallPlugin(name: string): Promise<void> {
    const manifest = this.readManifest();
    const idx = manifest.plugins.findIndex((p) => p.name === name);

    if (idx === -1) {
      throw new Error(`Plugin '${name}' is not installed.`);
    }

    manifest.plugins.splice(idx, 1);
    this.writeManifest(manifest);

    const destDir = path.join(this.cacheDir, name);
    if (fs.existsSync(destDir)) {
      fs.rmSync(destDir, { recursive: true });
    }

    // Remove from skills dirs
    const skillsDest = path.join(this.skillsDir, name);
    if (fs.existsSync(skillsDest)) {
      fs.rmSync(skillsDest, { recursive: true });
    }
    const agentSkillsDest = path.join(this.agentSkillsDir, name);
    if (fs.existsSync(agentSkillsDest)) {
      fs.rmSync(agentSkillsDest, { recursive: true });
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
    const plugin = manifest.plugins.find((p) => p.name === name);

    if (!plugin) {
      throw new Error(`Plugin '${name}' is not installed.`);
    }

    console.log(colorize.info(`Updating plugin '${name}'...`));

    // Use new adapter path for anthropic/registry sources
    if (plugin.source.type === 'anthropic' || plugin.source.type === 'registry') {
      await this.installPluginByInput(plugin.source.ref);
    } else {
      await this.installPlugin(plugin.source, plugin.scope);
    }
  }

  listInstalledPlugins(): InstalledPlugin[] {
    return this.readManifest().plugins;
  }

  enablePlugin(name: string, scope: Scope): void {
    const manifest = this.readManifest();
    if (!manifest.plugins.some((p) => p.name === name)) {
      throw new Error(`Plugin '${name}' is not installed.`);
    }

    const settings = this.readSettings();
    const enabled = this.getEnabledPluginsMap(settings);
    enabled[name] = true;
    settings['enabledPlugins'] = enabled;
    this.writeSettings(settings);

    // Update scope in manifest
    const plugin = manifest.plugins.find((p) => p.name === name)!;
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
          { name: '📦 Install plugin', value: 'install' },
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

          case 'install':
            await this.interactiveInstall();
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
    const enabled = new Set(Object.keys(enabledMap).filter((k) => enabledMap[k]));

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

  private async interactiveInstall(): Promise<void> {
    const { input } = await import('@inquirer/prompts');
    const pluginInput = await input({
      message: 'Plugin to install (e.g. @anthropic/pdf, ./local-path, or bare-name):',
      validate: (v) => {
        if (!v.trim()) return 'Input is required';
        return true;
      },
    });

    const trimmedInput = pluginInput.trim();
    const adapter = this.adapters.find((a) => a.canResolve(trimmedInput));
    if (!adapter) {
      throw new Error(`No adapter found for input: ${trimmedInput}`);
    }

    console.log(colorize.info(`\nFetching plugin info for '${trimmedInput}'...`));
    const manifest = await adapter.resolve(trimmedInput);

    // Show info card
    console.log(colorize.highlight(`\n┌─ Plugin Info ────────────────────────────────────`));
    console.log(`│  Name:        ${colorize.bold(manifest.name)}`);
    console.log(`│  Version:     ${manifest.version}`);
    if (manifest.description) {
      console.log(`│  Description: ${manifest.description}`);
    }
    if (manifest.author) {
      console.log(`│  Author:      ${manifest.author}`);
    }
    console.log(`│  Skills:      ${manifest.skills.length > 0 ? manifest.skills.join(', ') : '(none)'}`);
    if (manifest.agents.length > 0) {
      console.log(`│  Agents:      ${manifest.agents.join(', ')}`);
    }
    console.log(`│  Files:       ${manifest.files.length}`);

    // Show allowed-tools from SKILL.md frontmatter if present
    const skillFile = manifest.files.find((f) => f.path === 'SKILL.md' || f.path.endsWith('/SKILL.md'));
    if (skillFile) {
      const toolsMatch = skillFile.content.match(/^allowed-tools:\s*(.+)$/m);
      if (toolsMatch) {
        console.log(`│  Allowed tools: ${toolsMatch[1].trim()}`);
      }
    }
    console.log(colorize.highlight(`└──────────────────────────────────────────────────`));
    console.log('');

    const proceed = await confirm({ message: `Install '${manifest.name}'?`, default: true });
    if (!proceed) {
      console.log(colorize.warning('Install cancelled.'));
      return;
    }

    // Now write files (validator runs inside installPluginByInput via resolve+fetch path,
    // but since we already resolved, call the write path directly)
    const crossClientWrite = this.isCrossClientWriteEnabled();
    const existingManifest = this.readManifest();
    const alreadyInstalled = existingManifest.plugins.find(
      (p) => p.name === manifest.name && p.version === manifest.version,
    );
    if (alreadyInstalled) {
      console.log(colorize.info(`Plugin '${manifest.name}' v${manifest.version} is already installed. Nothing to do.`));
      return;
    }

    // Validate SKILL.md files before writing
    const skillFiles = manifest.files.filter((f) => f.path === 'SKILL.md' || f.path.endsWith('/SKILL.md'));
    for (const sf of skillFiles) {
      const syntheticPath = path.join(this.skillsDir, manifest.name, sf.path);
      const result = validateSkillContent(sf.content, syntheticPath);
      if (result.errors.length > 0) {
        result.errors.forEach((e) => {
          const field = e.field ? ` [${e.field}]` : '';
          console.error(colorize.error(`  ERROR${field}: ${e.message}`));
        });
        throw new Error(`Validation failed for '${sf.path}'. Install aborted.`);
      }
      if (result.warnings.length > 0) {
        result.warnings.forEach((w) => {
          const field = w.field ? ` [${w.field}]` : '';
          console.log(colorize.warning(`  WARN${field}: ${w.message}`));
        });
      }
    }

    const primaryDest = path.join(this.skillsDir, manifest.name);
    if (fs.existsSync(primaryDest)) fs.rmSync(primaryDest, { recursive: true });
    await adapter.fetch(manifest, primaryDest);
    console.log(colorize.success(`✓ Installed to ~/.claude/skills/${manifest.name}/`));

    if (crossClientWrite) {
      const crossDest = path.join(this.agentSkillsDir, manifest.name);
      if (fs.existsSync(crossDest)) fs.rmSync(crossDest, { recursive: true });
      await adapter.fetch(manifest, crossDest);
      console.log(colorize.success(`✓ Cross-client install to ~/.agents/skills/${manifest.name}/`));
    }

    this.ensurePluginsDirectory();
    const sourceType: PluginSource['type'] = trimmedInput.startsWith('@anthropic/')
      ? 'anthropic'
      : trimmedInput.startsWith('./') || trimmedInput.startsWith('/')
        ? 'local'
        : 'registry';

    const installedEntry: InstalledPlugin = {
      name: manifest.name,
      version: manifest.version,
      scope: 'user',
      source: { type: sourceType, ref: trimmedInput },
      skills: manifest.skills,
      agents: manifest.agents,
    };

    const updatedManifest = this.readManifest();
    const existingIdx = updatedManifest.plugins.findIndex((p) => p.name === manifest.name);
    if (existingIdx !== -1) {
      updatedManifest.plugins[existingIdx] = installedEntry;
    } else {
      updatedManifest.plugins.push(installedEntry);
    }
    this.writeManifest(updatedManifest);

    console.log(colorize.success(`\nPlugin '${manifest.name}' v${manifest.version} installed successfully.`));
    if (manifest.skills.length > 0) {
      console.log(colorize.info(`  Skills: ${manifest.skills.join(', ')}`));
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

    const choices = plugins.map((p) => ({ name: `${p.name} v${p.version}`, value: p.name }));
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

    const choices = plugins.map((p) => ({ name: `${p.name} v${p.version}`, value: p.name }));
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

    const choices = plugins.map((p) => ({ name: `${p.name} v${p.version}`, value: p.name }));
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
