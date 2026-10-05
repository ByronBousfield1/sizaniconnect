import { badRequest, notFound } from '../domain/errors.js';
import type { Actor } from '../domain/roles.js';
import { saDate } from '../domain/time.js';
import { audit, type ServiceDeps } from './context.js';

export interface CaptureDonationInput {
  donorId: string;
  donationType: 'Cash' | 'InKind';
  monetaryValue?: number;
  receivedOn: string;
  notes?: string;
  lines?: { stockItemId: string; quantity: number; expiryDate?: string | null }[];
}

export class DonationService {
  constructor(private readonly deps: ServiceDeps) {}

  listDonors() {
    return this.deps.uow.read((r) => r.donations.listDonors());
  }

  async createDonor(
    actor: Actor,
    input: { donorName: string; donorType: string; contactEmail?: string | null; isAnonymous?: boolean },
  ) {
    return this.deps.uow.run(async (r) => {
      const id = await r.donations.insertDonor({
        donorName: input.donorName.trim(),
        donorType: input.donorType,
        contactEmail: input.contactEmail?.trim() || null,
        isAnonymous: input.isAnonymous ?? false,
      });
      await audit(r, actor, 'Donor', id, 'CREATE');
      return { id };
    });
  }

  /** SD-03 / US-12: record a donation; in-kind lines become stock batches with their own expiry. */
  async capture(actor: Actor, input: CaptureDonationInput) {
    const today = saDate(this.deps.clock());
    if (input.receivedOn > today) throw badRequest('DATE_IN_FUTURE', 'A donation cannot be received in the future.');
    const lines = input.lines ?? [];
    if (input.donationType === 'Cash') {
      if (!input.monetaryValue || input.monetaryValue <= 0) {
        throw badRequest('AMOUNT_REQUIRED', 'Enter the amount received in rand.');
      }
      if (lines.length > 0) throw badRequest('LINES_NOT_ALLOWED', 'Cash donations do not have stock lines.');
    } else {
      if (lines.length === 0) throw badRequest('LINES_REQUIRED', 'Add at least one item to an in-kind donation.');
      for (const line of lines) {
        if (line.expiryDate && line.expiryDate < input.receivedOn) {
          throw badRequest('EXPIRED_ON_RECEIPT', 'An item cannot expire before the day it was received.');
        }
      }
    }

    const result = await this.deps.uow.run(async (r) => {
      const donor = await r.donations.findDonor(input.donorId);
      if (!donor) throw badRequest('INVALID_DONOR', 'Choose a donor, or add a new one first.');
      const receiptNumber = await r.donations.nextReceiptNumber(Number(input.receivedOn.slice(0, 4)));
      const id = await r.donations.insert({
        donorId: donor.id,
        donationType: input.donationType,
        monetaryValue: input.monetaryValue ?? 0,
        receivedOn: input.receivedOn,
        receiptNumber,
        notes: input.notes?.trim() || null,
        capturedBy: actor.id,
      });
      for (const line of lines) {
        const item = await r.stock.findItem(line.stockItemId);
        if (!item) throw badRequest('INVALID_STOCK_ITEM', 'One of the items is not in the stock catalogue.');
        const batchId = await r.stock.insertBatch({
          stockItemId: item.id,
          donationId: id,
          quantity: line.quantity,
          expiryDate: line.expiryDate ?? null,
          receivedOn: input.receivedOn,
        });
        await r.stock.insertMovement({ batchId, recordedBy: actor.id, movementType: 'Receipt', quantity: line.quantity });
      }
      await audit(r, actor, 'Donation', id, 'CREATE', { receiptNumber, type: input.donationType, lines: lines.length });
      return { id, receiptNumber, donorId: donor.id };
    });

    await this.deps.bus.publish({
      type: 'DonationCaptured',
      donationId: result.id,
      donorId: result.donorId,
      receiptNumber: result.receiptNumber,
    });
    return { id: result.id, receiptNumber: result.receiptNumber };
  }

  list(filter: { donorId?: string; limit?: number }) {
    return this.deps.uow.read((r) => r.donations.list({ donorId: filter.donorId, limit: Math.min(filter.limit ?? 100, 500) }));
  }

  /**
   * A donor may only see their own donations. Someone else's donation returns "not found" rather
   * than "forbidden", so its existence is not confirmed (T-04).
   */
  async get(actor: Actor, id: string) {
    const donation = await this.deps.uow.read((r) => r.donations.find(id));
    if (!donation) throw notFound('Donation');
    if (actor.role === 'Donor' && donation.donorId !== actor.donorId) throw notFound('Donation');
    return donation;
  }
}
