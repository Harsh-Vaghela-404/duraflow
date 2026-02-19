import { Poller } from '../../src/services/poller';
import { sleep } from '../helpers/poll';

describe('Poller', () => {
    let mockRepo: any;
    let poller: Poller;
    let onTaskReceived: jest.Mock;

    beforeEach(() => {
        mockRepo = {
            dequeue: jest.fn().mockResolvedValue([]),
        };
        onTaskReceived = jest.fn().mockResolvedValue(undefined);

        poller = new Poller(mockRepo, {
            workerId: 'test-worker',
            onTaskReceived,
            batchSize: 2,
        });
    });

    afterEach(async () => {
        await poller.stop();
    });

    it('polls continuously when tasks are found', async () => {
        mockRepo.dequeue
            .mockResolvedValueOnce([{ id: 't1' }, { id: 't2' }])
            .mockResolvedValueOnce([])
            .mockResolvedValue([]);

        poller.start();
        await sleep(200);

        expect(mockRepo.dequeue).toHaveBeenCalledTimes(2); // Initial + 1 retry
        expect(onTaskReceived).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }));
        expect(onTaskReceived).toHaveBeenCalledWith(expect.objectContaining({ id: 't2' }));
    });

    it('respects backpressure', async () => {
        const checkBackpressure = jest.fn().mockReturnValue(true);
        poller = new Poller(mockRepo, {
            workerId: 'test-worker',
            onTaskReceived,
            checkBackpressure,
        });

        poller.start();
        await sleep(100);

        expect(checkBackpressure).toHaveBeenCalled();
        expect(mockRepo.dequeue).not.toHaveBeenCalled();
    });
});
