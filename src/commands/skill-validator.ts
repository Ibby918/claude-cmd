import * as fs from 'fs';
import * as yaml from 'js-yaml';

export interface ValidationIssue {
  level: 'error' | 'warning';
  field: string | null;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  filePath: string;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

// All tools exposed by Claude Code
const KNOWN_TOOLS = new Set([
  'Agent', 'AskUserQuestion', 'Bash', 'CronCreate', 'CronDelete', 'CronList',
  'Edit', 'EnterPlanMode', 'EnterWorktree', 'ExitPlanMode', 'ExitWorktree',
  'Glob', 'Grep', 'LSP', 'ListMcpResourcesTool', 'MultiEdit', 'NotebookEdit',
  'Read', 'ReadMcpResourceTool', 'SendMessage', 'Task', 'TaskOutput', 'TaskStop',
  'TeamCreate', 'TeamDelete', 'TodoWrite', 'WebFetch', 'WebSearch', 'Write',
]);

function parseFrontmatter(content: string): { frontmatter: Record<string, unknown> | null; error: string | null } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return { frontmatter: null, error: 'No frontmatter block found (expected --- delimiters at start of file)' };
  }
  try {
    const parsed = yaml.load(match[1]) as Record<string, unknown>;
    return { frontmatter: parsed || {}, error: null };
  } catch (e) {
    return { frontmatter: null, error: `Invalid YAML in frontmatter: ${(e as Error).message}` };
  }
}

export function validateSkillContent(content: string, filePath: string): ValidationResult {
  const result: ValidationResult = { valid: false, filePath, errors: [], warnings: [] };

  const { frontmatter, error: parseError } = parseFrontmatter(content);
  if (parseError || !frontmatter) {
    result.errors.push({ level: 'error', field: null, message: parseError || 'Empty frontmatter' });
    return result;
  }

  // Required: name
  const name = frontmatter['name'];
  if (!name || String(name).trim() === '') {
    result.errors.push({ level: 'error', field: 'name', message: 'Required field "name" is missing or empty' });
  }

  // Warning: description
  const description = frontmatter['description'];
  if (!description || String(description).trim() === '') {
    result.warnings.push({ level: 'warning', field: 'description', message: '"description" is missing — add one for discoverability' });
  }

  // Warning: user-invocable
  const userInvocable = frontmatter['user-invocable'];
  if (userInvocable === undefined || userInvocable === null) {
    result.warnings.push({ level: 'warning', field: 'user-invocable', message: '"user-invocable" is not set — set to true or false to clarify invocation intent' });
  } else if (typeof userInvocable !== 'boolean') {
    result.errors.push({ level: 'error', field: 'user-invocable', message: '"user-invocable" must be a boolean (true or false)' });
  }

  // Validate allowed-tools
  const allowedTools = frontmatter['allowed-tools'];
  if (allowedTools !== undefined && allowedTools !== null) {
    if (typeof allowedTools !== 'string') {
      result.errors.push({ level: 'error', field: 'allowed-tools', message: '"allowed-tools" must be a comma-separated string of tool names' });
    } else {
      const tools = allowedTools.split(',').map(t => t.trim()).filter(Boolean);
      const unknown = tools.filter(t => {
        if (KNOWN_TOOLS.has(t) || t.startsWith('mcp__')) return false;
        // Allow scoped Bash restrictions like Bash(git:*), Bash(npm:*), etc.
        const scopedMatch = t.match(/^(\w+)\(.+\)$/);
        if (scopedMatch && KNOWN_TOOLS.has(scopedMatch[1])) return false;
        return true;
      });
      if (unknown.length > 0) {
        result.errors.push({ level: 'error', field: 'allowed-tools', message: `Unknown tool(s) in "allowed-tools": ${unknown.join(', ')}` });
      }
      if (tools.includes('Bash')) {
        result.warnings.push({ level: 'warning', field: 'allowed-tools', message: '"Bash" is included without restriction — consider limiting scope if possible' });
      }
    }
  }

  // Validate model
  const model = frontmatter['model'];
  if (model !== undefined && model !== null) {
    if (typeof model !== 'string' || !String(model).startsWith('claude-')) {
      result.errors.push({ level: 'error', field: 'model', message: `"model" value "${model}" is not a recognized Claude model (must start with "claude-")` });
    }
  }

  // Validate disable-model-invocation
  const dmi = frontmatter['disable-model-invocation'];
  if (dmi !== undefined && dmi !== null && typeof dmi !== 'boolean') {
    result.errors.push({ level: 'error', field: 'disable-model-invocation', message: '"disable-model-invocation" must be a boolean' });
  }

  // Validate argument-hint
  const argHint = frontmatter['argument-hint'];
  if (argHint !== undefined && argHint !== null) {
    if (typeof argHint !== 'string' || String(argHint).trim() === '') {
      result.errors.push({ level: 'error', field: 'argument-hint', message: '"argument-hint" must be a non-empty string' });
    }
  }

  result.valid = result.errors.length === 0;
  return result;
}

export function validateSkillFile(filePath: string): ValidationResult {
  if (!fs.existsSync(filePath)) {
    return {
      valid: false,
      filePath,
      errors: [{ level: 'error', field: null, message: `File not found: ${filePath}` }],
      warnings: [],
    };
  }

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    return {
      valid: false,
      filePath,
      errors: [{ level: 'error', field: null, message: `Cannot read file: ${(e as Error).message}` }],
      warnings: [],
    };
  }

  return validateSkillContent(content, filePath);
}

export function printValidationResult(result: ValidationResult, jsonMode: boolean): void {
  if (jsonMode) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  const { filePath, errors, warnings } = result;
  console.log(`\nValidating: ${filePath}`);

  if (errors.length === 0 && warnings.length === 0) {
    console.log('✓ Valid — no issues found.');
    return;
  }

  errors.forEach(e => {
    const field = e.field ? ` [${e.field}]` : '';
    console.error(`  ERROR${field}: ${e.message}`);
  });

  warnings.forEach(w => {
    const field = w.field ? ` [${w.field}]` : '';
    console.warn(`  WARN${field}: ${w.message}`);
  });

  if (errors.length > 0) {
    console.error(`\n✗ ${errors.length} error(s), ${warnings.length} warning(s)`);
  } else {
    console.warn(`\n⚠ ${warnings.length} warning(s) — skill is usable but could be improved`);
  }
}
