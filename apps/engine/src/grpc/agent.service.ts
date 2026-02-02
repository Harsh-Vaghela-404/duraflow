import * as grpc from '@grpc/grpc-js';
import { ServerUnaryCall, sendUnaryData } from '@grpc/grpc-js';
import { TaskRepository } from '../repositories/task.repository';
import { taskStatus } from '../db/task.entity';
import { pool } from '../db';

const STATUS_MAP: Record<string, number> = { pending: 1, running: 2, completed: 3, failed: 4, cancelled: 5 };

export class AgentServiceImpl {
    private taskRepo = new TaskRepository(pool);

    async submitTask(call: ServerUnaryCall<any, any>, callback: sendUnaryData<any>) {
        try {
            const { workflow_name, input } = call.request;
            const task = await this.taskRepo.create(workflow_name, input ? JSON.parse(input.toString()) : {});
            callback(null, { task_id: task.id });
        } catch (err) {
            callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
    }

    async getTaskStatus(call: ServerUnaryCall<any, any>, callback: sendUnaryData<any>) {
        try {
            const task = await this.taskRepo.findById(call.request.task_id);
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
            const task = await this.taskRepo.findById(call.request.task_id);
            if (!task) return callback({ code: grpc.status.NOT_FOUND, message: 'Task not found' });
            if (task.status !== 'pending' && task.status !== 'running') return callback(null, { success: false });

            await this.taskRepo.updateStatus(call.request.task_id, taskStatus.CANCELLED);
            callback(null, { success: true });
        } catch (err) {
            callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
    }
}
