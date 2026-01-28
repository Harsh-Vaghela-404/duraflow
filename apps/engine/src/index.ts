import { pool, redis } from './db';
import { createGrpcServer, startGrpcServer } from './grpc/server';
import { TaskRepository } from './repositories/task.repository';
import { Poller, HeartbeatService, Reaper } from './services';
import { TaskEntity, taskStatus } from './db/task.entity';
import { v7 as uuid } from 'uuid';

const WORKER_ID = `worker-${uuid().slice(0, 8)}`;

let poller: Poller | null = null;
let reaper: Reaper | null = null;

const taskRepo = new TaskRepository(pool);
const heartbeat = new HeartbeatService(taskRepo);

async function handleTask(task: TaskEntity): Promise<void> {
    console.log(`[worker] processing task ${task.id} (${task.workflow_name})`);
    heartbeat.start(task.id);

    try {
        // TODO: Week 3 - replace with actual workflow execution
        await taskRepo.updateStatus(task.id, taskStatus.COMPLETED);
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

    await pool.query('SELECT 1');
    console.log('[duraflow] postgres connected');

    await redis.ping();
    console.log('[duraflow] redis connected');

    const grpcServer = createGrpcServer();
    await startGrpcServer(grpcServer, 50051);

    reaper = new Reaper(pool);
    reaper.start();

    poller = new Poller(taskRepo, WORKER_ID, handleTask);
    poller.start();

    console.log('[duraflow] engine ready');
}

async function shutdown(signal: string) {
    console.log(`[duraflow] ${signal} received, shutting down...`);

    heartbeat.stop();
    if (poller) await poller.stop();
    if (reaper) reaper.stop();

    await pool.end();
    await redis.quit();
    console.log('[duraflow] shutdown complete');
    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((err) => {
    console.error('[duraflow] fatal:', err);
    process.exit(1);
});