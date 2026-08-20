import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Initial TripWith schema.
 *
 * The schema itself lives in hand-written .sql files next to this class rather
 * than in generated TypeScript. Generated migrations cannot express what this
 * schema depends on: PostGIS geography columns, multicolumn GIST indexes,
 * partial unique indexes, generated columns, and the trigger set that makes
 * capacity, trust and audit invariants hold at the storage layer.
 *
 * The .sql files are the review surface. This class only executes them.
 *
 * TypeORM runs each migration inside a transaction, and PostgreSQL DDL is
 * transactional, so a failure part-way leaves no partial schema behind.
 */
export class InitialSchema1787184000000 implements MigrationInterface {
  public readonly name = 'InitialSchema1787184000000';

  private read(file: string): string {
    return readFileSync(join(__dirname, 'sql', file), 'utf8');
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(this.read('1787184000000-InitialSchema.up.sql'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(this.read('1787184000000-InitialSchema.down.sql'));
  }
}
