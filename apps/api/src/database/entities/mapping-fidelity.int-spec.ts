import type { ColumnMetadata } from 'typeorm/metadata/ColumnMetadata';

import { AppDataSource } from '../data-source';

/**
 * The highest-value test in this module: proves every mapped entity column
 * exists in the real database with a matching type and nullability, AND
 * that no database column was left unmapped. A typo in a column `name`, a
 * wrong `type`, or a nullability mismatch fails here — not in production.
 *
 * Deliberately implemented against information_schema (per the task spec)
 * rather than TypeORM's own schema-diff builder: the diff builder also
 * compares DEFAULT expressions and index/constraint shape, which would
 * make this test fail on cosmetic differences (e.g. `now()` vs a
 * client-computed default) that have nothing to do with mapping
 * correctness. information_schema.columns is the narrower, more precise
 * tool for the specific claim this test makes.
 */

interface InformationSchemaColumn {
  readonly table_name: string;
  readonly column_name: string;
  readonly data_type: string;
  readonly udt_name: string;
  readonly is_nullable: 'YES' | 'NO';
}

/**
 * Maps a TypeORM base column `type` string to the PostgreSQL `udt_name`
 * information_schema reports for it. Only covers the types actually used in
 * this schema — see entities/*.entity.ts for the full inventory.
 */
const BASE_TYPE_TO_UDT: Readonly<Record<string, string>> = {
  uuid: 'uuid',
  text: 'text',
  boolean: 'bool',
  smallint: 'int2',
  integer: 'int4',
  bigint: 'int8',
  numeric: 'numeric',
  jsonb: 'jsonb',
  timestamptz: 'timestamptz',
  date: 'date',
  character: 'bpchar',
  inet: 'inet',
  bytea: 'bytea',
  real: 'float4',
  daterange: 'daterange',
  tstzrange: 'tstzrange',
};

// PostGIS/system objects that live in the `public` schema alongside our
// tables but are not part of the application schema this agent owns.
const NON_APPLICATION_TABLES = new Set([
  'spatial_ref_sys',
  'geography_columns',
  'geometry_columns',
  'schema_migrations',
]);

function describeTypeMismatch(column: ColumnMetadata, dbColumn: InformationSchemaColumn): string | null {
  if (column.isArray) {
    if (dbColumn.data_type !== 'ARRAY') {
      return `expected an ARRAY column (entity has array:true), db data_type is "${dbColumn.data_type}"`;
    }
    const elementUdt = BASE_TYPE_TO_UDT[column.type as string];
    if (elementUdt && dbColumn.udt_name !== `_${elementUdt}`) {
      return `expected array element udt_name "_${elementUdt}", got "${dbColumn.udt_name}"`;
    }
    return null;
  }

  if (column.type === 'enum') {
    if (dbColumn.data_type !== 'USER-DEFINED') {
      return `expected an enum column (USER-DEFINED), db data_type is "${dbColumn.data_type}"`;
    }
    if (column.enumName && dbColumn.udt_name !== column.enumName) {
      return `expected enum type "${column.enumName}", db udt_name is "${dbColumn.udt_name}"`;
    }
    return null;
  }

  if (column.type === 'geography') {
    if (dbColumn.udt_name !== 'geography') {
      return `expected udt_name "geography", got "${dbColumn.udt_name}"`;
    }
    return null;
  }

  const expectedUdt = BASE_TYPE_TO_UDT[column.type as string];
  if (!expectedUdt) return null; // type not in the lookup table — existence/nullability still checked
  if (dbColumn.udt_name !== expectedUdt) {
    return `expected udt_name "${expectedUdt}" for entity type "${String(column.type)}", got "${dbColumn.udt_name}"`;
  }
  return null;
}

describe('entity <-> database mapping fidelity (real database)', () => {
  beforeAll(async () => {
    await AppDataSource.initialize();
  });

  afterAll(async () => {
    await AppDataSource.destroy();
  });

  it('maps every entity column onto a matching database column, with no database column left unmapped', async () => {
    const rows: InformationSchemaColumn[] = await AppDataSource.query(
      `SELECT table_name, column_name, data_type, udt_name, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public'
        ORDER BY table_name, ordinal_position`,
    );

    const dbColumns = new Map<string, InformationSchemaColumn>();
    for (const row of rows) {
      if (NON_APPLICATION_TABLES.has(row.table_name)) continue;
      dbColumns.set(`${row.table_name}.${row.column_name}`, row);
    }
    expect(dbColumns.size).toBeGreaterThan(0); // sanity: the migration actually ran

    const mappedKeys = new Set<string>();
    const mismatches: string[] = [];

    for (const metadata of AppDataSource.entityMetadatas) {
      for (const column of metadata.columns) {
        const key = `${metadata.tableName}.${column.databaseName}`;
        mappedKeys.add(key);

        const dbColumn = dbColumns.get(key);
        if (!dbColumn) {
          mismatches.push(
            `${key}: mapped by ${metadata.name}.${column.propertyName} but no such column exists in the database`,
          );
          continue;
        }

        const expectedNullable = dbColumn.is_nullable === 'YES';
        if (column.isNullable !== expectedNullable) {
          mismatches.push(
            `${key}: nullability mismatch (entity isNullable=${column.isNullable}, db is_nullable=${dbColumn.is_nullable})`,
          );
        }

        const typeError = describeTypeMismatch(column, dbColumn);
        if (typeError) mismatches.push(`${key}: ${typeError}`);
      }
    }

    const unmappedDbColumns = [...dbColumns.keys()].filter((key) => !mappedKeys.has(key)).sort();

    if (mismatches.length > 0 || unmappedDbColumns.length > 0) {
      throw new Error(
        [
          mismatches.length > 0 ? `Mismatches:\n  ${mismatches.join('\n  ')}` : null,
          unmappedDbColumns.length > 0
            ? `Database columns with no entity mapping:\n  ${unmappedDbColumns.join('\n  ')}`
            : null,
        ]
          .filter(Boolean)
          .join('\n\n'),
      );
    }
  });

  it('covers all 35 application tables', () => {
    const mappedTables = new Set(AppDataSource.entityMetadatas.map((m) => m.tableName));
    expect(mappedTables.size).toBe(35);
  });
});
