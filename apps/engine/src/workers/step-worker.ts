import { MessagePort } from 'worker_threads';
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
import { loadWorkflows } from '../utils/load-workflows';
import { StepRetryError } from '../errors/step-retry.error';
import { RateLimitTimeoutError } from '../errors/rate-limit-timeout.error';
import { IPCClient } from './ipc-client';

const RATE_LIMIT_POLL_INTERVAL_MS = 100;
const RATE_LIMIT_DEFAULT_TIMEOUT_MS = 60_000;

const TAG = '[step-worker]';

// Load user workflows into this worker thread (registers handlers + compensations).
loadWorkflows();

interface WorkerTask {
  taskId: string;
  workflowName: string;
  input: unknown;
  port: MessagePort;
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
        console.log(`[step-worker] ${name} - cache hit`);
        return deserialize(JSON.stringify(existing.output)) as T;
      }

      const step = await ipc.send<{ id: string; attempt: number }>('STEP_CREATE_OR_FIND', { taskId, stepKey: name });
      const currentAttempt = step.attempt || 1;
      console.log(`[step-worker] ${name} - executing (attempt ${currentAttempt})`);

      if (opts?.rateLimit) {
        const { api, tokens = 1, timeoutMs = RATE_LIMIT_DEFAULT_TIMEOUT_MS } = opts.rateLimit;
        const deadline = Date.now() + timeoutMs;
        let acquired = false;

        while (Date.now() < deadline) {
          const allowed = await ipc.send<boolean>('RATE_LIMIT_ACQUIRE', { api, tokens });
          if (allowed) {
            console.log(`${TAG} ${name} - acquired rate limit token for API '${api}'`);
            acquired = true;
            break;
          }
          const remaining = deadline - Date.now();
          if (remaining <= RATE_LIMIT_POLL_INTERVAL_MS) break;
          await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_POLL_INTERVAL_MS));
        }

        if (!acquired) {
          throw new RateLimitTimeoutError(api, timeoutMs);
        }
      }

      // Compensations are registered at workflow module load under
      // `${workflowName}:${stepKey}`. If one exists for this step, record its
      // name on the step so the (main-thread) RollbackOrchestrator can resolve
      // and run it later.
      const compensationKey = `${workflowName}:${name}`;
      const hasCompensation = compensationRegistry.has(compensationKey);

      try {
        const result = await fn();
        await ipc.send('STEP_COMPLETE', {
          stepId: step.id,
          output: JSON.parse(serialize(result)),
          compensationFn: hasCompensation ? compensationKey : null,
        });
        return result;
      } catch (err) {
        const maxRetries = opts?.retries ?? 0;
        console.error(`[step-worker] ${name} failed (attempt ${currentAttempt}/${maxRetries + 1}):`, err);

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
