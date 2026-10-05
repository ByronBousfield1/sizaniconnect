import { badRequest, conflict, forbidden, notFound } from '../domain/errors.js';
import {
  canEditDetails,
  transitionHousehold,
  type HouseholdAction,
  type HouseholdStatus,
} from '../domain/household.js';
import { validateIdentityNumber } from '../domain/identity.js';
import { parcelSizeFor } from '../domain/parcel.js';
import { normaliseReferenceCode } from '../domain/referenceCode.js';
import type { Actor } from '../domain/roles.js';
import { isUniqueViolation } from '../db/pool.js';
import type { MemberInput } from '../repositories/householdRepository.js';
import { hashIdentityNumber } from '../security/tokens.js';
import { audit, page, type ServiceDeps } from './context.js';

export interface RegisterHouseholdInput {
  headOfHousehold: string;
  idNumber: string;
  contactNumber?: string | null;
  addressLine: string;
  suburb: string;
  homeSiteId: string;
  members: MemberInput[];
}

export class HouseholdService {
  constructor(private readonly deps: ServiceDeps) {}

  /** SD-01: register a household, enforcing BR-01 (one live registration per person). */
  async register(actor: Actor, input: RegisterHouseholdInput) {
    const idNumber = validateIdentityNumber(input.idNumber);
    const idHash = hashIdentityNumber(idNumber, this.deps.config.idHashPepper);
    this.assertMembers(input.members);
    if (actor.role === 'SiteCoordinator' && actor.siteId !== input.homeSiteId) {
      throw forbidden('Site coordinators register households for their own site.');
    }

    try {
      return await this.deps.uow.run(async (r) => {
        const existing = await r.households.findLiveByIdHash(idHash);
        if (existing) {
          throw conflict(
            'DUPLICATE_HOUSEHOLD',
            `This person is already registered as household ${existing.referenceCode} at ${existing.homeSiteName}.`,
            { referenceCode: existing.referenceCode, householdId: existing.id },
          );
        }
        const site = await r.events.findSite(input.homeSiteId);
        if (!site || !site.isActive) throw badRequest('INVALID_SITE', 'Choose an active distribution site.');

        let referenceCode = this.deps.referenceCodes.next();
        for (let attempt = 0; await r.households.referenceExists(referenceCode); attempt++) {
          if (attempt >= 5) throw new Error('Could not generate a unique reference code');
          referenceCode = this.deps.referenceCodes.next();
        }

        const id = await r.households.insert({
          referenceCode,
          headOfHousehold: input.headOfHousehold.trim(),
          idNumberHash: idHash,
          contactNumber: input.contactNumber?.trim() || null,
          addressLine: input.addressLine.trim(),
          suburb: input.suburb.trim(),
          homeSiteId: input.homeSiteId,
          registeredBy: actor.id,
        });
        await r.households.insertMembers(id, input.members);
        await audit(r, actor, 'Household', id, 'CREATE', { referenceCode, memberCount: input.members.length });
        return {
          id,
          referenceCode,
          status: 'PendingVerification' as HouseholdStatus,
          parcelSize: parcelSizeFor(input.members.length),
        };
      });
    } catch (err) {
      // Two coordinators registering the same person at the same moment: the partial unique index wins.
      if (isUniqueViolation(err, 'ux_households_id_hash_live')) {
        throw conflict('DUPLICATE_HOUSEHOLD', 'This person was registered moments ago at another desk.');
      }
      throw err;
    }
  }

  async search(filter: { q?: string; status?: HouseholdStatus; siteId?: string; page?: number; pageSize?: number }) {
    const p = page(filter);
    const result = await this.deps.uow.read((r) =>
      r.households.search({ q: filter.q, status: filter.status, siteId: filter.siteId, limit: p.limit, offset: p.offset }),
    );
    return { ...result, page: p.page, pageSize: p.pageSize };
  }

  async get(id: string) {
    return this.deps.uow.read(async (r) => {
      const household = await r.households.findById(id);
      if (!household) throw notFound('Household');
      const [members, collections] = await Promise.all([r.households.members(id), r.households.recentCollections(id)]);
      return { ...household, parcelSize: parcelSizeFor(Math.max(members.length, 1)), members, collections };
    });
  }

