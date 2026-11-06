import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { projectSourceEvidence, modelBytes } from './projection.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(text, line = 1) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'packet-expansion-'))), path = join(root, 'unrelated.ts');
  await writeFile(path, text);
  const raw = { status: 'ok', results: [{ origin: 'workspace', source: path, line, score: 12 }], coverage: { files: 1, complete: true }, checks: { stable: { status: 'unknown', reason: 'Not atomic' } }, sourceContext: { files: [{ source: path, sha256: hash(text), startLine: line, startColumn: 1, text: text.split('\n').slice(line - 1, line + 2).join('\n'), complete: false, omittedBytes: text.length }] } };
  return { root, path, raw, close: () => rm(root, { recursive: true }) };
}
test('a small complete module replaces a clipped hit fragment', async () => {
  const text = 'export function unrelatedCount(value: number) {\n' + Array.from({ length: 70 }, (_, i) => `  value += ${i};`).join('\n') + '\n  return value * 937;\n}\n';
  const f = await fixture(text, 35);
  try { const result = await projectSourceEvidence(f.raw, f.root, { typescript: ts }); assert.equal(result.candidates[0].text, text); assert.equal(result.candidates[0].sourceComplete, true); assert.equal(result.candidates[0].omittedBytes, 0); assert.equal(result.candidates[0].excerptSha256, hash(text)); assert.equal(result.measurement.nativeFileReads, 2); }
  finally { await f.close(); }
});
test('a large module expands an interior hit to the complete enclosing function', async () => {
  const prefix = Array.from({ length: 700 }, (_, i) => `export const filler${i} = ${i};`).join('\n') + '\n';
  const body = 'export function unrelatedFold(value: number) {\n' + Array.from({ length: 90 }, (_, i) => `  value ^= ${i};`).join('\n') + '\n  return value * 553;\n}\n';
  const f = await fixture(prefix + body, 735);
  try { const result = await projectSourceEvidence(f.raw, f.root, { typescript: ts }); assert(result.candidates[0].text.includes(body.trim())); assert.equal(result.candidates[0].declarationComplete, true); assert.equal(result.candidates[0].sourceComplete, false); assert(result.candidates[0].omittedBytes > 0); assert(modelBytes(result.text) <= 8192); }
  finally { await f.close(); }
});
test('a source hash race is rejected before evidence is returned', async () => {
  const f = await fixture('export const unrelated = 1;\n');
  try { await writeFile(f.path, 'export const unrelated = 2;\n'); await assert.rejects(projectSourceEvidence(f.raw, f.root, { typescript: ts }), /Source changed/); }
  finally { await f.close(); }
});
test('a change after expansion is rejected by the final hash check', async () => {
  const f = await fixture('export const unrelated = 1;\n'); let reads = 0;
  try { await assert.rejects(projectSourceEvidence(f.raw, f.root, { typescript: ts, readSource: async path => { const bytes = await readFile(path); if (++reads === 1) await writeFile(path, 'export const unrelated = 2;\n'); return bytes; } }), /Source changed/); }
  finally { await f.close(); }
});
test('oversized declarations stay explicitly partial and within every budget', async () => {
  const text = 'export function unicodeBudget() {\n' + Array.from({ length: 900 }, (_, i) => `  const emoji${i} = "🙂é";`).join('\n') + '\n}\n'; const f = await fixture(text, 450);
  try { for (const byteLimit of [4096, 8192, 12288]) { const result = await projectSourceEvidence(f.raw, f.root, { typescript: ts, byteLimit }); assert(modelBytes(result.text) <= byteLimit); assert(result.candidates.length); assert.equal(result.candidates[0].declarationComplete, false); assert(result.candidates[0].omittedBytes > 0); assert(!result.candidates[0].text.includes('�')); assert.equal(result.candidates[0].excerptSha256, hash(result.candidates[0].text)); } }
  finally { await f.close(); }
});
