import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import path from "path";
import { Pool } from "pg";
import Redis from "ioredis";
import { HealthService } from "./health.service";
import { AgentServiceImpl } from "./agent.service";

const HEALTH_PROTO_PATH = path.join(
  __dirname,
  "../../../..",
  "packages/proto/health.service.proto",
);
const AGENT_PROTO_PATH = path.join(
  __dirname,
  "../../../..",
  "packages/proto/agent.service.proto",
);

const protoOptions = {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
};

const healthPackageDef = protoLoader.loadSync(HEALTH_PROTO_PATH, protoOptions);
const agentPackageDef = protoLoader.loadSync(AGENT_PROTO_PATH, protoOptions);

const healthProto = grpc.loadPackageDefinition(healthPackageDef) as any;
const agentProto = grpc.loadPackageDefinition(agentPackageDef) as any;

export function createGrpcServer(pool: Pool, redis: Redis): grpc.Server {
  const server = new grpc.Server({
    "grpc.max_receive_message_length": 4 * 1024 * 1024,
    "grpc.max_send_message_length": 4 * 1024 * 1024,
    "grpc.keepalive_time_ms": 30000,
    "grpc.keepalive_timeout_ms": 10000,
    "grpc.keepalive_permit_without_calls": 1,
  });

  const healthService = new HealthService(pool, redis);
  server.addService(healthProto.grpc.health.v1.Health.service, {
    check: healthService.check.bind(healthService),
    watch: healthService.watch.bind(healthService),
  });

  const agentService = new AgentServiceImpl(pool);
  server.addService(agentProto.duraflow.AgentService.service, {
    submitTask: agentService.submitTask.bind(agentService),
    getTaskStatus: agentService.getTaskStatus.bind(agentService),
    cancelTask: agentService.cancelTask.bind(agentService),
  });

  // reflection for grpcurl debugging
  const reflection = require("@grpc/reflection");
  const reflectionService = new reflection.ReflectionService({
    ...healthPackageDef,
    ...agentPackageDef,
  });
  reflectionService.addToServer(server);

  return server;
}

export function startGrpcServer(
  server: grpc.Server,
  port: number = 50051,
): Promise<number> {
  return new Promise((resolve, reject) => {
    server.bindAsync(
      `0.0.0.0:${port}`,
      grpc.ServerCredentials.createInsecure(),
      (err, boundPort) => {
        if (err) {
          reject(err);
        } else {
          console.log(`[duraflow] grpc server listening on port ${boundPort}`);
          resolve(boundPort);
        }
      },
    );
  });
}
