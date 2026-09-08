import assert from 'node:assert/strict';
import stripAnsi from 'strip-ansi';
assert.equal(stripAnsi('\u001b[31mERROR\u001b[39m'), 'ERROR');
assert.equal(stripAnsi('\u001b]8;;https://example.com\u0007docs\u001b]8;;\u0007'), 'docs');
