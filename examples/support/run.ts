import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
for (const pkg of manifest.packages) {
  const result = spawnSync(process.execPath, pkg.testCommand.slice(1), { cwd: new URL('.', import.meta.url), encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`${pkg.name}: ${result.error ?? result.stderr}`);
  console.log(`${pkg.name}@${pkg.version}: ${pkg.tasks.length} tasks passed`);
}
