export const ROLES = ['Admin', 'OperationsManager', 'SiteCoordinator', 'Volunteer', 'Donor'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_IDS: Record<Role, number> = {
  Admin: 1,
  OperationsManager: 2,
  SiteCoordinator: 3,
  Volunteer: 4,
  Donor: 5,
};

export function roleFromId(id: number): Role {
  const role = ROLES.find((r) => ROLE_IDS[r] === id);
  if (!role) throw new Error(`Unknown role id ${id}`);
  return role;
}

/** The authenticated principal, built from verified JWT claims. */
export interface Actor {
  id: string;
  role: Role;
  name: string;
  siteId: string | null;
  donorId: string | null;
  ip?: string;
}
