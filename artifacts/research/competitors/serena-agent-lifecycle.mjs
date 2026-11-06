import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { externalPaths, hash, inheritedEnvironment, save } from './agent-lifecycle-utils.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const runtime = join(here, '../serena-baseline');
export function serverSpec({ workspace = '{workspace}', state = '{state}', inherited = inheritedEnvironment() } = {}) {
  return {
    command: join(runtime, 'venv/bin/serena'),
    args: ['start-mcp-server', '--project', workspace, '--agent-interface', 'REPL', '--transport', 'stdio', '--enable-web-dashboard', 'false', '--enable-gui-log-window', 'false', '--open-web-dashboard', 'false', '--log-level', 'INFO'],
    cwd: workspace,
    env: { ...inheritedEnvironment(inherited), SERENA_HOME: join(state, 'serena-home'), XDG_CACHE_HOME: join(state, 'xdg-cache'), XDG_CONFIG_HOME: join(state, 'xdg-config'), PYTHONNOUSERSITE: '1', PYTHONUNBUFFERED: '1', npm_config_cache: join(state, 'npm-cache'), npm_config_offline: 'true' },
    startup_timeout_sec: 600, tool_timeout_sec: 180, tools: ['activate_project', 'initial_instructions', 'serena_repl'],
  };
}

const closed = () => ({ stopped: true, scope: 'setup-owned processes only; setup does not launch a process', requiresCaptureGroupStopped: true, completedAt: new Date().toISOString() });

export async function start({ workspace, state, arm }) {
  ({ workspace, state } = await externalPaths(workspace, state));
  const startedAt = new Date().toISOString();
  const home = join(state, 'serena-home'), projectData = join(state, 'project-data');
  await mkdir(home); await mkdir(projectData);
  await Promise.all(['xdg-cache', 'xdg-config', 'npm-cache'].map(path => mkdir(join(state, path))));
  const config = {
    projects: [workspace], agent_interface: 'REPL', web_dashboard: false, web_dashboard_open_on_launch: false, gui_log_window: false,
    project_serena_folder_location: projectData, trusted_project_path_patterns: [workspace],
    ls_specific_settings: { typescript: { ls_path: join(runtime, 'ls-runtime/node_modules/.bin/typescript-language-server'), typescript_version: '5.5.4', typescript_language_server_version: '5.1.3', indexing_timeout: 120, indexing_start_grace: 10 } }, log_level: 'INFO',
  };
  const project = { project_name: 'isolated-agent-workspace', language_servers: ['typescript'], encoding: 'utf-8', ignore_all_files_in_gitignore: true, ls_workspace_folders: ['.'], read_only: false };
  const files = [[join(home, 'serena_config.yml'), config], [join(projectData, 'project.yml'), project]];
  for (const [path, value] of files) await save(path, value, { flag: 'wx' });
  const evidence = {
    provider: 'serena', arm, workspace, state, startedAt, readyAt: new Date().toISOString(), setupSpawnedProcesses: 0,
    readiness: 'Configuration prepared only. Codex starts and initializes the MCP server during measured agent time.',
    launchspec: serverSpec({ workspace, state }), configs: await Promise.all(files.map(async ([path]) => ({ path, sha256: hash(await readFile(path)) }))),
    editingEnabled: true, isolatedNpmCache: true,
    compilerSelection: 'Serena uses native workspace compiler discovery. Configured fallback versions do not prove the compiler selected. Retain actual version notifications from MCP stderr.',
    cleanupRequirement: 'The recorder must independently confirm its Codex process group stopped.',
  };
  await save(join(state, 'serena-agent-lifecycle.json'), evidence, { flag: 'wx' });
  return { evidence, close: async () => { const result = closed(); await save(join(state, 'serena-agent-cleanup.json'), result); return result; } };
}

export async function cleanupFailedStart({ workspace, state }) {
  ({ workspace, state } = await externalPaths(workspace, state));
  const result = closed(); await save(join(state, 'serena-agent-cleanup.json'), result); return result;
}
