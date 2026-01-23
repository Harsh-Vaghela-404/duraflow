// duraflow engine entry point
// boots the orchestrator, queue poller, and grpc server

import { Pool } from 'pg';
import Redis from 'ioredis';
import { TaskRepository } from './repositories/task.repository';
import { pool } from './db';

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

async function main() {
    console.log('[duraflow] starting engine...');

    // verify connections
    await pool.query('SELECT 1');
    const taskRepo = new TaskRepository(pool);
    console.log('[duraflow] postgres connected');

    await redis.ping();
    console.log('[duraflow] redis connected');

    // grpc server goes here
    // poller loop goes here

    console.log('[duraflow] engine ready');
}

main().catch((err) => {
    console.error('[duraflow] fatal:', err);
    process.exit(1);
});
