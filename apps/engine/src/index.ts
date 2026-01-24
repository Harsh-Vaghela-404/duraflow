import { pool, redis } from './db';
import { createGrpcServer, startGrpcServer } from './grpc/server';

async function main() {
    console.log('[duraflow] starting engine...');

    await pool.query('SELECT 1');
    console.log('[duraflow] postgres connected');

    await redis.ping();
    console.log('[duraflow] redis connected');

    const grpcServer = createGrpcServer();
    await startGrpcServer(grpcServer, 50051);


    console.log('[duraflow] engine ready');
}

main().catch((err) => {
    console.error('[duraflow] fatal:', err);
    process.exit(1);
});
