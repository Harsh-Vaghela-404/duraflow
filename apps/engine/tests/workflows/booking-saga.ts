import { workflow } from '@duraflow/sdk';

export interface BookingInput {
    customerId: string;
    flightDetails: { from: string; to: string; date: string };
    hotelDetails: { city: string; checkIn: string; checkOut: string };
    carDetails: { city: string; pickUp: string; dropOff: string };
    paymentAmount: number;
}

export interface BookingOutput {
    flightBookingId: string;
    hotelBookingId: string;
    carBookingId: string;
    paymentId: string;
}

// Records the order compensations ran in. Because compensations run in whatever
// process performs the rollback (the engine main thread), a test running in that
// same process can observe this array to assert LIFO ordering.
export const cancellationOrder: string[] = [];

export function resetCancellationOrder(): void {
    cancellationOrder.length = 0;
}

export function getCancellationOrder(): string[] {
    return [...cancellationOrder];
}

export const mockBookings = {
    flights: new Map<string, { bookingId: string; cancelled: boolean }>(),
    hotels: new Map<string, { bookingId: string; cancelled: boolean }>(),
    cars: new Map<string, { bookingId: string; cancelled: boolean }>(),
};

export function resetMockBookings(): void {
    mockBookings.flights.clear();
    mockBookings.hotels.clear();
    mockBookings.cars.clear();
}

// A compensation may only use the step's persisted output, so it must look the
// booking up by its id (not by any closed-over handler state).
function cancelByBookingId(
    store: Map<string, { bookingId: string; cancelled: boolean }>,
    bookingId: string,
): void {
    for (const booking of store.values()) {
        if (booking.bookingId === bookingId && !booking.cancelled) {
            booking.cancelled = true;
            return;
        }
    }
}

export const bookingWorkflow = workflow(
    'booking-saga',
    async ({ step, input }) => {
        const inp = input as BookingInput;

        const flight = await step.run('book-flight', async () => {
            const bookingId = `FLIGHT-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            mockBookings.flights.set(inp.customerId, { bookingId, cancelled: false });
            return { bookingId, ...inp.flightDetails };
        });

        const hotel = await step.run('book-hotel', async () => {
            const bookingId = `HOTEL-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            mockBookings.hotels.set(inp.customerId, { bookingId, cancelled: false });
            return { bookingId, ...inp.hotelDetails };
        });

        const car = await step.run('book-car', async () => {
            const bookingId = `CAR-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            mockBookings.cars.set(inp.customerId, { bookingId, cancelled: false });
            return { bookingId, ...inp.carDetails };
        });

        // Always fails - drives the saga into rollback.
        await step.run('charge-payment', async () => {
            throw new Error('PAYMENT_DECLINED: Card was declined');
        });

        return {
            flightBookingId: flight.bookingId,
            hotelBookingId: hotel.bookingId,
            carBookingId: car.bookingId,
        };
    },
    {
        // Compensations are pure functions of each step's saved output, registered
        // by step key at module load so a rollback in any process can resolve them.
        compensations: {
            'book-flight': async (output) => {
                cancelByBookingId(
                    mockBookings.flights,
                    (output as { bookingId: string }).bookingId,
                );
                cancellationOrder.push('flight');
            },
            'book-hotel': async (output) => {
                cancelByBookingId(mockBookings.hotels, (output as { bookingId: string }).bookingId);
                cancellationOrder.push('hotel');
            },
            'book-car': async (output) => {
                cancelByBookingId(mockBookings.cars, (output as { bookingId: string }).bookingId);
                cancellationOrder.push('car');
            },
        },
    },
);
