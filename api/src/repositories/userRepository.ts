import type { Db } from '../db/pool.js';
import { ROLE_IDS, roleFromId, type Role } from '../domain/roles.js';

export interface UserRecord {
  id: string;
  fullName: string;
  email: string;
  phoneNumber: string | null;
  role: Role;
  siteId: string | null;
  siteName: string | null;
  donorId: string | null;
  passwordHash: string;
  isActive: boolean;
  failedLoginCount: number;
  lockedUntil: Date | null;
  createdAt: Date;
}

export type PublicUser = Omit<UserRecord, 'passwordHash' | 'failedLoginCount' | 'lockedUntil'>;

const SELECT_USER = `
  SELECT u.user_id AS id, u.full_name AS "fullName", u.email, u.phone_number AS "phoneNumber",
         u.role_id AS "roleId", u.site_id AS "siteId", s.site_name AS "siteName", u.donor_id AS "donorId",
         u.password_hash AS "passwordHash", u.is_active AS "isActive",
         u.failed_login_count AS "failedLoginCount", u.locked_until AS "lockedUntil", u.created_at AS "createdAt"
  FROM users u
  LEFT JOIN distribution_sites s ON s.site_id = u.site_id`;

function toUser(row: Record<string, unknown>): UserRecord {
  const { roleId, ...rest } = row;
  return { ...(rest as Omit<UserRecord, 'role'>), role: roleFromId(roleId as number) };
}

export function toPublicUser(user: UserRecord): PublicUser {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { passwordHash, failedLoginCount, lockedUntil, ...rest } = user;
  return rest;
}

export class UserRepository {
  constructor(private readonly db: Db) {}

  async findByEmail(email: string): Promise<UserRecord | null> {
    const r = await this.db.query(SELECT_USER + ' WHERE lower(u.email) = lower($1)', [email]);
    return r.rows[0] ? toUser(r.rows[0]) : null;
  }

  async findById(id: string): Promise<UserRecord | null> {
    const r = await this.db.query(SELECT_USER + ' WHERE u.user_id = $1', [id]);
    return r.rows[0] ? toUser(r.rows[0]) : null;
  }

  async list(filter: { q?: string; role?: Role }): Promise<UserRecord[]> {
    const r = await this.db.query(
      SELECT_USER +
        ` WHERE ($1::text IS NULL OR u.full_name ILIKE '%' || $1 || '%' OR u.email ILIKE '%' || $1 || '%')
            AND ($2::smallint IS NULL OR u.role_id = $2)
          ORDER BY u.is_active DESC, u.full_name`,
      [filter.q ?? null, filter.role ? ROLE_IDS[filter.role] : null],
    );
    return r.rows.map(toUser);
  }

  async countActiveAdmins(): Promise<number> {
    const r = await this.db.query('SELECT count(*) AS n FROM users WHERE role_id = 1 AND is_active');
    return r.rows[0].n;
  }

  async insert(u: {
    fullName: string;
    email: string;
    phoneNumber?: string | null;
    role: Role;
    siteId?: string | null;
    donorId?: string | null;
    passwordHash: string;
  }): Promise<string> {
    const r = await this.db.query(
      `INSERT INTO users (full_name, email, phone_number, role_id, site_id, donor_id, password_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING user_id AS id`,
      [u.fullName, u.email, u.phoneNumber ?? null, ROLE_IDS[u.role], u.siteId ?? null, u.donorId ?? null, u.passwordHash],
    );
    return r.rows[0].id;
  }

