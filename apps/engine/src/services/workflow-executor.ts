import path from 'path';
import os from 'os';
import { MessageChannel } from 'worker_threads';
import { Pool } from 'pg';
import Piscina from 'piscina';
import { StepRepository } from '../repositories/step.repository';
import { TaskRepository } from '../repositories/task.repository';
import { RollbackOrchestrator } from './rollback-orchestrator';
import { RateLimiter } from './rate-limiter';
import { TaskEntity, taskStatus } from '../db/task.entity';
import type { IPCRequest, IPCResponse } from '../workers/ipc-client';
import { PISCINA_MAX_QUEUE, PISCINA_IDLE_TIMEOUT_MS } from '../constants/engine';

const TAG = '[workflow-executor]';

interface StepRetryPayload {
  __stepRetry: true;
  delay: number;
  attempt: number;
  originalError: unknown;
}

export function createPiscinaPool(): Piscina {
  const isTs = path.extname(__filename) === '.ts';
  const workerPath = path.resolve(__dirname, `../workers/step-worker${isTs ? '.ts' : '.js'}`);
  const cpuCount = os.cpus().length;

  const pool = new Piscina({
    filename: workerPath,
    execArgv: isTs ? ['--import', 'tsx'] : [],
    maxThreads: Math.max(2, cpuCount - 1),
    minThreads: 1,
    maxQueue: PISCINA_MAX_QUEUE,
    idleTimeout: PISCINA_IDLE_TIMEOUT_MS,
    env: { ...process.env, DURAFLOW_WORKFLOWS: process.env.DURAFLOW_WORKFLOWS ?? '' },
  });

  console.log(`${TAG} Piscina pool created: ${Math.max(2, cpuCount - 1)} threads`);
  return pool;
}

export class WorkflowExecutor {
  private stepRepo: StepRepository;
  private taskRepo: TaskRepository;
  private rollback: RollbackOrchestrator;
  private pool: Piscina;
  private rateLimiter: RateLimiter | undefined;
  private abortControllers = new Map<string, AbortController>();

  constructor(dbPool: Pool, piscinaPool: Piscina, rateLimiter?: RateLimiter) {
    this.stepRepo = new StepRepository(dbPool);
    this.taskRepo = new TaskRepository(dbPool);
    this.rollback = new RollbackOrchestrator(dbPool);
    this.pool = piscinaPool;
    this.rateLimiter = rateLimiter;
  }

  async execute(task: TaskEntity): Promise<unknown> {
    console.log(`${TAG} task ${task.id} submitted to worker pool`);

    const controller = new AbortController();
    this.abortControllers.set(task.id, controller);

    const { port1, port2 } = new MessageChannel();

    port1.on('message', async (req: IPCRequest) => {
      const res = await this.handleWorkerMessage(req);
      port1.postMessage(res);
    });

    try {
      const result = await this.pool.run(
        { taskId: task.id, workflowName: task.workflow_name, input: task.input, port: port2 },
        { transferList: [port2], signal: controller.signal },
      );

      // Guard against a cancel that arrived after the worker finished but before
      // we could abort it. One cheap SELECT prevents updateCompleted from clobbering
      // the cancelled status and leaving compensatable steps un-rolled-back.
      const freshTask = await this.taskRepo.findById(task.id);
      if (freshTask?.status === taskStatus.CANCELLED) {
        console.log(`${TAG} task ${task.id} cancel landed after worker finished — triggering rollback`);
        try {
          await this.rollback.rollback(task.id);
        } catch (rollbackErr) {
          console.error(`${TAG} post-cancel rollback failed for task ${task.id}:`, rollbackErr);
        }
        return;
      }

      await this.taskRepo.updateCompleted(task.id, result);
      console.log(`${TAG} task ${task.id} completed`);
      return result;
    } catch (err: unknown) {
      if (this.isStepRetry(err)) {
        console.log(`${TAG} task ${task.id} retry scheduled in ${err.delay}ms (attempt ${err.attempt})`);
        await this.taskRepo.scheduleRetry(task.id, err.delay, err.attempt, err.originalError);
        return;
      }

      if (this.isAbortError(err)) {
        console.log(`${TAG} task ${task.id} aborted by cancel signal — triggering rollback`);
        try {
          await this.rollback.rollback(task.id);
        } catch (rollbackErr) {
          console.error(`${TAG} post-abort rollback failed for task ${task.id}:`, rollbackErr);
        }
        return;
      }

      console.error(`${TAG} task ${task.id} failed:`, err);
      await this.taskRepo.fail(task.id, err);
      // Await the rollback so a process restart mid-rollback doesn't leave the
      // task in `failed` with completed steps that never had their compensations
      // run. The rollback's own try/catch routes failures to DLQ — it should not
      // throw — but we guard defensively in case of an unexpected error.
      try {
        await this.rollback.rollback(task.id);
      } catch (rollbackErr) {
        console.error(`${TAG} rollback failed for task ${task.id}:`, rollbackErr);
      }
      throw err;
    } finally {
      this.abortControllers.delete(task.id);
      port1.removeAllListeners();
      port1.close();
    }
  }

