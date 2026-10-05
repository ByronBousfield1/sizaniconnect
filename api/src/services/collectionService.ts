import { isUniqueViolation } from '../db/pool.js';
import { badRequest, conflict, forbidden, notFound } from '../domain/errors.js';
import { allocateFefo } from '../domain/fefo.js';
import { isEligibleForParcel, STATUS_LABELS } from '../domain/household.js';
import { parcelSizeFor } from '../domain/parcel.js';
import type { Actor } from '../domain/roles.js';
import { saDate } from '../domain/time.js';
import { assertSiteScope, audit, hasRole, type ServiceDeps } from './context.js';

export interface RecordCollectionInput {
  eventId: string;
  householdId: string;
  override?: boolean;
  overrideReason?: string;
}

export class CollectionService {
  constructor(private readonly deps: ServiceDeps) {}

  /** SD-02: record a parcel collection and deduct stock first-expiry-first-out. */
  async record(actor: Actor, input: RecordCollectionInput) {
    const today = saDate(this.deps.clock());
    try {
      const result = await this.deps.uow.run(async (r) => {
        const event = await r.events.findEvent(input.eventId);
        if (!event) throw notFound('Distribution event');
        if (actor.role === 'SiteCoordinator') assertSiteScope(actor, event.siteId);
        if (event.status !== 'Open') {
          throw conflict('EVENT_NOT_OPEN', 'Collections can only be recorded while the event is open.');
        }

        const household = await r.households.findById(input.householdId, true);
        if (!household) throw notFound('Household');
        if (!isEligibleForParcel(household.status)) {
          throw conflict(
            'HOUSEHOLD_NOT_ELIGIBLE',
            `This household is ${STATUS_LABELS[household.status]} and cannot collect. Refer them to the site coordinator.`,
            { status: household.status },
          );
        }

        // BR-04: one parcel per household per event, unless a coordinator overrides with a reason.
        const existing = await r.collections.findStandard(event.id, household.id);
        let isOverride = false;
        if (existing) {
          if (!input.override) {
            throw conflict(
              'DUPLICATE_COLLECTION',
              `${household.headOfHousehold} already collected at this event.`,
              { collectedAt: existing.collectedAt, verifiedByName: existing.verifiedByName },
            );
          }
          if (!hasRole(actor, 'SiteCoordinator', 'OperationsManager')) {
            throw forbidden('Only a site coordinator can approve a second parcel.');
          }
          if (!input.overrideReason || input.overrideReason.trim().length < 10) {
            throw badRequest('OVERRIDE_REASON_REQUIRED', 'Explain the override in at least 10 characters.');
          }
          isOverride = true;
        }

        const parcelSize = parcelSizeFor(household.memberCount);
        const components = await r.stock.parcelComponents(parcelSize);
        if (components.length === 0) {
          throw conflict('PARCEL_NOT_CONFIGURED', `No contents are set up for a ${parcelSize.toLowerCase()} parcel.`);
        }

        const collection = await r.collections.insert({
          eventId: event.id,
          householdId: household.id,
          verifiedBy: actor.id,
          parcelSize,
          isOverride,
          overrideReason: isOverride ? input.overrideReason!.trim() : null,
        });

        const issued = [];
        for (const c of components) {
          const batches = await r.stock.lockBatchesForIssue(c.stockItemId);
          const { allocations, shortfall } = allocateFefo(batches, c.quantity, today);
          if (shortfall > 0) {
            throw conflict(
              'INSUFFICIENT_STOCK',
              `Not enough ${c.itemName} left to make up this parcel. Tell the operations manager.`,
              { itemName: c.itemName, shortfall },
            );
          }
          for (const a of allocations) {
            await r.stock.decrementBatch(a.batchId, a.quantity);
            await r.stock.insertMovement({
              batchId: a.batchId,
              eventId: event.id,
              collectionId: collection.id,
              recordedBy: actor.id,
              movementType: 'Issue',
              quantity: -a.quantity,
            });
          }
          issued.push({ itemName: c.itemName, unitOfMeasure: c.unitOfMeasure, quantity: c.quantity });
        }

        await audit(r, actor, 'Collection', collection.id, isOverride ? 'OVERRIDE' : 'CREATE', {
          eventId: event.id,
          householdId: household.id,
          parcelSize,
          ...(isOverride ? { reason: input.overrideReason!.trim() } : {}),
        });

        return {
          id: collection.id,
          collectedAt: collection.collectedAt,
          parcelSize,
          isOverride,
          householdId: household.id,
          referenceCode: household.referenceCode,
          headOfHousehold: household.headOfHousehold,
          issued,
        };
      });

      await this.deps.bus.publish({
        type: 'CollectionRecorded',
        householdId: result.householdId,
        eventId: input.eventId,
        collectedAt: new Date(result.collectedAt).toISOString(),
        isOverride: result.isOverride,
      });
      return result;
    } catch (err) {
      // Two volunteers scanning the same slip at once: the database constraint decides.
      if (isUniqueViolation(err, 'ux_collections_once_per_event')) {
        throw conflict('DUPLICATE_COLLECTION', 'This household was recorded moments ago at another device.');
      }
      throw err;
    }
  }

  async listForEvent(eventId: string) {
    return this.deps.uow.read((r) => r.collections.listForEvent(eventId));
  }
}
