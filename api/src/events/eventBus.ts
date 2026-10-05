import type { Logger } from '../infra/logger.js';

/**
 * Observer pattern (Task 1, Section 9.1). Services announce what happened; subscribers decide
 * what else follows. Events are published only after the transaction commits, so a subscriber
 * never acts on a change that was rolled back.
 */
export type DomainEvent =
  | { type: 'CollectionRecorded'; householdId: string; eventId: string; collectedAt: string; isOverride: boolean }
  | { type: 'ShiftWithdrawn'; shiftId: string; volunteerName: string; siteId: string; startsAt: string }
  | { type: 'DonationCaptured'; donationId: string; donorId: string; receiptNumber: string };

type Handler<T extends DomainEvent['type']> = (event: Extract<DomainEvent, { type: T }>) => Promise<void>;

export class EventBus {
  private readonly handlers = new Map<string, Handler<DomainEvent['type']>[]>();

  constructor(private readonly log: Logger) {}

  subscribe<T extends DomainEvent['type']>(type: T, handler: Handler<T>): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler as unknown as Handler<DomainEvent['type']>);
    this.handlers.set(type, list);
  }

  async publish(event: DomainEvent): Promise<void> {
    for (const handler of this.handlers.get(event.type) ?? []) {
      try {
        await handler(event as never);
      } catch (err) {
        // A failing side effect (an email, say) must never undo the operation that triggered it.
        this.log.error({ err, eventType: event.type }, 'Domain event handler failed');
      }
    }
  }
}
