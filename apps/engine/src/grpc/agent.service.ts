import * as grpc from '@grpc/grpc-js';
import { ServerUnaryCall, sendUnaryData } from '@grpc/grpc-js';
import { TaskRepository } from '../repositories/task.repository';
import { taskStatus } from '../db/task.entity';
import { pool } from '../db';

// These interfaces match the proto definitions
interface SubmitTaskRequest {
    workflow_name: string;
    input: Buffer;
}

interface SubmitTaskResponse {
    task_id: string;
}

interface GetTaskStatusRequest {
    task_id: string;
}

interface GetTaskStatusResponse {
    status: number; // TaskStatus enum
    output: Buffer;
    error: Buffer;
}

interface CancelTaskRequest {
    task_id: string;
}

interface CancelTaskResponse {
    success: boolean;
}

export class AgentServiceImpl {
    private taskRepo: TaskRepository;

    constructor() {
        this.taskRepo = new TaskRepository(pool);
    }

    async submitTask(
        call: ServerUnaryCall<SubmitTaskRequest, SubmitTaskResponse>,
        callback: sendUnaryData<SubmitTaskResponse>
    ) {
        try {
            const { workflow_name, input } = call.request;

            // Parse input from bytes to JSON
            const inputData = input ? JSON.parse(input.toString('utf-8')) : {};

            // Create task in database
            const task = await this.taskRepo.create(workflow_name, inputData);

            callback(null, { task_id: task.id });
        } catch (error) {
            console.error('[AgentService] submitTask error:', error);
            callback({
                code: grpc.status.INTERNAL,
                message: error instanceof Error ? error.message : 'Unknown error',
            });
        }
    }

    async getTaskStatus(
        call: ServerUnaryCall<GetTaskStatusRequest, GetTaskStatusResponse>,
        callback: sendUnaryData<GetTaskStatusResponse>
    ) {
        try {
            const { task_id } = call.request;

            const task = await this.taskRepo.findById(task_id);

            if (!task) {
                return callback({
                    code: grpc.status.NOT_FOUND,
                    message: `Task ${task_id} not found`,
                });
            }

            // Map database status to proto enum
            const statusMap: Record<string, number> = {
                'pending': 1,
                'running': 2,
                'completed': 3,
                'failed': 4,
                'cancelled': 5,
            };

            callback(null, {
                status: statusMap[task.status] || 0,
                output: task.output ? Buffer.from(JSON.stringify(task.output)) : Buffer.from(''),
                error: task.error ? Buffer.from(JSON.stringify(task.error)) : Buffer.from(''),
            });
        } catch (error) {
            console.error('[AgentService] getTaskStatus error:', error);
            callback({
                code: grpc.status.INTERNAL,
                message: error instanceof Error ? error.message : 'Unknown error',
            });
        }
    }

    async cancelTask(
        call: ServerUnaryCall<CancelTaskRequest, CancelTaskResponse>,
        callback: sendUnaryData<CancelTaskResponse>
    ) {
        try {
            const { task_id } = call.request;

            const task = await this.taskRepo.findById(task_id);

            if (!task) {
                return callback({
                    code: grpc.status.NOT_FOUND,
                    message: `Task ${task_id} not found`,
                });
            }

            // Only allow cancellation of pending or running tasks
            if (task.status !== 'pending' && task.status !== 'running') {
                return callback(null, { success: false });
            }

            await this.taskRepo.updateStatus(task_id, taskStatus.CANCELLED);

            callback(null, { success: true });
        } catch (error) {
            console.error('[AgentService] cancelTask error:', error);
            callback({
                code: grpc.status.INTERNAL,
                message: error instanceof Error ? error.message : 'Unknown error',
            });
        }
    }
}
