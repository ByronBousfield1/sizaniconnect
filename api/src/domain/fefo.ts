/**
 * First-expiry-first-out allocation (BR-06, US-13). Pure function so it can be tested without a
 * database. Quantities are handled in hundredths to avoid floating-point drift, matching the
 * numeric(10,2) columns.
 */
export interface BatchStock {
  batchId: string;
  quantityRemaining: number;
  expiryDate: string | null; // yyyy-mm-dd
  receivedOn: string; // yyyy-mm-dd
}

export interface Allocation {
  batchId: string;
  quantity: number;
}

const toUnits = (n: number) => Math.round(n * 100);
const fromUnits = (n: number) => n / 100;

export function isUsable(batch: BatchStock, today: string): boolean {
  return batch.quantityRemaining > 0 && (batch.expiryDate === null || batch.expiryDate >= today);
}

export function compareFefo(a: BatchStock, b: BatchStock): number {
  if (a.expiryDate !== b.expiryDate) {
    if (a.expiryDate === null) return 1; // undated stock goes last
    if (b.expiryDate === null) return -1;
    return a.expiryDate < b.expiryDate ? -1 : 1;
  }
  return a.receivedOn.localeCompare(b.receivedOn);
}

export function allocateFefo(
  batches: readonly BatchStock[],
  required: number,
  today: string,
): { allocations: Allocation[]; shortfall: number } {
  let remaining = toUnits(required);
  const allocations: Allocation[] = [];
  const ordered = batches.filter((b) => isUsable(b, today)).sort(compareFefo);

  for (const batch of ordered) {
    if (remaining <= 0) break;
    const take = Math.min(toUnits(batch.quantityRemaining), remaining);
    if (take > 0) {
      allocations.push({ batchId: batch.batchId, quantity: fromUnits(take) });
      remaining -= take;
    }
  }
  return { allocations, shortfall: fromUnits(Math.max(0, remaining)) };
}
