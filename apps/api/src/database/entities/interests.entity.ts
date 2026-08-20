import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryColumn,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * INTERESTS domain — the editorial lookup table plus the user join table
 * whose membership drives user_profiles.interest_ids (see identity.entity.ts).
 */

@Entity('interests')
export class InterestEntity {
  @PrimaryGeneratedColumn({ type: 'integer', name: 'id' })
  readonly id!: number;

  @Column({ type: 'text', name: 'code' })
  code!: string;

  @Column({ type: 'text', name: 'label' })
  label!: string;

  @Column({ type: 'text', name: 'grouping', nullable: true })
  grouping!: string | null;

  @Column({ type: 'boolean', name: 'is_active' })
  isActive!: boolean;

  @Column({ type: 'smallint', name: 'sort_order' })
  sortOrder!: number;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  readonly createdAt!: Date;

  @OneToMany(() => UserInterestEntity, (userInterest) => userInterest.interest)
  userInterests?: UserInterestEntity[];
}

@Entity('user_interests')
export class UserInterestEntity {
  @PrimaryColumn({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @PrimaryColumn({ type: 'integer', name: 'interest_id' })
  interestId!: number;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  readonly createdAt!: Date;

  @ManyToOne(() => InterestEntity, (interest) => interest.userInterests)
  @JoinColumn({ name: 'interest_id' })
  interest?: InterestEntity;
}
