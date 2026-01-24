/**
 * gRPC server configuration and initialization.
 * Loads proto definitions, registers services, and enables reflection for debugging.
 */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';
import { HealthService } from './health.service';
import { AgentServiceImpl } from './agent.service';

const HEALTH_PROTO_PATH = path.join(__dirname, '../../../..', 'packages/proto/health.service.proto');
const AGENT_PROTO_PATH = path.join(__dirname, '../../../..', 'packages/proto/agent.service.proto');

const healthPackageDef = protoLoader.loadSync(HEALTH_PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
});

const agentPackageDef = protoLoader.loadSync(AGENT_PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
});

const healthProto = grpc.loadPackageDefinition(healthPackageDef) as any;
const agentProto = grpc.loadPackageDefinition(agentPackageDef) as any;

/**
 * Creates gRPC server with Health and AgentService.
 * Reflection enabled for grpcurl debugging.
 */
export function createGrpcServer(): grpc.Server {
    const server = new grpc.Server();

    const healthService = new HealthService();
    server.addService(healthProto.grpc.health.v1.Health.service, {
        check: healthService.check.bind(healthService),
        watch: healthService.watch.bind(healthService),
    });

    const agentService = new AgentServiceImpl();
    server.addService(agentProto.duraflow.AgentService.service, {
        submitTask: agentService.submitTask.bind(agentService),
        getTaskStatus: agentService.getTaskStatus.bind(agentService),
        cancelTask: agentService.cancelTask.bind(agentService),
    });

    const reflection = require('@grpc/reflection');
    const reflectionService = new reflection.ReflectionService({
        ...healthPackageDef,
        ...agentPackageDef,
    });
    reflectionService.addToServer(server);

    return server;
}

/**
 * Starts gRPC server on specified port.
 * Binds to 0.0.0.0 for container compatibility, no TLS.
 */
export function startGrpcServer(server: grpc.Server, port: number = 50051): Promise<number> {
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
            }
        );
    });
}
