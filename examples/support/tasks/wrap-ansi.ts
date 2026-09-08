import assert from 'node:assert/strict';
import wrapAnsi from 'wrap-ansi';
assert.equal(wrapAnsi('one two three', 7), 'one two\nthree');
assert.equal(wrapAnsi('abcdefgh', 3, { hard: true }), 'abc\ndef\ngh');
