export class StepRetryError extends Error {
    constructor(
        public delay: number,
        public attempt: number,
        public originalError: unknown
    ) {
        super('Step retry scheduled');
    }
}
