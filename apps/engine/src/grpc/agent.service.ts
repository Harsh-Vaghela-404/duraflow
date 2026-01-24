import * as grpc from '@grpc/grpc-js';
import { ServerUnaryCall, sendUnaryData } from '@grpc/grpc-js';
import { TaskRepository } from '../repositories/task.repository';
import { taskStatus } from '../db/task.entity';
import { pool } from '../db';

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
    status: number;
    output: Buffer;
    error: Buffer;
}

interface CancelTaskRequest {
    task_id: string;
}

interface CancelTaskResponse {
    success: boolean;
}

/**
 * gRPC service implementation for agent task management.
 * Handles task submission, status retrieval, and cancellation.
 */
export class AgentServiceImpl {
    private taskRepo: TaskRepository;

    constructor() {
        this.taskRepo = new TaskRepository(pool);
    }

    /**
     * Submits a new task to the queue.
     * Creates a task record in PENDING status and returns its UUID.
     * 
     * @param call gRPC call containing workflow_name and input bytes
     * @param callback Response callback with task_id or error
     * 
     * Input bytes are expected to be JSON-encoded.
     * Returns INTERNAL error if JSON parsing or database insertion fails.
     */
    async submitTask(
        call: ServerUnaryCall<SubmitTaskRequest, SubmitTaskResponse>,
        callback: sendUnaryData<SubmitTaskResponse>
    ) {
        try {
            const { workflow_name, input } = call.request;

            const inputData = input ? JSON.parse(input.toString('utf-8')) : {};

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

    /**
     * Retrieves current status and results of a task.
     * 
     * @param call gRPC call containing task_id
     * @param callback Response callback with status, output, and error
     * 
     * Returns NOT_FOUND if task doesn't exist.
     * Output and error are JSON-encoded as bytes (empty if not applicable).
     * Status is mapped from database enum to proto enum values.
     */
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

    /**
     * Attempts to cancel a task.
     * Only pending or running tasks can be cancelled.
     * 
     * @param call gRPC call containing task_id
     * @param callback Response callback with success boolean
     * 
     * Returns NOT_FOUND if task doesn't exist.
     * Returns success=false if task already completed/failed/cancelled.
     * Returns success=true if task was successfully cancelled.
     */
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
