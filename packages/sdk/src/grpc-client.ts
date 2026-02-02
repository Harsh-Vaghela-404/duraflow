import * as grpc from '@grpc/grpc-js';
import { StepClient } from './step-runner';

type GrpcCallback<T> = (err: grpc.ServiceError | null, res: T) => void;

function rpc<T>(fn: (cb: GrpcCallback<T>) => void): Promise<T> {
    return new Promise((resolve, reject) => {
        fn((err, res) => err ? reject(err) : resolve(res));
    });
}

export function createGrpcStepClient(client: any): StepClient {
    return {
        getStepResult: (taskId, stepKey) =>
            rpc<any>(cb => client.getStepResult({ task_id: taskId, step_key: stepKey }, cb))
                .then(r => ({ found: r.found, status: r.status, output: r.output?.toString() || '' })),

        createStep: (taskId, stepKey) =>
            rpc<any>(cb => client.createStep({ task_id: taskId, step_key: stepKey }, cb))
                .then(r => ({ stepId: r.step_id })),

        saveStepResult: (taskId, stepKey, output) =>
            rpc<any>(cb => client.saveStepResult({ task_id: taskId, step_key: stepKey, output: Buffer.from(output) }, cb))
                .then(r => ({ stepId: r.step_id })),

        failStep: (taskId, stepKey, error) =>
            rpc<void>(cb => client.failStep({ task_id: taskId, step_key: stepKey, error }, cb))
    };
}
