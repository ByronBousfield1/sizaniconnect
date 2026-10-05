-- SizaniConnect initial schema.
-- Mirrors the ERD in the Task 1 documentation (Section 8.2), plus the token tables the
-- authentication design in Section 10.2 requires. No PostgreSQL extensions are used, so the
-- schema runs unchanged on Azure Database for PostgreSQL without allow-listing anything.

CREATE TABLE roles (
  role_id      smallint PRIMARY KEY,
  role_name    varchar(40) NOT NULL UNIQUE,
  permissions  jsonb NOT NULL DEFAULT '[]'::jsonb
);

INSERT INTO roles (role_id, role_name, permissions) VALUES
  (1, 'Admin',             '["users:manage","sites:manage","audit:read"]'),
  (2, 'OperationsManager', '["households:verify","events:manage","stock:manage","donations:manage","reports:read"]'),
  (3, 'SiteCoordinator',   '["households:register","events:run","collections:override"]'),
  (4, 'Volunteer',         '["shifts:self","collections:record"]'),
  (5, 'Donor',             '["donor-portal:self"]');

CREATE TABLE distribution_sites (
  site_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_name           varchar(100) NOT NULL UNIQUE,
  suburb              varchar(80)  NOT NULL,
  capacity_per_event  integer      NOT NULL CHECK (capacity_per_event > 0),
  is_active           boolean      NOT NULL DEFAULT true,
  created_at          timestamptz  NOT NULL DEFAULT now()
);

CREATE TABLE donors (
  donor_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  donor_name     varchar(150) NOT NULL,
  donor_type     varchar(30)  NOT NULL CHECK (donor_type IN ('Individual','Corporate','Trust','Government')),
  contact_email  varchar(254),
  is_anonymous   boolean      NOT NULL DEFAULT false,
  created_at     timestamptz  NOT NULL DEFAULT now()
);

CREATE TABLE users (
  user_id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name             varchar(120) NOT NULL,
  email                 varchar(254) NOT NULL,
  phone_number          varchar(20),
  role_id               smallint     NOT NULL REFERENCES roles(role_id),
  site_id               uuid         REFERENCES distribution_sites(site_id),
  donor_id              uuid         REFERENCES donors(donor_id),
  password_hash         varchar(255) NOT NULL,
  is_active             boolean      NOT NULL DEFAULT true,
  failed_login_count    integer      NOT NULL DEFAULT 0,
  last_failed_login_at  timestamptz,
  locked_until          timestamptz,
  created_at            timestamptz  NOT NULL DEFAULT now(),
  -- A donor account must be linked to exactly one donor record, and only donor accounts may be.
  CONSTRAINT ck_users_donor_link CHECK ((role_id = 5) = (donor_id IS NOT NULL)),
  -- Site coordinators are always attached to the site they run.
  CONSTRAINT ck_users_coordinator_site CHECK (role_id <> 3 OR site_id IS NOT NULL)
);
CREATE UNIQUE INDEX ux_users_email ON users (lower(email));

