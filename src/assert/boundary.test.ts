// The import boundary (epic C1): nothing under src/assert/ may import from
// src/core/server, src/surfaces, or src/run. The assertion library reads
// recordings; it must never depend on the server that writes them.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const ASSERT_DIR = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(ASSERT_DIR, '..');
const FORBIDDEN = ['core/server', 'surfaces', 'run'].map((p) => resolve(SRC_DIR, p));

/** Every module specifier in static `import ... from`, `export ... from`, and dynamic `import()` forms. */
export function importSpecifiers(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g)) out.push(match[1]!);
  return out;
}

/** The forbidden root a specifier resolves into, or null. Only relative specifiers can reach src/. */
export function forbiddenTarget(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const target = resolve(dirname(fromFile), specifier).replace(/\.(js|ts|mjs|cjs|mts|cts)$/, '');
  for (const root of FORBIDDEN) {
    if (target === root || target.startsWith(`${root}/`)) return relative(SRC_DIR, root);
  }
  return null;
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = resolve(dir, name);
    if (statSync(path).isDirectory()) return tsFiles(path);
    return /\.(ts|mts|cts)$/.test(name) ? [path] : [];
  });
}

describe('src/assert import boundary', () => {
  test('no file under src/assert imports from core/server, surfaces, or run', () => {
    const files = tsFiles(ASSERT_DIR);
    expect(files.length).toBeGreaterThan(0);
    const violations: string[] = [];
    for (const file of files) {
      for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
        const hit = forbiddenTarget(file, specifier);
        if (hit !== null) violations.push(`${relative(SRC_DIR, file)} imports ${specifier} (resolves into ${hit})`);
      }
    }
    expect(violations).toEqual([]);
  });

  test('the scanner catches every import form and every forbidden root', () => {
    const file = resolve(ASSERT_DIR, 'recording.ts');
    // Built at runtime so this file's own source holds no import-shaped text for the scan above to trip on.
    const sample = [
      statement('import', './a.js'),
      statement('export', '../core/server.js'),
      statement('dynamic', '../surfaces/anthropic.js'),
      statement('bare', '../run/index.js'),
    ].join('\n');
    expect(importSpecifiers(sample)).toEqual(['./a.js', '../core/server.js', '../surfaces/anthropic.js', '../run/index.js']);
    expect(forbiddenTarget(file, '../core/server.js')).toBe('core/server');
    expect(forbiddenTarget(file, '../surfaces/anthropic.js')).toBe('surfaces');
    expect(forbiddenTarget(file, '../surfaces/openai')).toBe('surfaces');
    expect(forbiddenTarget(file, '../run/index.js')).toBe('run');
    expect(forbiddenTarget(file, '../run.js')).toBe('run');
    expect(forbiddenTarget(file, '../core/recording.js')).toBeNull();
    expect(forbiddenTarget(file, '../core/servers.js')).toBeNull();
    expect(forbiddenTarget(file, './verdict.js')).toBeNull();
    expect(forbiddenTarget(file, 'node:fs')).toBeNull();
  });
});

function statement(kind: 'import' | 'export' | 'dynamic' | 'bare', specifier: string): string {
  const quoted = `'${specifier}'`;
  if (kind === 'dynamic') return `const m = await import(${quoted});`;
  if (kind === 'bare') return `import ${quoted};`;
  return `${kind} { x } ${'from'} ${quoted};`;
}
