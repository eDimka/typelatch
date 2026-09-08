import assert from 'node:assert/strict';
import { minimatch, Minimatch } from 'minimatch';
assert.equal(minimatch('src/main.ts', '**/*.ts'), true);
assert.equal(minimatch('src/main.js', '**/*.ts'), false);
const matcher = new Minimatch('**/*.{ts,tsx}', { dot: true });
assert.equal(matcher.match('.config/app.tsx'), true);
assert.equal(matcher.match('public/image.png'), false);
