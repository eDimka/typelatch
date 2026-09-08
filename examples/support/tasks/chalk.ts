import assert from 'node:assert/strict';
import { Chalk } from 'chalk';
const colored = new Chalk({ level: 1 });
assert.equal(colored.red('failure'), '\u001b[31mfailure\u001b[39m');
const plain = new Chalk({ level: 0 });
assert.equal(plain.bold.green('success'), 'success');
