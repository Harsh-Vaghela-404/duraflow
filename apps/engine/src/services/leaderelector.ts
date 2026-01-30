import { LOCK_IDS } from '../constants/lock_ids'
import { Pool } from "pg"

export class LeaderElector {
    constructor(private pool: Pool) { }

    async tryBecomeLeader(): Promise<boolean> {
        const lockData = await this.pool.query(`SELECT pg_try_advisory_lock($1)`, [LOCK_IDS.REAPER_LEADER])
        return lockData.rows[0].pg_try_advisory_lock;

    }

    async releaseLeaderShip(): Promise<void> {
        await this.pool.query(`SELECT pg_advisory_unlock($1)`, [LOCK_IDS.REAPER_LEADER])
    }
}