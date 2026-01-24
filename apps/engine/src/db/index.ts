/**
 * Database connection management for Postgres and Redis.
 * Configures connection pools with production-ready settings.
 */
import 'dotenv/config';
import Redis from 'ioredis';
import { Pool } from 'pg';

/**
 * Postgres connection pool with optimized settings:
 * - max: 20 connections (suitable for moderate load)
 * - idleTimeoutMillis: 30s (release idle connections)
 * - connectionTimeoutMillis: 2s (fail fast on connection issues)
 */
export const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

/** Redis client for caching and pub/sub */
export const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

/**
 * Fatal error handler for unexpected pool errors.
 * Crashes the process to trigger container restart.
 */
pool.on('error', (err) => {
    console.error('Unexpected error on idle client', err);
    process.exit(-1);
});