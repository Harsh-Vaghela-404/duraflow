import { Pool, PoolClient } from 'pg';
import { pool } from './index';

/**
 * Manages atomic database transactions with automatic rollback on errors.
 * Ensures data consistency for multi-step operations.
 */
export class TransactionManager {
    constructor(private pool: Pool) { }

    /**
     * Executes a callback within a database transaction.
     * Automatically commits on success, rolls back on error.
     * 
     * @param callback Function to execute within the transaction
     * @returns Result from the callback
     * @throws Re-throws any error from the callback after rollback
     * 
     * @example
     * await txManager.run(async (client) => {
     *   await client.query('INSERT INTO tasks ...');
     *   await client.query('INSERT INTO steps ...');
     *   return { success: true };
     * });
     */
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

/** Singleton instance for application-wide transaction management */
export const transactionManager = new TransactionManager(pool);