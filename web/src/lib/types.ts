export type Role = 'Admin' | 'OperationsManager' | 'SiteCoordinator' | 'Volunteer' | 'Donor';

export interface User {
  id: string;
  fullName: string;
  email: string;
  phoneNumber: string | null;
  role: Role;
  siteId: string | null;
  siteName: string | null;
  donorId: string | null;
  isActive: boolean;
}

export type HouseholdStatus = 'Draft' | 'PendingVerification' | 'Active' | 'Suspended' | 'Archived';
export type EventStatus = 'Planned' | 'Stocked' | 'Open' | 'Closed' | 'Reconciled' | 'Cancelled';
export type ParcelSize = 'Small' | 'Medium' | 'Large';

export interface Site {
  id: string;
  siteName: string;
  suburb: string;
  capacityPerEvent: number;
  isActive: boolean;
}

export interface Member {
  id?: string;
  firstName: string;
  ageBand: string;
  dependantType: string;
}

export interface Household {
  id: string;
  referenceCode: string;
  headOfHousehold: string;
  contactNumber: string | null;
  addressLine: string;
  suburb: string;
  homeSiteId: string;
  homeSiteName: string;
  status: HouseholdStatus;
  statusReason: string | null;
  registeredByName: string;
  verifiedByName: string | null;
  registeredOn: string;
  verifiedOn: string | null;
  lastCollectedAt: string | null;
  memberCount: number;
}

export interface HouseholdDetail extends Household {
  parcelSize: ParcelSize;
  members: Member[];
  collections: { id: string; collectedAt: string; parcelSize: ParcelSize; isOverride: boolean; siteName: string }[];
}

export interface DistributionEvent {
  id: string;
  siteId: string;
  siteName: string;
  scheduledDate: string;
  startTime: string;
  endTime: string;
  plannedParcels: number;
  minVolunteers: number;
  status: EventStatus;
  physicalCount: number | null;
  variance: number | null;
  varianceReason: string | null;
  cancelReason: string | null;
  collectionCount: number;
  checkedInVolunteers: number;
}

export interface Shift {
  id: string;
  eventId: string;
  siteId: string;
  siteName: string;
  eventDate: string;
  eventStatus: EventStatus;
  startsAt: string;
  endsAt: string;
  volunteersNeeded: number;
  filled: number;
  notes: string | null;
  myStatus: 'Assigned' | 'Withdrawn' | 'CheckedIn' | null;
}

export interface StockItem {
  id: string;
  itemName: string;
  category: string;
  unitOfMeasure: string;
  reorderLevel: number;
  onHand: number;
  expiredOnHand: number;
  nextExpiry: string | null;
  belowReorder: boolean;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