  async update(
    id: string,
    patch: { fullName?: string; phoneNumber?: string | null; role?: Role; siteId?: string | null; isActive?: boolean },
  ): Promise<void> {
    await this.db.query(
      `UPDATE users SET
         full_name    = COALESCE($2, full_name),
         phone_number = CASE WHEN $3::boolean THEN $4 ELSE phone_number END,
         role_id      = COALESCE($5, role_id),
         site_id      = CASE WHEN $6::boolean THEN $7::uuid ELSE site_id END,
         is_active    = COALESCE($8, is_active)
       WHERE user_id = $1`,
      [
        id,
        patch.fullName ?? null,
        patch.phoneNumber !== undefined,
        patch.phoneNumber ?? null,
        patch.role ? ROLE_IDS[patch.role] : null,
        patch.siteId !== undefined,
        patch.siteId ?? null,
        patch.isActive ?? null,
      ],
    );
  }

  /** Counts a failure, restarting the count if the last failure was outside the lockout window. */
  async recordFailedLogin(id: string, threshold: number, minutes: number): Promise<{ locked: boolean }> {
    const r = await this.db.query(
      `UPDATE users SET
         failed_login_count = CASE WHEN last_failed_login_at < now() - make_interval(mins => $2)
                                   THEN 1 ELSE failed_login_count + 1 END,
         last_failed_login_at = now()
       WHERE user_id = $1
       RETURNING failed_login_count`,
      [id, minutes],
    );
    const count = r.rows[0]?.failed_login_count ?? 0;
    if (count >= threshold) {
      await this.db.query(
        'UPDATE users SET locked_until = now() + make_interval(mins => $2), failed_login_count = 0 WHERE user_id = $1',
        [id, minutes],
      );
      return { locked: true };
    }
    return { locked: false };
  }

  async clearFailedLogins(id: string): Promise<void> {
    await this.db.query(
      'UPDATE users SET failed_login_count = 0, last_failed_login_at = NULL, locked_until = NULL WHERE user_id = $1',
      [id],
    );
  }

  async setPasswordHash(id: string, hash: string): Promise<void> {
    await this.db.query('UPDATE users SET password_hash = $2 WHERE user_id = $1', [id, hash]);
  }

  async coordinatorEmailsForSite(siteId: string): Promise<string[]> {
    const r = await this.db.query(
      'SELECT email FROM users WHERE site_id = $1 AND role_id = $2 AND is_active',
      [siteId, ROLE_IDS.SiteCoordinator],
    );
    return r.rows.map((row) => row.email);
  }
}

export class TokenRepository {
  constructor(private readonly db: Db) {}

  async insertRefreshToken(t: { userId: string; familyId: string; hash: string; expiresAt: Date }): Promise<void> {
    await this.db.query(
      'INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)',
      [t.userId, t.familyId, t.hash, t.expiresAt],
    );
  }

  async findRefreshToken(hash: string) {
    const r = await this.db.query(
      `SELECT token_id AS id, user_id AS "userId", family_id AS "familyId", expires_at AS "expiresAt",
              revoked_at AS "revokedAt"
       FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`,
      [hash],
    );
    return (r.rows[0] as
      | { id: string; userId: string; familyId: string; expiresAt: Date; revokedAt: Date | null }
      | undefined) ?? null;
  }

  async revokeRefreshToken(id: string): Promise<void> {
    await this.db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE token_id = $1 AND revoked_at IS NULL', [id]);
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL', [
      familyId,
    ]);
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [
      userId,
    ]);
  }

  async insertResetToken(t: { userId: string; hash: string; purpose: 'reset' | 'activation'; expiresAt: Date }) {
    // Issuing a new link retires any earlier unused one for the same purpose.
    await this.db.query(
      'UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL',
      [t.userId, t.purpose],
    );
    await this.db.query(
      'INSERT INTO password_reset_tokens (token_hash, user_id, purpose, expires_at) VALUES ($1, $2, $3, $4)',
      [t.hash, t.userId, t.purpose, t.expiresAt],
    );
  }

  async consumeResetToken(hash: string): Promise<{ userId: string; purpose: string } | null> {
    const r = await this.db.query(
      `UPDATE password_reset_tokens SET used_at = now()
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
       RETURNING user_id AS "userId", purpose`,
      [hash],
    );
    return r.rows[0] ?? null;
  }
}
