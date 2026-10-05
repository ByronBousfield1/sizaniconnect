import type pg from 'pg';
import { withTransaction, type Db } from '../db/pool.js';
import { EventRepository } from './eventRepository.js';
import { HouseholdRepository } from './householdRepository.js';
import {
  AuditRepository,
  CollectionRepository,
  DonationRepository,
  ReportRepository,
  ShiftRepository,
  StockRepository,
} from './operationsRepositories.js';
import { TokenRepository, UserRepository } from './userRepository.js';

export interface Repositories {
  users: UserRepository;
  tokens: TokenRepository;
  households: HouseholdRepository;
  events: EventRepository;
  collections: CollectionRepository;
  shifts: ShiftRepository;
  donations: DonationRepository;
  stock: StockRepository;
  audit: AuditRepository;
  reports: ReportRepository;
}

export function createRepositories(db: Db): Repositories {
  return {
    users: new UserRepository(db),
    tokens: new TokenRepository(db),
    households: new HouseholdRepository(db),
    events: new EventRepository(db),
    collections: new CollectionRepository(db),
    shifts: new ShiftRepository(db),
    donations: new DonationRepository(db),
    stock: new StockRepository(db),
    audit: new AuditRepository(db),
    reports: new ReportRepository(db),
  };
}

/**
 * Unit of Work (Task 1, Section 9.1). `run` hands the callback a set of repositories bound to one
 * transaction, so a collection, its stock movements and its audit entry commit together or not at
 * all. `read` uses the pool directly for queries that change nothing.
 */
export class UnitOfWork {
  constructor(private readonly pool: pg.Pool) {}

  read<T>(fn: (repos: Repositories) => Promise<T>): Promise<T> {
    return fn(createRepositories(this.pool));
  }

  run<T>(fn: (repos: Repositories) => Promise<T>): Promise<T> {
    return withTransaction(this.pool, (tx) => fn(createRepositories(tx)));
  }
}