CREATE TABLE refresh_tokens (
  token_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  family_id   uuid NOT NULL,
  token_hash  char(64) NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_refresh_tokens_family ON refresh_tokens (family_id);

CREATE TABLE password_reset_tokens (
  token_hash  char(64) PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  purpose     varchar(20) NOT NULL CHECK (purpose IN ('reset','activation')),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE households (
  household_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_code     varchar(16)  NOT NULL UNIQUE,
  head_of_household  varchar(120) NOT NULL,
  -- NFR-15: the identity number is never stored, only a keyed hash used for the duplicate check.
  id_number_hash     char(64)     NOT NULL,
  contact_number     varchar(20),
  address_line       varchar(200) NOT NULL,
  suburb             varchar(80)  NOT NULL,
  home_site_id       uuid         NOT NULL REFERENCES distribution_sites(site_id),
  status             varchar(24)  NOT NULL DEFAULT 'PendingVerification'
                     CHECK (status IN ('Draft','PendingVerification','Active','Suspended','Archived')),
  status_reason      varchar(300),
  registered_by      uuid         NOT NULL REFERENCES users(user_id),
  verified_by        uuid         REFERENCES users(user_id),
  registered_on      timestamptz  NOT NULL DEFAULT now(),
  verified_on        timestamptz,
  last_collected_at  timestamptz,
  updated_at         timestamptz  NOT NULL DEFAULT now()
);
-- BR-01: one live registration per person across every site.
CREATE UNIQUE INDEX ux_households_id_hash_live ON households (id_number_hash) WHERE status <> 'Archived';
CREATE INDEX ix_households_suburb_status ON households (suburb, status);
CREATE INDEX ix_households_site_status ON households (home_site_id, status);

CREATE TABLE household_members (
  member_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id    uuid NOT NULL REFERENCES households(household_id) ON DELETE CASCADE,
  first_name      varchar(80) NOT NULL,
  -- Age band rather than date of birth: enough for reporting, less personal information held.
  age_band        varchar(20) NOT NULL CHECK (age_band IN ('0-5','6-12','13-17','18-59','60+')),
  dependant_type  varchar(30) NOT NULL CHECK (dependant_type IN ('Self','Spouse','Child','Elderly','Other'))
);
CREATE INDEX ix_household_members_household ON household_members (household_id);

CREATE TABLE distribution_events (
  event_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id          uuid    NOT NULL REFERENCES distribution_sites(site_id),
  scheduled_date   date    NOT NULL,
  start_time       time    NOT NULL,
  end_time         time    NOT NULL,
  planned_parcels  integer NOT NULL CHECK (planned_parcels > 0),
  min_volunteers   integer NOT NULL DEFAULT 2 CHECK (min_volunteers >= 0),
  status           varchar(20) NOT NULL DEFAULT 'Planned'
                   CHECK (status IN ('Planned','Stocked','Open','Closed','Reconciled','Cancelled')),
  physical_count   integer CHECK (physical_count >= 0),
  variance         integer,
  variance_reason  varchar(500),
  cancel_reason    varchar(300),
  created_by       uuid REFERENCES users(user_id),
  opened_at        timestamptz,
  closed_at        timestamptz,
  reconciled_at    timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_events_time_window CHECK (end_time > start_time)
);
CREATE INDEX ix_events_site_date ON distribution_events (site_id, scheduled_date);
CREATE INDEX ix_events_date ON distribution_events (scheduled_date);

CREATE TABLE collections (
  collection_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         uuid NOT NULL REFERENCES distribution_events(event_id),
  household_id     uuid NOT NULL REFERENCES households(household_id),
  verified_by      uuid NOT NULL REFERENCES users(user_id),
  collected_at     timestamptz NOT NULL DEFAULT now(),
  parcel_size      varchar(10) NOT NULL CHECK (parcel_size IN ('Small','Medium','Large')),
  is_override      boolean NOT NULL DEFAULT false,
  override_reason  varchar(300),
  CONSTRAINT ck_collections_override_reason CHECK (NOT is_override OR override_reason IS NOT NULL)
);
-- BR-04 enforced by the database, so it holds even when two devices submit at the same instant.
-- Supervisor overrides are recorded separately and are exempt.
CREATE UNIQUE INDEX ux_collections_once_per_event ON collections (event_id, household_id) WHERE NOT is_override;
CREATE INDEX ix_collections_event ON collections (event_id);
CREATE INDEX ix_collections_household ON collections (household_id, collected_at DESC);

CREATE TABLE volunteer_shifts (
  shift_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id           uuid NOT NULL REFERENCES distribution_events(event_id) ON DELETE CASCADE,
  starts_at          timestamptz NOT NULL,
  ends_at            timestamptz NOT NULL,
  volunteers_needed  integer NOT NULL CHECK (volunteers_needed > 0),
  notes              varchar(200),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_shifts_window CHECK (ends_at > starts_at)
);
CREATE INDEX ix_shifts_event ON volunteer_shifts (event_id);
CREATE INDEX ix_shifts_starts ON volunteer_shifts (starts_at);

CREATE TABLE shift_assignments (
  assignment_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id       uuid NOT NULL REFERENCES volunteer_shifts(shift_id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(user_id),
  status         varchar(20) NOT NULL DEFAULT 'Assigned' CHECK (status IN ('Assigned','Withdrawn','CheckedIn')),
  assigned_at    timestamptz NOT NULL DEFAULT now(),
  withdrawn_at   timestamptz,
  checked_in_at  timestamptz,
  hours_served   numeric(5,2),
  CONSTRAINT ux_shift_assignments_once UNIQUE (shift_id, user_id)
);
CREATE INDEX ix_shift_assignments_user ON shift_assignments (user_id);

CREATE SEQUENCE donation_receipt_seq START 1;

CREATE TABLE donations (
  donation_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  donor_id        uuid NOT NULL REFERENCES donors(donor_id),
  donation_type   varchar(20) NOT NULL CHECK (donation_type IN ('Cash','InKind')),
  monetary_value  numeric(12,2) NOT NULL DEFAULT 0 CHECK (monetary_value >= 0),
  received_on     date NOT NULL,
  receipt_number  varchar(30) NOT NULL UNIQUE,
  notes           varchar(300),
  captured_by     uuid NOT NULL REFERENCES users(user_id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_donations_donor ON donations (donor_id, received_on DESC);

CREATE TABLE stock_items (
  stock_item_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_name        varchar(100) NOT NULL UNIQUE,
  category         varchar(50)  NOT NULL,
  unit_of_measure  varchar(20)  NOT NULL,
  reorder_level    numeric(10,2) NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE stock_batches (
  batch_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_item_id       uuid NOT NULL REFERENCES stock_items(stock_item_id),
  donation_id         uuid REFERENCES donations(donation_id),
  quantity_received   numeric(10,2) NOT NULL CHECK (quantity_received > 0),
  quantity_remaining  numeric(10,2) NOT NULL,
  expiry_date         date,
  received_on         date NOT NULL DEFAULT current_date,
  -- Stock can never go negative, even under concurrent issue.
  CONSTRAINT ck_batches_remaining CHECK (quantity_remaining >= 0 AND quantity_remaining <= quantity_received)
);
CREATE INDEX ix_batches_item_expiry ON stock_batches (stock_item_id, expiry_date) WHERE quantity_remaining > 0;
CREATE INDEX ix_batches_donation ON stock_batches (donation_id);

CREATE TABLE stock_movements (
  movement_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id       uuid NOT NULL REFERENCES stock_batches(batch_id),
  event_id       uuid REFERENCES distribution_events(event_id),
  collection_id  uuid REFERENCES collections(collection_id),
  recorded_by    uuid NOT NULL REFERENCES users(user_id),
  movement_type  varchar(20) NOT NULL CHECK (movement_type IN ('Receipt','Issue','WriteOff','Adjustment')),
  quantity       numeric(10,2) NOT NULL,
  reason         varchar(300),
  moved_on       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_movements_batch ON stock_movements (batch_id);
CREATE INDEX ix_movements_event ON stock_movements (event_id);

-- Parcel bill of materials per size (BR-05). The sizing rule itself lives in the strategy classes.
CREATE TABLE parcel_components (
  parcel_size    varchar(10) NOT NULL CHECK (parcel_size IN ('Small','Medium','Large')),
  stock_item_id  uuid NOT NULL REFERENCES stock_items(stock_item_id),
  quantity       numeric(10,2) NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (parcel_size, stock_item_id)
);

CREATE TABLE audit_log (
  audit_id     bigserial PRIMARY KEY,
  user_id      uuid REFERENCES users(user_id),
  entity_name  varchar(60) NOT NULL,
  entity_id    uuid,
  action       varchar(30) NOT NULL,
  details      jsonb,
  ip_address   varchar(45),
  occurred_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_audit_occurred ON audit_log (occurred_at DESC);
CREATE INDEX ix_audit_entity ON audit_log (entity_name, entity_id);

-- NFR-17 / BR-09: the audit log is append-only. Enforced in the database so that no code path,
-- including a compromised one, can rewrite history.
CREATE FUNCTION audit_log_is_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END
$$;

CREATE TRIGGER trg_audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();

CREATE TRIGGER trg_audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_is_append_only();
