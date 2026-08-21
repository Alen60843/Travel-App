import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Keeps historical selections while excluding inactive interests from matching. */
export class Phase3InterestProjection1787270400000 implements MigrationInterface {
  public readonly name = 'Phase3InterestProjection1787270400000';

  private read(file: string): string {
    return readFileSync(join(__dirname, 'sql', file), 'utf8');
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(this.read('1787270400000-Phase3InterestProjection.up.sql'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(this.read('1787270400000-Phase3InterestProjection.down.sql'));
  }
}
