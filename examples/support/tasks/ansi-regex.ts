import assert from 'node:assert/strict';
import ansiRegex from 'ansi-regex';
const styled = '\u001b[31mred\u001b[39m';
assert.deepEqual(styled.match(ansiRegex()), ['\u001b[31m', '\u001b[39m']);
assert.deepEqual(Array.from(styled.match(ansiRegex({ onlyFirst: true })) ?? []), ['\u001b[31m']);
