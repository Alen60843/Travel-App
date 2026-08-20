#!/usr/bin/env node
/**
 * Enum drift check.
 *
 * The PostgreSQL ENUM types in the migration and the TypeScript unions in
 * packages/shared are two copies of the same domain vocabulary. Copies drift.
 * This compares them directly, with no database connection and no dependencies,
 * so it can run as the first step of CI.
 *
 *   node scripts/check-enum-parity.mjs
 *
 * Exits non-zero on any mismatch.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SQL_PATH = join(
  root,
  'apps/api/src/database/migrations/sql/1787184000000-InitialSchema.up.sql',
);
const TS_PATH = join(root, 'packages/shared/src/enums.ts');

/** snake_case -> PascalCase, matching the naming used in enums.ts */
const toPascal = (s) =>
  s.split('_').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');

function parseSqlEnums(sql) {
  const out = new Map();
  const re = /CREATE\s+TYPE\s+(\w+)\s+AS\s+ENUM\s*\(([\s\S]*?)\)\s*;/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    const values = [...m[2].matchAll(/'([^']+)'/g)].map((v) => v[1]);
    out.set(m[1], values);
  }
  return out;
}

function parseTsEnums(ts) {
  const out = new Map();
  const re = /export\s+const\s+(\w+)\s*=\s*\{([\s\S]*?)\}\s*as\s+const;/g;
  let m;
  while ((m = re.exec(ts)) !== null) {
    const values = [...m[2].matchAll(/:\s*'([^']+)'/g)].map((v) => v[1]);
    if (values.length > 0) out.set(m[1], values);
  }
  return out;
}

const sqlEnums = parseSqlEnums(readFileSync(SQL_PATH, 'utf8'));
const tsEnums = parseTsEnums(readFileSync(TS_PATH, 'utf8'));

const problems = [];

for (const [sqlName, sqlValues] of sqlEnums) {
  const tsName = toPascal(sqlName);
  const tsValues = tsEnums.get(tsName);

  if (!tsValues) {
    problems.push(`${sqlName}: no matching TypeScript export "${tsName}"`);
    continue;
  }

  const missing = sqlValues.filter((v) => !tsValues.includes(v));
  const extra = tsValues.filter((v) => !sqlValues.includes(v));

  if (missing.length) problems.push(`${sqlName}: missing in TS -> ${missing.join(', ')}`);
  if (extra.length) problems.push(`${sqlName}: extra in TS -> ${extra.join(', ')}`);
}

const sqlPascal = new Set([...sqlEnums.keys()].map(toPascal));
for (const tsName of tsEnums.keys()) {
  if (!sqlPascal.has(tsName)) {
    problems.push(`${tsName}: declared in TS but no such PostgreSQL ENUM type`);
  }
}

if (problems.length > 0) {
  console.error('ENUM PARITY FAILED\n');
  for (const p of problems) console.error(`  - ${p}`);
  console.error(`\n${problems.length} problem(s).`);
  process.exit(1);
}

console.log(
  `enum parity OK — ${sqlEnums.size} PostgreSQL ENUM types match their ` +
    `TypeScript counterparts (${[...sqlEnums.values()].reduce((n, v) => n + v.length, 0)} values checked)`,
);
