import 'dotenv/config';
import { Pool } from 'pg';
import Redis from 'ioredis';

export * from './task.entity';
export * from './step_runs.entity';

export function createPool(): Pool {
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  });
}

export function createRedis(): Redis {
  return new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    lazyConnect: true,
  });
}
