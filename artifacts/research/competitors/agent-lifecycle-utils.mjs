import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

export const exec = promisify(execFile);
export const sleep = ms => new Promise(done => setTimeout(done, ms));
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const save = (path, value, options = {}) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, ...options });
export async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export function inheritedEnvironment(source = process.env) {
  return Object.fromEntries(['PATH', 'TMPDIR', 'LANG', 'LC_ALL'].flatMap(key => typeof source[key] === 'string' ? [[key, source[key]]] : []));
}
export async function externalPaths(workspace, state) {
  if (!isAbsolute(workspace) || !isAbsolute(state)) throw Error('Absolute workspace and state paths are required');
  const outside = (base, target) => {
    const value = relative(base, target);
    return value === '..' || value.startsWith('..' + sep) || isAbsolute(value);
  };
  if (!outside(resolve(workspace), resolve(state))) throw Error('State must be outside the workspace');
  workspace = await realpath(workspace);
  const missing = []; let ancestor = resolve(state);
  while (true) {
    try { state = resolve(await realpath(ancestor), ...missing.toReversed()); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; missing.push(basename(ancestor)); ancestor = dirname(ancestor); }
  }
  if (!outside(workspace, state)) throw Error('Resolved state must be outside the workspace');
  await mkdir(state, { recursive: true });
  state = await realpath(state);
  if (!outside(workspace, state)) throw Error('Resolved state must be outside the workspace');
  return { workspace, state };
}
export const alive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
};
export async function codegraphProcesses(workspace, runtime) {
  const { stdout } = await exec('ps', ['-axo', 'pid=,command=']);
  return stdout.split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(.*)$/u);
    if (!match) return [];
    const command = match[2];
    return command.startsWith(runtime + '/') && command.endsWith('codegraph.js serve --mcp --path ' + workspace)
      ? [{ pid: Number(match[1]), command }]
      : [];
  });
}
