import * as grpc from '@grpc/grpc-js';
import { ServerUnaryCall, sendUnaryData } from '@grpc/grpc-js';
import { Pool } from 'pg';
import { TaskRepository } from '../repositories/task.repository';
import { StepRepository } from '../repositories/step.repository';
import { WorkflowExecutor } from '../services/workflow-executor';
import { RateLimiter } from '../services/rate-limiter';
import { getApiRateLimitConfig } from '../constants/rate-limits';
import { taskStatus } from '../db/task.entity';

const TAG = '[agent-service]';

export class AgentServiceImpl {
    private taskRepo: TaskRepository;
    private stepRepo: StepRepository;
    private executor: WorkflowExecutor;
    private rateLimiter?: RateLimiter;

    constructor(pool: Pool, executor: WorkflowExecutor, rateLimiter?: RateLimiter) {
        this.taskRepo = new TaskRepository(pool);
        this.stepRepo = new StepRepository(pool);
        this.executor = executor;
        this.rateLimiter = rateLimiter;
    }

    async submitTask(call: ServerUnaryCall<any, any>, callback: sendUnaryData<any>) {
        try {
            const { workflow_name, input } = call.request;

            if (
                !workflow_name ||
                typeof workflow_name !== 'string' ||
                workflow_name.trim() === ''
            ) {
                return callback({
                    code: grpc.status.INVALID_ARGUMENT,
                    message: 'workflow_name is required',
                });
            }

            const runtime = call.request.runtime || 'node';
            if (runtime !== 'node' && runtime !== 'python') {
                return callback({
                    code: grpc.status.INVALID_ARGUMENT,
                    message: "runtime must be 'node' or 'python'",
                });
            }

            let parsedInput: Record<string, unknown> = {};
            if (input) {
                try {
                    parsedInput = JSON.parse(input.toString());
                } catch {
                    return callback({
                        code: grpc.status.INVALID_ARGUMENT,
                        message: 'input must be valid JSON',
                    });
                }
            }

            const task = await this.taskRepo.create(workflow_name, parsedInput, runtime);
            callback(null, { task_id: task.id });
        } catch (err) {
            console.error(`${TAG} submitTask error:`, err);
            callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
    }

    async getTaskStatus(call: ServerUnaryCall<any, any>, callback: sendUnaryData<any>) {
        try {
            const { task_id } = call.request;

            if (!task_id || typeof task_id !== 'string') {
                return callback({
                    code: grpc.status.INVALID_ARGUMENT,
                    message: 'task_id is required',
                });
            }

            const task = await this.taskRepo.findById(task_id);
            if (!task) return callback({ code: grpc.status.NOT_FOUND, message: 'Task not found' });

            callback(null, {
                status: task.status.toUpperCase(),
                output: task.output ? Buffer.from(JSON.stringify(task.output)) : Buffer.from(''),
                error: task.error ? Buffer.from(JSON.stringify(task.error)) : Buffer.from(''),
            });
        } catch (err) {
            console.error(`${TAG} getTaskStatus error:`, err);
            callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
    }

    async cancelTask(call: ServerUnaryCall<any, any>, callback: sendUnaryData<any>) {
        try {
            const { task_id } = call.request;

            if (!task_id || typeof task_id !== 'string') {
                return callback({
                    code: grpc.status.INVALID_ARGUMENT,
                    message: 'task_id is required',
                });
            }

            const task = await this.taskRepo.findById(task_id);
            if (!task) return callback({ code: grpc.status.NOT_FOUND, message: 'Task not found' });

            if (task.status !== taskStatus.PENDING && task.status !== taskStatus.RUNNING) {
                return callback({
                    code: grpc.status.FAILED_PRECONDITION,
                    message: `Cannot cancel task with status: ${task.status}`,
                });
            }

            const wasRunning = task.status === taskStatus.RUNNING;
            await this.taskRepo.updateStatus(task_id, taskStatus.CANCELLED);
            callback(null, { success: true });

            if (wasRunning) {
                // Signal the executor to abort the in-flight Piscina run.
                // WorkflowExecutor.execute() catches the AbortError and triggers
                // rollback from there - keeping rollback ownership in one place.
                this.executor.cancel(task_id);
            }
        } catch (err) {
            console.error(`${TAG} cancelTask error:`, err);
            callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
    }

    async getStep(call: ServerUnaryCall<any, any>, callback: sendUnaryData<any>) {
        try {
            const { task_id, step_key } = call.request;

            if (!task_id || typeof task_id !== 'string') {
                return callback({
                    code: grpc.status.INVALID_ARGUMENT,
                    message: 'task_id is required',
                });
            }
            if (!step_key || typeof step_key !== 'string') {
                return callback({
                    code: grpc.status.INVALID_ARGUMENT,
                    message: 'step_key is required',
                });
            }

            const step = await this.stepRepo.findByTaskAndKey(task_id, step_key);
            if (!step) {
                return callback(null, { found: false, completed: false, output: Buffer.from('') });
            }

            callback(null, {
                found: true,
                completed: step.status === 'completed',
                output: step.output ? Buffer.from(JSON.stringify(step.output)) : Buffer.from(''),
            });
        } catch (err) {
            console.error(`${TAG} getStep error:`, err);
            callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
    }

    async completeStep(call: ServerUnaryCall<any, any>, callback: sendUnaryData<any>) {
        try {
            const { task_id, step_key, output } = call.request;

            if (!task_id || typeof task_id !== 'string') {
                return callback({
                    code: grpc.status.INVALID_ARGUMENT,
                    message: 'task_id is required',
                });
            }
            if (!step_key || typeof step_key !== 'string') {
                return callback({
                    code: grpc.status.INVALID_ARGUMENT,
                    message: 'step_key is required',
                });
            }

            const step = await this.stepRepo.findByTaskAndKey(task_id, step_key);
            if (!step) {
                return callback({
                    code: grpc.status.NOT_FOUND,
                    message: `Step '${step_key}' not found`,
                });
            }

            let parsed: unknown = null;
            if (output) {
                try {
                    parsed = JSON.parse(output.toString());
                } catch {
                    return callback({
                        code: grpc.status.INVALID_ARGUMENT,
                        message: 'output must be valid JSON',
                    });
                }
            }
            await this.stepRepo.updateCompleted(step.id, parsed);
            callback(null, { success: true });
        } catch (err) {
            console.error(`${TAG} completeStep error:`, err);
            callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
    }

    async failStep(call: ServerUnaryCall<any, any>, callback: sendUnaryData<any>) {
        try {
            const { task_id, step_key, error } = call.request;

            if (!task_id || typeof task_id !== 'string') {
                return callback({
                    code: grpc.status.INVALID_ARGUMENT,
                    message: 'task_id is required',
                });
            }
            if (!step_key || typeof step_key !== 'string') {
                return callback({
                    code: grpc.status.INVALID_ARGUMENT,
                    message: 'step_key is required',
                });
            }

            const step = await this.stepRepo.findByTaskAndKey(task_id, step_key);
            if (!step) {
                return callback({
                    code: grpc.status.NOT_FOUND,
                    message: `Step '${step_key}' not found`,
                });
            }

            let parsed: unknown = { message: 'Unknown error' };
            if (error) {
                try {
                    parsed = JSON.parse(error.toString());
                } catch {
                    return callback({
                        code: grpc.status.INVALID_ARGUMENT,
                        message: 'error must be valid JSON',
                    });
                }
            }
            await this.stepRepo.updateFailed(step.id, parsed);
            callback(null, { success: true });
        } catch (err) {
            console.error(`${TAG} failStep error:`, err);
            callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
    }

    async dequeueTask(call: ServerUnaryCall<any, any>, callback: sendUnaryData<any>) {
        try {
            const { runtime, batch_size, worker_id } = call.request;
            if (runtime !== 'node' && runtime !== 'python') {
                return callback({
                    code: grpc.status.INVALID_ARGUMENT,
                    message: "runtime must be 'node' or 'python'",
                });
            }
            if (!worker_id || typeof worker_id !== 'string') {
                return callback({
                    code: grpc.status.INVALID_ARGUMENT,
                    message: 'worker_id is required',
                });
            }
            const size = Number(batch_size) > 0 ? Number(batch_size) : 10;
            const tasks = await this.taskRepo.dequeue(size, worker_id, runtime);
            callback(null, {
                tasks: tasks.map((t) => ({
                    task_id: t.id,
                    workflow_name: t.workflow_name,
                    input: Buffer.from(JSON.stringify(t.input ?? {})),
                })),
            });
        } catch (err) {
            console.error(`${TAG} dequeueTask error:`, err);
            callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
    }

    async heartbeat(call: ServerUnaryCall<any, any>, callback: sendUnaryData<any>) {
        try {
            const { task_id } = call.request;
            if (!task_id || typeof task_id !== 'string') {
                return callback({
                    code: grpc.status.INVALID_ARGUMENT,
                    message: 'task_id is required',
                });
            }
            const task = await this.taskRepo.findById(task_id);
            if (!task) return callback({ code: grpc.status.NOT_FOUND, message: 'Task not found' });
            await this.taskRepo.updateHeartbeat(task_id);
            callback(null, { ok: true });
        } catch (err) {
            console.error(`${TAG} heartbeat error:`, err);
            callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
    }

    async completeTask(call: ServerUnaryCall<any, any>, callback: sendUnaryData<any>) {
        try {
            const { task_id, output } = call.request;
            if (!task_id || typeof task_id !== 'string') {
                return callback({
                    code: grpc.status.INVALID_ARGUMENT,
                    message: 'task_id is required',
                });
            }
            let parsed: unknown = null;
            if (output && output.length > 0) {
                try {
                    parsed = JSON.parse(output.toString());
                } catch {
                    return callback({
                        code: grpc.status.INVALID_ARGUMENT,
                        message: 'output must be valid JSON',
                    });
                }
            }
            const task = await this.taskRepo.findById(task_id);
            if (!task) return callback({ code: grpc.status.NOT_FOUND, message: 'Task not found' });
            const ok = await this.taskRepo.completeRunning(task_id, parsed);
            if (!ok) {
                return callback({
                    code: grpc.status.FAILED_PRECONDITION,
                    message: `Task is not running (status: ${task.status})`,
                });
            }
            callback(null, { success: true });
        } catch (err) {
            console.error(`${TAG} completeTask error:`, err);
            callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
    }

    async failTask(call: ServerUnaryCall<any, any>, callback: sendUnaryData<any>) {
        try {
            const { task_id, error } = call.request;
            if (!task_id || typeof task_id !== 'string') {
                return callback({
                    code: grpc.status.INVALID_ARGUMENT,
                    message: 'task_id is required',
                });
            }
            let parsed: unknown = { message: 'Unknown error' };
            if (error && error.length > 0) {
                try {
                    parsed = JSON.parse(error.toString());
                } catch {
                    return callback({
                        code: grpc.status.INVALID_ARGUMENT,
                        message: 'error must be valid JSON',
                    });
                }
            }
            const task = await this.taskRepo.findById(task_id);
            if (!task) return callback({ code: grpc.status.NOT_FOUND, message: 'Task not found' });
            const ok = await this.taskRepo.failRunning(task_id, parsed);
            if (!ok) {
                return callback({
                    code: grpc.status.FAILED_PRECONDITION,
                    message: `Task is not running (status: ${task.status})`,
                });
            }
            callback(null, { success: true });
        } catch (err) {
            console.error(`${TAG} failTask error:`, err);
            callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
    }

    async getRateLimitStatus(call: ServerUnaryCall<any, any>, callback: sendUnaryData<any>) {
        try {
            const { api_name } = call.request;

            if (!api_name || typeof api_name !== 'string' || api_name.trim() === '') {
                return callback({
                    code: grpc.status.INVALID_ARGUMENT,
                    message: 'api_name is required',
                });
            }

            if (!this.rateLimiter) {
                return callback({
                    code: grpc.status.FAILED_PRECONDITION,
                    message: 'rate limiting is not enabled',
                });
            }

            const config = getApiRateLimitConfig(api_name.trim());
            const remaining = await this.rateLimiter.getRemaining(api_name.trim());

            callback(null, {
                api_name: config.name,
                remaining_tokens: remaining,
                capacity: config.capacity,
                rate_per_minute: config.rpm,
                ttl_seconds: config.ttlSeconds,
            });
        } catch (err) {
            console.error(`${TAG} getRateLimitStatus error:`, err);
            callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
    }

    async resetRateLimit(call: ServerUnaryCall<any, any>, callback: sendUnaryData<any>) {
        try {
            const { api_name } = call.request;

            if (!api_name || typeof api_name !== 'string' || api_name.trim() === '') {
                return callback({
                    code: grpc.status.INVALID_ARGUMENT,
                    message: 'api_name is required',
                });
            }

            if (!this.rateLimiter) {
                return callback({
                    code: grpc.status.FAILED_PRECONDITION,
                    message: 'rate limiting is not enabled',
                });
            }

            await this.rateLimiter.reset(api_name.trim());
            console.log(`${TAG} rate limit reset for API '${api_name.trim()}'`);
            callback(null, { success: true });
        } catch (err) {
            console.error(`${TAG} resetRateLimit error:`, err);
            callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
    }
}
