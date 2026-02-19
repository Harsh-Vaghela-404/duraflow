import path from 'path';
import os from 'os';
import { MessageChannel } from 'worker_threads';
import { Pool } from 'pg';
import Piscina from 'piscina';
import { StepRepository } from '../repositories/step.repository';
import { TaskRepository } from '../repositories/task.repository';
import { TaskEntity } from '../db/task.entity';

const TAG = '[executor]';

interface IPCRequest {
  id: string;
  type: 'STEP_FIND' | 'STEP_CREATE_OR_FIND' | 'STEP_COMPLETE' | 'STEP_FAIL' | 'STEP_INCREMENT';
  payload: Record<string, unknown>;
}

interface IPCResponse {
  id: string;
  success: boolean;
  data?: unknown;
  error?: { message: string; name: string };
}

interface StepRetryPayload {
  __stepRetry: true;
  delay: number;
  attempt: number;
  originalError: unknown;
}

export function createPiscinaPool(): Piscina {
  const isTs = path.extname(__filename) === '.ts';
  const workerPath = path.resolve(__dirname, `../workers/workflow.worker${isTs ? '.ts' : '.js'}`);
  const cpuCount = os.cpus().length;

  const pool = new Piscina({
    filename: workerPath,
    execArgv: isTs ? ['--import', 'tsx'] : [],
    maxThreads: Math.max(2, cpuCount - 1),
    minThreads: 1,
    maxQueue: 10000,
    idleTimeout: 30000,
    env: { ...process.env, DURAFLOW_WORKFLOWS: process.env.DURAFLOW_WORKFLOWS ?? '' },
  });

  console.log(`${TAG} Piscina pool created: ${Math.max(2, cpuCount - 1)} threads`);
  return pool;
}

export class WorkflowExecutor {
  private stepRepo: StepRepository;
  private taskRepo: TaskRepository;
  private pool: Piscina;

  constructor(dbPool: Pool, piscinaPool: Piscina) {
    this.stepRepo = new StepRepository(dbPool);
    this.taskRepo = new TaskRepository(dbPool);
    this.pool = piscinaPool;
  }

  async execute(task: TaskEntity): Promise<unknown> {
    console.log(`${TAG} task ${task.id} submitted to worker pool`);

    const { port1, port2 } = new MessageChannel();

    port1.on('message', async (req: IPCRequest) => {
      const res = await this.handleWorkerMessage(req);
      port1.postMessage(res);
    });

    try {
      const result = await this.pool.run(
        { taskId: task.id, workflowName: task.workflow_name, input: task.input, port: port2 },
        { transferList: [port2] },
      );

      await this.taskRepo.updateCompleted(task.id, result);
      console.log(`${TAG} task ${task.id} completed`);
      return result;
    } catch (err: unknown) {
      if (this.isStepRetry(err)) {
        console.log(`${TAG} task ${task.id} retry scheduled in ${err.delay}ms (attempt ${err.attempt})`);
        await this.taskRepo.scheduleRetry(task.id, err.delay, err.attempt, err.originalError);
        return;
      }

      console.error(`${TAG} task ${task.id} failed:`, err);
      await this.taskRepo.fail(task.id, err);
      throw err;
    } finally {
      port1.removeAllListeners();
      port1.close();
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