  /**
   * A volunteer at the desk needs only enough to confirm identity and issue the right parcel.
   * Address and contact details stay out of this view (POPIA minimality).
   */
  async lookupByReference(code: string, eventId?: string) {
    return this.deps.uow.read(async (r) => {
      const h = await r.households.findByReference(normaliseReferenceCode(code));
      if (!h) throw notFound('No household with that reference code');
      const already = eventId ? await r.collections.findStandard(eventId, h.id) : null;
      return {
        id: h.id,
        referenceCode: h.referenceCode,
        headOfHousehold: h.headOfHousehold,
        suburb: h.suburb,
        homeSiteName: h.homeSiteName,
        status: h.status,
        memberCount: h.memberCount,
        parcelSize: h.memberCount > 0 ? parcelSizeFor(h.memberCount) : null,
        lastCollectedAt: h.lastCollectedAt,
        alreadyCollected: already
          ? { collectedAt: already.collectedAt, verifiedByName: already.verifiedByName }
          : null,
      };
    });
  }

  async update(
    actor: Actor,
    id: string,
    patch: { headOfHousehold?: string; contactNumber?: string | null; addressLine?: string; suburb?: string; members?: MemberInput[] },
  ) {
    if (patch.members) this.assertMembers(patch.members);
    return this.deps.uow.run(async (r) => {
      const h = await r.households.findById(id, true);
      if (!h) throw notFound('Household');
      if (!canEditDetails(h.status)) {
        throw conflict('NOT_EDITABLE', 'Suspended and archived households cannot be edited. Reinstate the household first.');
      }
      await r.households.updateDetails(id, patch);
      if (patch.members) await r.households.replaceMembers(id, patch.members);
      // The audit records which fields changed, not their values, to avoid copying personal data.
      await audit(r, actor, 'Household', id, 'UPDATE', { fields: Object.keys(patch) });
      return { id };
    });
  }

  async changeStatus(actor: Actor, id: string, action: HouseholdAction, reason?: string) {
    if ((action === 'suspend' || action === 'returnForCorrection') && (!reason || reason.trim().length < 5)) {
      throw badRequest('REASON_REQUIRED', 'Give a reason of at least 5 characters so the household can be told why.');
    }
    return this.deps.uow.run(async (r) => {
      const h = await r.households.findById(id, true);
      if (!h) throw notFound('Household');
      // Four-eyes check: the person who registered a household may not also verify it.
      if (action === 'verify' && h.registeredBy === actor.id) {
        throw forbidden('A household must be verified by someone other than the person who registered it.');
      }
      const next = transitionHousehold(h.status, action);
      await r.households.updateStatus(id, next, reason?.trim() || null, action === 'verify' ? actor.id : undefined);
      await audit(r, actor, 'Household', id, 'STATUS_CHANGE', { from: h.status, to: next, reason: reason?.trim() });
      return { id, status: next };
    });
  }

  async archiveInactive(actor: Actor) {
    return this.deps.uow.run(async (r) => {
      const ids = await r.households.archiveInactive();
      for (const id of ids) await audit(r, actor, 'Household', id, 'STATUS_CHANGE', { to: 'Archived', reason: 'BR-08' });
      return { archived: ids.length };
    });
  }

  /** POPIA data subject access: everything held about one household. */
  async exportSubjectData(actor: Actor, id: string) {
    const data = await this.get(id);
    await this.deps.uow.run((r) => audit(r, actor, 'Household', id, 'SUBJECT_ACCESS_EXPORT'));
    return {
      exportedAt: this.deps.clock().toISOString(),
      note: 'Identity numbers are not stored by SizaniConnect; only a one-way keyed hash is kept for duplicate checks.',
      household: data,
    };
  }

  private assertMembers(members: MemberInput[]) {
    if (members.length < 1) throw badRequest('MEMBERS_REQUIRED', 'Add at least one household member.');
    const selfCount = members.filter((m) => m.dependantType === 'Self').length;
    if (selfCount !== 1) {
      throw badRequest('HEAD_REQUIRED', 'Exactly one member must be the head of household (relationship "Self").');
    }
  }
}