  cancel(taskId: string): void {
    const controller = this.abortControllers.get(taskId);
    if (controller) {
      controller.abort();
      console.log(`${TAG} abort signal sent for task ${taskId}`);
    } else {
      console.warn(`${TAG} cancel called for task ${taskId} but no active execution found`);
    }
  }

  get queueSize(): number {
    return this.pool.queueSize;
  }

  async destroy(): Promise<void> {
    await this.pool.destroy();
    console.log(`${TAG} pool destroyed`);
  }

  private isStepRetry(err: unknown): err is StepRetryPayload {
    return typeof err === 'object' && err !== null && '__stepRetry' in err;
  }

  private isAbortError(err: unknown): boolean {
    if (typeof err !== 'object' || err === null) return false;
    const e = err as { name?: string; code?: string };
    return e.name === 'AbortError' || e.code === 'ABORT_ERR';
  }

  private async handleWorkerMessage(request: IPCRequest): Promise<IPCResponse> {
    try {
      switch (request.type) {
        case 'STEP_FIND': {
          const { taskId, stepKey } = request.payload as { taskId: string; stepKey: string };
          const step = await this.stepRepo.findByTaskAndKey(taskId, stepKey);
          return { id: request.id, success: true, data: step };
        }
        case 'STEP_CREATE_OR_FIND': {
          const { taskId, stepKey } = request.payload as { taskId: string; stepKey: string };
          const step = await this.stepRepo.createOrFind(taskId, stepKey, null);
          return { id: request.id, success: true, data: step };
        }
        case 'STEP_COMPLETE': {
          const { stepId, output } = request.payload as { stepId: string; output: unknown };
          await this.stepRepo.updateCompleted(stepId, output);
          return { id: request.id, success: true };
        }
        case 'STEP_FAIL': {
          const { stepId, error } = request.payload as { stepId: string; error: unknown };
          await this.stepRepo.updateFailed(stepId, error);
          return { id: request.id, success: true };
        }
        case 'STEP_INCREMENT': {
          const { stepId } = request.payload as { stepId: string };
          await this.stepRepo.incrementAttempt(stepId);
          return { id: request.id, success: true };
        }
        case 'RATE_LIMIT_ACQUIRE': {
          if (!this.rateLimiter) {
            return { id: request.id, success: true, data: true };
          }
          const { api, tokens } = request.payload as { api: string; tokens: number };
          try {
            const allowed = await this.rateLimiter.acquire(api, tokens);
            return { id: request.id, success: true, data: Boolean(allowed) };
          } catch (rlErr) {
            console.warn(`${TAG} rate limiter error for API '${api}', allowing through:`, rlErr);
            return { id: request.id, success: true, data: true };
          }
        }
        default:
          return { id: request.id, success: false, error: { message: 'Unknown IPC message type', name: 'Error' } };
      }
    } catch (err) {
      const error = err instanceof Error
        ? { message: err.message, name: err.name }
        : { message: String(err), name: 'Error' };
      return { id: request.id, success: false, error };
    }
  }
}
