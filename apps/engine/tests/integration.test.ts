import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';
import { pool } from '../src/db';

const AGENT_PROTO_PATH = path.join(__dirname, '../../../packages/proto/agent.service.proto');

const packageDefinition = protoLoader.loadSync(AGENT_PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
});

const agentProto = grpc.loadPackageDefinition(packageDefinition) as any;

describe('End-to-End Integration Test', () => {
    let client: any;

    beforeAll(() => {
        client = new agentProto.duraflow.AgentService(
            'localhost:50051',
            grpc.credentials.createInsecure()
        );
    });

    afterAll(async () => {
        client.close();

        await pool.end();
    });

    it('should submit a task, store it in database, and retrieve status', async () => {
        const submitRequest = {
            workflow_name: 'test-integration-workflow',
            input: Buffer.from(JSON.stringify({ test: 'data', timestamp: Date.now() })),
        };

        const submitResponse: any = await new Promise((resolve, reject) => {
            client.submitTask(submitRequest, (err: any, response: any) => {
                if (err) reject(err);
                else resolve(response);
            });
        });

        expect(submitResponse.task_id).toBeDefined();
        expect(typeof submitResponse.task_id).toBe('string');

        const taskId = submitResponse.task_id;

        const dbResult = await pool.query(
            'SELECT id, workflow_name, status, input FROM agent_tasks WHERE id = $1',
            [taskId]
        );

        expect(dbResult.rows.length).toBe(1);
        expect(dbResult.rows[0].workflow_name).toBe('test-integration-workflow');
        expect(dbResult.rows[0].status).toBe('pending');
        expect(dbResult.rows[0].input).toHaveProperty('test', 'data');

        const statusRequest = { task_id: taskId };

        const statusResponse: any = await new Promise((resolve, reject) => {
            client.getTaskStatus(statusRequest, (err: any, response: any) => {
                if (err) reject(err);
                else resolve(response);
            });
        });

        expect(statusResponse.status).toBe('PENDING');
        expect(statusResponse.output).toBeDefined();
        expect(statusResponse.error).toBeDefined();

        const cancelRequest = { task_id: taskId };

        const cancelResponse: any = await new Promise((resolve, reject) => {
            client.cancelTask(cancelRequest, (err: any, response: any) => {
                if (err) reject(err);
                else resolve(response);
            });
        });

        expect(cancelResponse.success).toBe(true);

        const cancelledDbResult = await pool.query(
            'SELECT status FROM agent_tasks WHERE id = $1',
            [taskId]
        );

        expect(cancelledDbResult.rows[0].status).toBe('cancelled');
    });

    it('should return NOT_FOUND for non-existent task', async () => {
        const fakeTaskId = '00000000-0000-0000-0000-000000000000';
        const statusRequest = { task_id: fakeTaskId };

        await expect(
            new Promise((resolve, reject) => {
                client.getTaskStatus(statusRequest, (err: any, response: any) => {
                    if (err) reject(err);
                    else resolve(response);
                });
            })
        ).rejects.toMatchObject({
            code: grpc.status.NOT_FOUND,
        });
    });
});
