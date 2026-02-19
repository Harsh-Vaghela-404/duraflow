import { TaskEntity } from './db/task.entity';
import { WorkflowExecutor } from './services/workflow-executor';
import { HeartbeatService } from './services/heartbeat.service';

const TAG = '[engine]';

export async function runTask(
    executor: WorkflowExecutor,
    heartbeat: HeartbeatService,
    task: TaskEntity,
): Promise<void> {
    console.log(`${TAG} processing task ${task.id} (${task.workflow_name})`);
    heartbeat.start(task.id);

    try {
        await executor.execute(task);
        console.log(`${TAG} completed task ${task.id}`);
    } catch (err) {
        // executor.execute() already marked the task as failed — just log and re-throw
        console.error(`${TAG} task ${task.id} failed:`, err);
        throw err;
    } finally {
        heartbeat.stop(task.id);
    }
}
