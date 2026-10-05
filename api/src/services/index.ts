import { AdminService } from './adminService.js';
import { AuthService } from './authService.js';
import { CollectionService } from './collectionService.js';
import type { ServiceDeps } from './context.js';
import { DonationService } from './donationService.js';
import { EventService } from './eventService.js';
import { HouseholdService } from './householdService.js';
import { ReportService } from './reportService.js';
import { ShiftService } from './shiftService.js';
import { StockService } from './stockService.js';

export interface Services {
  auth: AuthService;
  households: HouseholdService;
  events: EventService;
  collections: CollectionService;
  shifts: ShiftService;
  donations: DonationService;
  stock: StockService;
  reports: ReportService;
  admin: AdminService;
}

export function createServices(deps: ServiceDeps): Services {
  return {
    auth: new AuthService(deps),
    households: new HouseholdService(deps),
    events: new EventService(deps),
    collections: new CollectionService(deps),
    shifts: new ShiftService(deps),
    donations: new DonationService(deps),
    stock: new StockService(deps),
    reports: new ReportService(deps),
    admin: new AdminService(deps),
  };
}
