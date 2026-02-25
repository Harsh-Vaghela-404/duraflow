import { parentPort, MessagePort } from 'worker_threads';
import { randomUUID } from 'crypto';
import path from 'path';
import {
  globalRegistry,
  compensationRegistry,
  WorkflowContext,
  StepRunner,
  StepOptions,
  serialize,
  deserialize,
} from '@duraflow/sdk';
import { calculateBackOff } from '../utils/backoff';
import { StepRetryError } from '../errors/step-retry.error';

const TAG = '[worker]';
const TIMEOUT_MS = 30_000;

// Load user workflows
const workflowPaths = process.env.DURAFLOW_WORKFLOWS?.split(',').filter(Boolean) || [];
if (workflowPaths.length === 0) {
  console.log(`${TAG} No DURAFLOW_WORKFLOWS set, running without user workflows`);
} else {
  for (const p of workflowPaths) {
    try {
      const trimmed = p.trim();
      // Resolve path relative to process.cwd() not the worker file location
      const resolved = path.isAbsolute(trimmed) ? trimmed : path.resolve(process.cwd(), trimmed);
      // eslint-disable-next-line
      require(resolved);
      console.log(`${TAG} Loaded workflows from: ${resolved}`);
    } catch (err) {
      console.error(`${TAG} Failed to load workflow: ${p}`, err);
    }
  }
}

type IPCMessageType =
  | 'STEP_FIND'
  | 'STEP_CREATE_OR_FIND'
  | 'STEP_COMPLETE'
  | 'STEP_FAIL'
  | 'STEP_INCREMENT';

interface IPCRequest {
  id: string;
  type: IPCMessageType;
  payload: Record<string, unknown>;
}

interface IPCResponse {
  id: string;
  success: boolean;
  data?: unknown;
  error?: { message: string; name: string };
}

interface WorkerTask {
  taskId: string;
  workflowName: string;
  input: unknown;
  port: MessagePort;
}

class IPCClient {
  private pending = new Map<
    string,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();

  constructor(private port: MessagePort) {
    this.port.on('message', (msg: IPCResponse) => this.handleResponse(msg));
  }

  private handleResponse(msg: IPCResponse): void {
    const pending = this.pending.get(msg.id);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pending.delete(msg.id);
      if (msg.success) {
        pending.resolve(msg.data);
      } else {
        const err = new Error(msg.error?.message || 'IPC error');
        err.name = msg.error?.name || 'Error';
        pending.reject(err);
      }
    }
  }

  send<T>(type: IPCMessageType, payload: Record<string, unknown>): Promise<T> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`IPC ${type} timed out after ${TIMEOUT_MS}ms`));
      }, TIMEOUT_MS);

      // F3 FIX: Unref the timeout so it doesn't hold the process open
      timeout.unref();

      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timeout,
      });
      this.port.postMessage({ id, type, payload } as IPCRequest);
    });
  }

  close(): void {
    this.port.close();
    for (const [, { timeout, reject }] of this.pending) {
      clearTimeout(timeout);
      reject(new Error('IPC client closed'));
    }
    this.pending.clear();
  }
}

function createStepRunner(taskId: string, workflowName: string, ipc: IPCClient): StepRunner {
  return {
    async run<T>(
      name: string,
      fn: () => Promise<T>,
      opts?: StepOptions<T>,
    ): Promise<T> {
      const existing = await ipc.send<{ status: string; output: unknown } | null>('STEP_FIND', { taskId, stepKey: name });
      if (existing?.status === 'completed') {
        console.log(`[worker:step] ${name} - cache hit`);
        return deserialize(JSON.stringify(existing.output)) as T;
      }

      const step = await ipc.send<{ id: string; attempt: number }>('STEP_CREATE_OR_FIND', { taskId, stepKey: name });
      const currentAttempt = step.attempt || 1;
      console.log(`[worker:step] ${name} - executing (attempt ${currentAttempt})`);

      let compensationKey: string | undefined;
      if (opts?.compensation) {
        compensationKey = `${workflowName}:${name}`;
        compensationRegistry.register(compensationKey, opts.compensation as (output: unknown) => Promise<void>);
      }

      try {
        const result = await fn();
        await ipc.send('STEP_COMPLETE', {
          stepId: step.id,
          output: JSON.parse(serialize(result)),
          compensationFn: compensationKey ?? null,
        });
        return result;
      } catch (err) {
        const maxRetries = opts?.retries ?? 0;
        console.error(`[worker:step] ${name} failed (attempt ${currentAttempt}/${maxRetries + 1}):`, err);

        if (currentAttempt <= maxRetries) {
          const delay = calculateBackOff(currentAttempt);
          await ipc.send('STEP_INCREMENT', { stepId: step.id });
          throw new StepRetryError(delay, currentAttempt + 1, err);
        }

        const errorObj = err instanceof Error
          ? { message: err.message, name: err.name, stack: err.stack }
          : { message: String(err) };
        await ipc.send('STEP_FAIL', { stepId: step.id, error: errorObj });
        throw err;
      }
    },
  };
}

module.exports = async function executeWorkflow(task: WorkerTask) {
  const { taskId, workflowName, input, port } = task;
  const ipc = new IPCClient(port);

  try {
    const workflow = globalRegistry.get(workflowName);
    if (!workflow) {
      const registered = globalRegistry.list();
      throw new Error(`Workflow "${workflowName}" not found. Registered: [${registered.join(', ')}]`);
    }

    const stepRunner = createStepRunner(taskId, workflowName, ipc);
    const ctx: WorkflowContext = {
      runId: taskId,
      workflowName,
      input,
      step: stepRunner,
    };

    return await workflow.handler(ctx);
  } catch (err) {
    if (err instanceof StepRetryError) {
      const original = err.originalError instanceof Error
        ? { message: err.originalError.message, name: err.originalError.name }
        : { message: String(err.originalError) };

      throw {
        __stepRetry: true,
        delay: err.delay,
        attempt: err.attempt,
        originalError: original,
      };
    }
    throw err;
  } finally {
    ipc.close();
  }
};
