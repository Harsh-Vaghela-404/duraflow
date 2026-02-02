import { Pool, PoolClient } from 'pg';
import { pool } from './index';

export class TransactionManager {
    constructor(private pool: Pool) { }

    async run<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
        const client = await this.pool.connect();

        try {
            await client.query('BEGIN');
            const result = await callback(client);
            await client.query('COMMIT');
            return result;
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    }
}

export const transactionManager = new TransactionManager(pool);