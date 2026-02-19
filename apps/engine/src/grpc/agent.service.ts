import * as grpc from '@grpc/grpc-js';
import { ServerUnaryCall, sendUnaryData } from '@grpc/grpc-js';
import { Pool } from 'pg';
import { TaskRepository } from '../repositories/task.repository';
import { taskStatus } from '../db/task.entity';

const TAG = '[grpc]';

export class AgentServiceImpl {
    private taskRepo: TaskRepository;

    constructor(pool: Pool) {
        this.taskRepo = new TaskRepository(pool);
    }

    async submitTask(call: ServerUnaryCall<any, any>, callback: sendUnaryData<any>) {
        try {
            const { workflow_name, input } = call.request;

            if (!workflow_name || typeof workflow_name !== 'string' || workflow_name.trim() === '') {
                return callback({ code: grpc.status.INVALID_ARGUMENT, message: 'workflow_name is required' });
            }

            const task = await this.taskRepo.create(workflow_name, input ? JSON.parse(input.toString()) : {});
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
                return callback({ code: grpc.status.INVALID_ARGUMENT, message: 'task_id is required' });
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
                return callback({ code: grpc.status.INVALID_ARGUMENT, message: 'task_id is required' });
            }

            const task = await this.taskRepo.findById(task_id);
            if (!task) return callback({ code: grpc.status.NOT_FOUND, message: 'Task not found' });

            if (task.status !== taskStatus.PENDING && task.status !== taskStatus.RUNNING) {
                return callback({
                    code: grpc.status.FAILED_PRECONDITION,
                    message: `Cannot cancel task with status: ${task.status}`,
                });
            }

            await this.taskRepo.updateStatus(task_id, taskStatus.CANCELLED);
            callback(null, { success: true });
        } catch (err) {
            console.error(`${TAG} cancelTask error:`, err);
            callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
    }
}
