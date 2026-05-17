import { Pool } from "pg";
import Redis from "ioredis";
import {
  HealthCheckRequest,
  HealthCheckResponse,
  HealthCheckResponse_ServingStatus,
} from "@duraflow/proto/generated/health.service";
import {
  ServerUnaryCall,
  sendUnaryData,
  ServerWritableStream,
} from "@grpc/grpc-js";

const TAG = "[health-service]";

export class HealthService {
  constructor(
    private readonly pool: Pool,
    private readonly redis: Redis,
  ) {}

  async check(
    call: ServerUnaryCall<HealthCheckRequest, HealthCheckResponse>,
    callback: sendUnaryData<HealthCheckResponse>,
  ) {
    try {
      await this.pool.query("SELECT 1");
      await this.redis.ping();
      callback(null, { status: HealthCheckResponse_ServingStatus.SERVING });
    } catch (error) {
      console.error(`${TAG} check failed:`, error);
      callback(null, { status: HealthCheckResponse_ServingStatus.NOT_SERVING });
    }
  }

  watch(call: ServerWritableStream<HealthCheckRequest, HealthCheckResponse>) {
    call.write({ status: HealthCheckResponse_ServingStatus.SERVING });
    call.end();
  }
}
