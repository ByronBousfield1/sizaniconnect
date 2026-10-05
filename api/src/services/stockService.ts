import { badRequest, conflict, notFound } from '../domain/errors.js';
import type { Actor } from '../domain/roles.js';
import { addDays, saDate } from '../domain/time.js';
import { audit, type ServiceDeps } from './context.js';

const EXPIRY_ALERT_DAYS = 14;

export class StockService {
  constructor(private readonly deps: ServiceDeps) {}

  private today() {
    return saDate(this.deps.clock());
  }

  async items() {
    const items = await this.deps.uow.read((r) => r.stock.listItems(this.today()));
    return items.map((i) => ({ ...i, belowReorder: i.onHand < i.reorderLevel }));
  }

  async createItem(actor: Actor, input: { itemName: string; category: string; unitOfMeasure: string; reorderLevel: number }) {
    return this.deps.uow.run(async (r) => {
      const id = await r.stock.insertItem({ ...input, itemName: input.itemName.trim() });
      await audit(r, actor, 'StockItem', id, 'CREATE', { itemName: input.itemName });
      return { id };
    });
  }

  async batches(itemId: string) {
    return this.deps.uow.read(async (r) => {
      const item = await r.stock.findItem(itemId);
      if (!item) throw notFound('Stock item');
      return { item, batches: await r.stock.batchesForItem(itemId) };
    });
  }

  /** US-14: items below reorder level, and batches expiring within 14 days or already expired. */
  async alerts() {
    const today = this.today();
    const [items, batches] = await Promise.all([
      this.items(),
      this.deps.uow.read((r) => r.stock.expiringBatches(today, addDays(today, EXPIRY_ALERT_DAYS))),
    ]);
    return {
      lowStock: items.filter((i) => i.belowReorder),
      expiring: batches.filter((b) => !b.expired),
      expired: batches.filter((b) => b.expired),
    };
  }

  async writeOff(actor: Actor, batchId: string, reason: string) {
    if (reason.trim().length < 5) throw badRequest('REASON_REQUIRED', 'Give a reason of at least 5 characters.');
    return this.deps.uow.run(async (r) => {
      const batch = await r.stock.findBatch(batchId);
      if (!batch) throw notFound('Stock batch');
      if (batch.quantityRemaining <= 0) throw conflict('NOTHING_TO_WRITE_OFF', 'This batch is already empty.');
      await r.stock.decrementBatch(batch.id, batch.quantityRemaining);
      await r.stock.insertMovement({
        batchId: batch.id,
        recordedBy: actor.id,
        movementType: 'WriteOff',
        quantity: -batch.quantityRemaining,
        reason: reason.trim(),
      });
      await audit(r, actor, 'StockBatch', batch.id, 'WRITE_OFF', { quantity: batch.quantityRemaining, reason });
      return { id: batch.id, writtenOff: batch.quantityRemaining };
    });
  }

  parcels() {
    return this.deps.uow.read((r) => r.stock.parcelComponents());
  }
}
