import 'dotenv/config';
import { createPool, createRedis } from './db';
import { createGrpcServer, startGrpcServer } from './grpc/server';
import { TaskRepository } from './repositories/task.repository';
import { RateLimiter } from './services/rate-limiter';
import {
    Poller,
    HeartbeatService,
    Reaper,
    WorkflowExecutor,
    EventLoopMonitor,
    createPiscinaPool,
} from './services';
import { v7 as uuid } from 'uuid';
import { runTask } from './task-runner';

const TAG = '[duraflow]';

// Central Configuration
const config = {
    port: parseInt(process.env.PORT || '50051', 10),
    reaperStale: parseInt(process.env.REAPER_STALE_THRESHOLD || '30', 10),
    reaperInterval: parseInt(process.env.REAPER_INTERVAL || '10000', 10),
    maxQueueSize: parseInt(process.env.MAX_QUEUE_SIZE || '1000', 10),
    maxEventLoopLag: parseInt(process.env.MAX_EVENT_LOOP_LAG || '100', 10),
    workerId: `worker-${uuid().slice(0, 8)}`,
    rateLimitCapacity: parseInt(process.env.RATE_LIMIT_CAPACITY ?? '80', 10),
    rateLimitRpm: parseInt(process.env.RATE_LIMIT_RPM ?? '500', 10),
    rateLimitTtl: parseInt(process.env.RATE_LIMIT_TTL_SECONDS ?? '300', 10),
};

// Wiring
const pool = createPool();
const redis = createRedis();
const piscina = createPiscinaPool();

pool.on('error', (err) => console.error(`${TAG} idle client error:`, err));

const taskRepo = new TaskRepository(pool);
const heartbeat = new HeartbeatService(taskRepo);

// Components
let poller: Poller | null = null;
let reaper: Reaper | null = null;
let executor: WorkflowExecutor | null = null;

async function main() {
    console.log(`${TAG} starting engine... (worker: ${config.workerId})`);

    if (!process.env.DURAFLOW_WORKFLOWS) {
        console.warn(
            `${TAG} WARNING: DURAFLOW_WORKFLOWS is not set. Worker threads will not load any workflows.`,
        );
    }

    // Health checks
    await pool.query('SELECT 1');
    console.log(`${TAG} postgres connected`);

    await redis.ping();
    console.log(`${TAG} redis connected`);

    const rateLimiter = new RateLimiter(redis, {
        capacity: config.rateLimitCapacity,
        ratePerMinute: config.rateLimitRpm,
        ttlSeconds: config.rateLimitTtl,
    });
    await rateLimiter.init();
    console.log(`${TAG} rate limiter ready`);

    executor = new WorkflowExecutor(pool, piscina, rateLimiter);

    // gRPC
    const grpcServer = createGrpcServer(pool, redis, executor, rateLimiter);
    await startGrpcServer(grpcServer, config.port);

    // Reaper
    reaper = new Reaper(pool, redis, config.reaperStale, config.reaperInterval);
    await reaper.start(); // Fixed: Added await

    // Backpressure
    const monitor = new EventLoopMonitor();
    const checkBackpressure = () => {
        const queueSize = executor!.queueSize;
        const lag = monitor.lag;

        if (queueSize >= config.maxQueueSize) {
            console.warn(`${TAG} [backpressure] Queue size ${queueSize} >= ${config.maxQueueSize}`);
            return true;
        }
        if (lag >= config.maxEventLoopLag) {
            console.warn(
                `${TAG} [backpressure] Event loop lag ${lag.toFixed(2)}ms >= ${config.maxEventLoopLag}ms`,
            );
            return true;
        }
        return false;
    };

    // Poller
    poller = new Poller(taskRepo, {
        workerId: config.workerId,
        batchSize: 10,
        checkBackpressure,
        onTaskReceived: (task) => runTask(executor!, heartbeat, task),
    });
    poller.start();

    console.log(`${TAG} engine ready`);
}

async function shutdown(signal: string) {
    console.log(`${TAG} ${signal} received, shutting down...`);

    heartbeat.stopAll();
    if (poller) await poller.stop();
    if (reaper) await reaper.stop();
    if (executor) await executor.destroy();

    await pool.end();
    await redis.quit();
    console.log(`${TAG} shutdown complete`);
    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGUSR2', () => shutdown('SIGUSR2'));

main().catch((err) => {
    console.error(`${TAG} fatal:`, err);
    process.exit(1);
});
