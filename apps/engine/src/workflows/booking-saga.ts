import { workflow, registerCompensation } from "@duraflow/sdk";

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

export const bookingWorkflow = workflow(
  "booking-saga",
  async ({ step, input }) => {
    const inp = input as BookingInput;

    const flight = await step.run(
      "book-flight",
      async () => {
        const bookingId = `FLIGHT-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        mockBookings.flights.set(inp.customerId, {
          bookingId,
          cancelled: false,
        });
        return { bookingId, ...inp.flightDetails };
      },
      {
        compensation: async (output) => {
          const booking = mockBookings.flights.get(inp.customerId);
          if (booking && !booking.cancelled) {
            booking.cancelled = true;
            cancellationOrder.push("flight");
          }
        },
      },
    );

    const hotel = await step.run(
      "book-hotel",
      async () => {
        const bookingId = `HOTEL-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        mockBookings.hotels.set(inp.customerId, {
          bookingId,
          cancelled: false,
        });
        return { bookingId, ...inp.hotelDetails };
      },
      {
        compensation: async (output) => {
          const booking = mockBookings.hotels.get(inp.customerId);
          if (booking && !booking.cancelled) {
            booking.cancelled = true;
            cancellationOrder.push("hotel");
          }
        },
      },
    );

    const car = await step.run(
      "book-car",
      async () => {
        const bookingId = `CAR-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        mockBookings.cars.set(inp.customerId, { bookingId, cancelled: false });
        return { bookingId, ...inp.carDetails };
      },
      {
        compensation: async (output) => {
          const booking = mockBookings.cars.get(inp.customerId);
          if (booking && !booking.cancelled) {
            booking.cancelled = true;
            cancellationOrder.push("car");
          }
        },
      },
    );

    const payment = await step.run(
      "charge-payment",
      async () => {
        throw new Error("PAYMENT_DECLINED: Card was declined");
      },
      {
        compensation: async (output) => {
          // Payment compensation would refund - just tracking for test
          cancellationOrder.push("payment-refund");
        },
      },
    );

    return {
      flightBookingId: flight.bookingId,
      hotelBookingId: hotel.bookingId,
      carBookingId: car.bookingId,
    };
  },
);
