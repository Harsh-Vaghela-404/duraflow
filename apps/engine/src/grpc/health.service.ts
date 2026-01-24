import {
    HealthServer,
    HealthCheckRequest,
    HealthCheckResponse,
    HealthCheckResponse_ServingStatus,
} from '@duraflow/proto/generated/health.service';
import { ServerUnaryCall, sendUnaryData, ServerWritableStream } from '@grpc/grpc-js';
import { pool, redis } from '../db';

/**
 * Standard gRPC health check service implementation.
 * Verifies Postgres and Redis connectivity.
 */
export class HealthService implements HealthServer {
    [name: string]: any;

    async check(
        call: ServerUnaryCall<HealthCheckRequest, HealthCheckResponse>,
        callback: sendUnaryData<HealthCheckResponse>
    ) {
        try {
            await pool.query('SELECT 1');

            await redis.ping();

            callback(null, {
                status: HealthCheckResponse_ServingStatus.SERVING,
            });
        } catch (error) {
            console.error('Health check failed:', error);
            callback(null, {
                status: HealthCheckResponse_ServingStatus.NOT_SERVING,
            });
        }
    }

    watch(call: ServerWritableStream<HealthCheckRequest, HealthCheckResponse>) {
        call.write({ status: HealthCheckResponse_ServingStatus.SERVING });
        call.end();
    }
}