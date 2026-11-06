import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openProvider } from './adapter.mjs';
import { alive, codegraphProcesses, externalPaths, hash, inheritedEnvironment, readJson, save, sleep } from './agent-lifecycle-utils.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const runtime = join(here, 'codegraph/install');
const sessions = new Map();
const ownerNonce = randomUUID();
const cache = state => join(state, 'codegraph');
const receiptPath = state => join(state, 'codegraph-agent-lifecycle.json');

export function serverSpec({ workspace = '{workspace}', state = '{state}', inherited = inheritedEnvironment() } = {}) {
  const base = cache(state);
  return {
    command: join(runtime, 'node_modules/.bin/codegraph'),
    args: ['serve', '--mcp', '--path', workspace], cwd: workspace,
    env: {
      ...inheritedEnvironment(inherited),
      HOME: join(base, 'home'), XDG_CONFIG_HOME: join(base, 'config'), XDG_CACHE_HOME: join(base, 'cache'),
      XDG_DATA_HOME: join(base, 'data'), CODEX_HOME: join(base, 'codex'), CLAUDE_CONFIG_DIR: join(base, 'claude'),
      CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1', CODEGRAPH_NO_UPDATE_CHECK: '1', CODEGRAPH_NO_INSTALL_REFRESH: '1',
      GRAPHIFY_NO_AUTO_REFRESH: '1', GRAPHIFY_QUERY_LOG_DISABLE: '1', GRAPHIFY_BACKEND: 'none', PYTHONHASHSEED: '0', PYTHONUNBUFFERED: '1',
    },
    startup_timeout_sec: 600, tool_timeout_sec: 180, tools: ['codegraph_explore'],
  };
}

async function cleanup({ workspace, state }) {
  const receipt = await readJson(receiptPath(state));
  if (!receipt) return { stopped: true, scope: 'no setup receipt or owned launch', requiresCaptureGroupStopped: true };
  assert.equal(receipt.ownerNonce, ownerNonce, 'Cleanup receipt ownership must match this coordinator invocation');
  assert.equal(receipt.workspace, workspace, 'Cleanup workspace must match the startup receipt');
  assert.equal(receipt.state, state, 'Cleanup state must match the startup receipt');
  const client = sessions.get(state);
  let clientCleanup = null, clientError = null;
  try { clientCleanup = await client?.close(); }
  catch (error) { clientError = String(error); }
  sessions.delete(state);
  const daemon = await readJson(join(cache(state), 'index/daemon.pid'));
  const termination = [];
  if (daemon && alive(daemon.pid)) {
    assert(daemon.startedAt >= Date.parse(receipt.startedAt), 'Refusing to stop a daemon predating this startup');
    const matches = await codegraphProcesses(workspace, runtime);
    assert(matches.some(row => row.pid === daemon.pid), 'Daemon process identity does not match this workspace and runtime');
    process.kill(daemon.pid, 'SIGTERM'); termination.push({ pid: daemon.pid, signal: 'SIGTERM' });
    for (let attempt = 0; attempt < 50 && alive(daemon.pid); attempt++) await sleep(100);
    if (alive(daemon.pid)) {
      const current = await codegraphProcesses(workspace, runtime);
      assert(current.some(row => row.pid === daemon.pid), 'Daemon process identity changed during cleanup');
      process.kill(daemon.pid, 'SIGKILL'); termination.push({ pid: daemon.pid, signal: 'SIGKILL' });
      for (let attempt = 0; attempt < 30 && alive(daemon.pid); attempt++) await sleep(100);
    }
  }
  const remaining = await codegraphProcesses(workspace, runtime);
  const result = { stopped: remaining.length === 0 && !clientError, scope: 'setup client and workspace CodeGraph processes', requiresCaptureGroupStopped: true, clientCleanup, clientError, termination, remaining, completedAt: new Date().toISOString() };
  await save(join(state, 'codegraph-agent-cleanup.json'), result);
  return result;
}

export async function start({ workspace, state, arm }) {
  ({ workspace, state } = await externalPaths(workspace, state));
  await mkdir(cache(state), { recursive: false });
  const receipt = { provider: 'codegraph', ownerNonce, arm, workspace, state, startedAt: new Date().toISOString(), status: 'starting', additionalSetupMcpClient: true, modelQueriesDuringSetup: 0 };
  await save(receiptPath(state), receipt, { flag: 'wx' });
  try {
    const session = await openProvider({ provider: 'codegraph', workspace, cacheRoot: cache(state), mode: 'cold' });
    sessions.set(state, session);
    const expected = serverSpec({ workspace, state });
    for (const key of ['command', 'args', 'env', 'cwd']) assert.deepEqual(session.launchspec[key], expected[key], 'Frozen MCP launch differs from prepared provider: ' + key);
    receipt.status = 'ready'; receipt.readyAt = new Date().toISOString();
    receipt.launchspec = session.launchspec;
    receipt.adapterSha256 = hash(await readFile(join(here, 'adapter.mjs')));
    receipt.setupRecord = session.setupRecord;
    await save(receiptPath(state), receipt);
    return { evidence: receipt, close: () => cleanup({ workspace, state }) };
  } catch (error) {
    receipt.status = 'failed'; receipt.error = String(error); await save(receiptPath(state), receipt);
    receipt.cleanup = await cleanup({ workspace, state }).catch(cleanupError => ({ stopped: false, error: String(cleanupError) }));
    await save(receiptPath(state), receipt); throw error;
  }
}

export async function cleanupFailedStart({ workspace, state }) {
  ({ workspace, state } = await externalPaths(workspace, state));
  return cleanup({ workspace, state });
}
