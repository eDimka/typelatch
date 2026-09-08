import assert from 'node:assert/strict';
import supportsColor, { createSupportsColor } from 'supports-color';
const previousForceColor = process.env.FORCE_COLOR;
process.env.FORCE_COLOR = '3';
const detected = createSupportsColor(undefined, { sniffFlags: false });
assert.deepEqual(detected, { level: 3, hasBasic: true, has256: true, has16m: true });
if (previousForceColor === undefined) delete process.env.FORCE_COLOR;
else process.env.FORCE_COLOR = previousForceColor;
if (detected) {
  assert.equal(typeof detected.hasBasic, 'boolean');
  assert.equal(typeof detected.has256, 'boolean');
  assert.equal(typeof detected.has16m, 'boolean');
}
const output = supportsColor.stdout;
const error = supportsColor.stderr;
for (const capability of [output, error]) {
  assert.ok(capability === false || [0, 1, 2, 3].includes(capability.level));
}
// Isolated processes make the default stream capability checks independent of CI/TTY state.
import { spawnSync } from 'node:child_process';
for (const level of [0, 3]) {
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import supportsColor from 'supports-color';
    const expected = ${level} === 0 ? false : { level: 3, hasBasic: true, has256: true, has16m: true };
    assert.deepEqual(supportsColor['stdout'], expected);
    assert.deepEqual(supportsColor.stderr, expected);
  `], { cwd: new URL('..', import.meta.url), env: { ...process.env, FORCE_COLOR: String(level) }, encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.stderr);
}
