import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm';
import { ENTITIES } from './entities';

/**
 * Builds TypeORM options for SQLite.
 *
 * - In production/dev: a file-backed SQLite DB (path via DB_PATH).
 * - In tests: callers pass ':memory:' for a fast, isolated database.
 *
 * `synchronize: true` is acceptable here because the schema is owned entirely
 * by this service and the assignment uses SQLite; a real deployment would use
 * migrations (TRD §12).
 */
export function buildTypeOrmOptions(database = process.env.DB_PATH || 'timeoff.sqlite'): TypeOrmModuleOptions {
  return {
    type: 'better-sqlite3',
    database,
    entities: ENTITIES,
    synchronize: true,
    // SQLite is single-writer; keep a small busy timeout so brief lock waits
    // during the reserve critical section don't immediately error.
    prepareDatabase: (db: { pragma: (s: string) => void }) => {
      db.pragma('journal_mode = WAL');
      db.pragma('busy_timeout = 5000');
      db.pragma('foreign_keys = ON');
    },
  };
}

export const DatabaseModule = TypeOrmModule.forRoot(buildTypeOrmOptions());
