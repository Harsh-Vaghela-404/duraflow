import { pool, redis } from './db';
import { createGrpcServer, startGrpcServer } from './grpc/server';
import { TaskRepository } from './repositories/task.repository';
import { Poller, HeartbeatService, Reaper, WorkflowExecutor, EventLoopMonitor } from './services';
import { TaskEntity, taskStatus } from './db/task.entity';
import { v7 as uuid } from 'uuid';

const WORKER_ID = `worker-${uuid().slice(0, 8)}`;

let poller: Poller | null = null;
let reaper: Reaper | null = null;

const taskRepo = new TaskRepository(pool);
const heartbeat = new HeartbeatService(taskRepo);
const executor = new WorkflowExecutor(pool);

async function handleTask(task: TaskEntity): Promise<void> {
    console.log(`[worker] processing task ${task.id} (${task.workflow_name})`);
    heartbeat.start(task.id);

    try {
        await executor.execute(task);
        console.log(`[worker] completed task ${task.id}`);
    } catch (err) {
        console.error(`[worker] task ${task.id} failed:`, err);
        await taskRepo.updateStatus(task.id, taskStatus.FAILED);
        throw err;
    } finally {
        heartbeat.stop();
    }
}

async function main() {
    console.log('[duraflow] starting engine...');

    if (!process.env.DURAFLOW_WORKFLOWS) {
        console.warn('[duraflow] WARNING: DURAFLOW_WORKFLOWS is not set. Worker threads will not load any workflows.');
    }

    await pool.query('SELECT 1');
    console.log('[duraflow] postgres connected');

    await redis.ping();
    console.log('[duraflow] redis connected');

    const grpcServer = createGrpcServer();
    const port = parseInt(process.env.PORT || '50051', 10);
    await startGrpcServer(grpcServer, port);

    const reaperStale = parseInt(process.env.REAPER_STALE_THRESHOLD || '300', 10);
    const reaperInterval = parseInt(process.env.REAPER_INTERVAL || '10000', 10);
    reaper = new Reaper(pool, redis, reaperStale, reaperInterval);
    reaper.start();

    // Backpressure configuration
    const maxQueueSize = parseInt(process.env.MAX_QUEUE_SIZE || '1000', 10);
    const maxEventLoopLag = parseInt(process.env.MAX_EVENT_LOOP_LAG || '100', 10);
    const monitor = new EventLoopMonitor();

    const checkBackpressure = () => {
        const queueSize = executor.queueSize;
        const lag = monitor.lag;

        if (queueSize >= maxQueueSize) {
            console.warn(`[backpressure] Queue size ${queueSize} >= ${maxQueueSize}`);
            return true;
        }
        if (lag >= maxEventLoopLag) {
            console.warn(`[backpressure] Event loop lag ${lag.toFixed(2)}ms >= ${maxEventLoopLag}ms`);
            return true;
        }
        return false;
    };

    poller = new Poller(taskRepo, WORKER_ID, handleTask, 10, checkBackpressure);
    poller.start();

    console.log('[duraflow] engine ready');
}

async function shutdown(signal: string) {
    console.log(`[duraflow] ${signal} received, shutting down...`);

    heartbeat.stop();
    if (poller) await poller.stop();
    if (reaper) await reaper.stop();
    await executor.destroy();

    await pool.end();
    await redis.quit();
    console.log('[duraflow] shutdown complete');
    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGUSR2', () => shutdown('SIGUSR2'));

main().catch((err) => {
    console.error('[duraflow] fatal:', err);
    process.exit(1);
});