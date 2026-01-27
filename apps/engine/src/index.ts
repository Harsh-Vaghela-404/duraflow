import { pool, redis } from './db';
import { createGrpcServer, startGrpcServer } from './grpc/server';
import { TaskRepository } from './repositories/task.repository';
import { Poller } from './services/poller';
import { TaskEntity, taskStatus } from './db/task.entity';
import { v7 as uuid } from 'uuid';

const WORKER_ID = `worker-${uuid().slice(0, 8)}`;

let poller: Poller | null = null;

// TODO: replace with actual workflow execution in Week 3
async function handleTask(task: TaskEntity): Promise<void> {
    console.log(`[worker] processing task ${task.id} (${task.workflow_name})`);
    const taskRepo = new TaskRepository(pool);
    await taskRepo.updateStatus(task.id, taskStatus.COMPLETED);
    console.log(`[worker] completed task ${task.id}`);
}

async function main() {
    console.log('[duraflow] starting engine...');

    await pool.query('SELECT 1');
    console.log('[duraflow] postgres connected');

    await redis.ping();
    console.log('[duraflow] redis connected');

    const grpcServer = createGrpcServer();
    await startGrpcServer(grpcServer, 50051);

    const taskRepo = new TaskRepository(pool);
    poller = new Poller(taskRepo, WORKER_ID, handleTask);
    poller.start();

    console.log('[duraflow] engine ready');
}

async function shutdown(signal: string) {
    console.log(`[duraflow] ${signal} received, shutting down...`);
    if (poller) await poller.stop();
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