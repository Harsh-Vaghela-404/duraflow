import * as grpc from '@grpc/grpc-js';
import { ServerUnaryCall, sendUnaryData } from '@grpc/grpc-js';
import { TaskRepository } from '../repositories/task.repository';
import { StepRepository } from '../repositories/step.repository';
import { taskStatus } from '../db/task.entity';
import { pool } from '../db';

const STATUS_MAP: Record<string, number> = { pending: 1, running: 2, completed: 3, failed: 4, cancelled: 5 };

export class AgentServiceImpl {
    private taskRepo = new TaskRepository(pool);

    async submitTask(call: ServerUnaryCall<any, any>, callback: sendUnaryData<any>) {
        try {
            const { workflow_name, input } = call.request;

            if (!workflow_name || typeof workflow_name !== 'string' || workflow_name.trim() === '') {
                return callback({ code: grpc.status.INVALID_ARGUMENT, message: 'workflow_name is required' });
            }

            const task = await this.taskRepo.create(workflow_name, input ? JSON.parse(input.toString()) : {});
            callback(null, { task_id: task.id });
        } catch (err) {
            callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
    }

    async getTaskStatus(call: ServerUnaryCall<any, any>, callback: sendUnaryData<any>) {
        try {
            const { task_id } = call.request;

            if (!task_id || typeof task_id !== 'string') {
                return callback({ code: grpc.status.INVALID_ARGUMENT, message: 'task_id is required' });
            }

            const task = await this.taskRepo.findById(task_id);
            if (!task) return callback({ code: grpc.status.NOT_FOUND, message: 'Task not found' });

            callback(null, {
                status: STATUS_MAP[task.status] || 0,
                output: task.output ? Buffer.from(JSON.stringify(task.output)) : Buffer.from(''),
                error: task.error ? Buffer.from(JSON.stringify(task.error)) : Buffer.from('')
            });
        } catch (err) {
            callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
    }

    async cancelTask(call: ServerUnaryCall<any, any>, callback: sendUnaryData<any>) {
        try {
            const { task_id } = call.request;

            if (!task_id || typeof task_id !== 'string') {
                return callback({ code: grpc.status.INVALID_ARGUMENT, message: 'task_id is required' });
            }

            const task = await this.taskRepo.findById(task_id);
            if (!task) return callback({ code: grpc.status.NOT_FOUND, message: 'Task not found' });

            if (task.status !== 'pending' && task.status !== 'running') {
                return callback({
                    code: grpc.status.FAILED_PRECONDITION,
                    message: `Cannot cancel task with status: ${task.status}`
                });
            }

            await this.taskRepo.updateStatus(task_id, taskStatus.CANCELLED);
            callback(null, { success: true });
        } catch (err) {
            callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
    }
    async getStep(call: ServerUnaryCall<any, any>, callback: sendUnaryData<any>) {
        try {
            const { task_id, step_key } = call.request;
            if (!task_id || !step_key) {
                return callback({ code: grpc.status.INVALID_ARGUMENT, message: 'task_id and step_key are required' });
            }

            const stepRepo = new StepRepository(pool);
            const step = await stepRepo.findByTaskAndKey(task_id, step_key);

            callback(null, {
                found: !!step,
                completed: step?.status === 'completed',
                output: step?.output ? Buffer.from(JSON.stringify(step.output)) : undefined
            });
        } catch (err) {
            callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
    }

    async completeStep(call: ServerUnaryCall<any, any>, callback: sendUnaryData<any>) {
        try {
            const { task_id, step_key, output } = call.request;
            if (!task_id || !step_key) {
                return callback({ code: grpc.status.INVALID_ARGUMENT, message: 'task_id and step_key are required' });
            }

            const stepRepo = new StepRepository(pool);
            const step = await stepRepo.createOrFind(task_id, step_key, null);
            await stepRepo.updateCompleted(step.id, output ? JSON.parse(output.toString()) : null);

            callback(null, { success: true });
        } catch (err) {
            callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
    }

    async failStep(call: ServerUnaryCall<any, any>, callback: sendUnaryData<any>) {
        try {
            const { task_id, step_key, error } = call.request;
            if (!task_id || !step_key) {
                return callback({ code: grpc.status.INVALID_ARGUMENT, message: 'task_id and step_key are required' });
            }

            const stepRepo = new StepRepository(pool);
            const step = await stepRepo.createOrFind(task_id, step_key, null);
            await stepRepo.updateFailed(step.id, error ? JSON.parse(error.toString()) : 'Unknown error');

            callback(null, { success: true });
        } catch (err) {
            callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
    }
}
