-- ══════════════════════════════════════════════════════════════
-- CENTRAL — Fase 4B: equipo con roles, quién hizo qué y paginación (28-nov-2026)
--
-- server.js hace ESTO MISMO automáticamente al arrancar (initDB → ensureTeamSchema + runTeamBackfill en backend/equipo.js).
-- Este archivo es para revisarlo / respaldarlo / aplicarlo a mano. HAZ RESPALDO ANTES (backend/scripts/respaldo-produccion.ps1).
--
-- Cómo se aplica: SOLO DDL, PARTIDO en transacciones cortas, en este orden (el mismo que usa el servidor), todas bajo un advisory
-- lock global (72616106) y cada una con lock_timeout de 2 s y hasta 4 reintentos:
--   PASO 1  team_users y sus índices (tabla nueva, vacía)
--   PASO 2  una transacción POR TABLA con sus columnas *_user_id (NULL: instantáneo) y sus FK NOT VALID (no recorren la tabla)
--   PASO 3  AL FINAL y en su propia transacción: lo que toca tenants (columna, función del espejo y triggers)
--   PASO 4  relleno del dueño de cada negocio (idempotente)
-- Antes de cada paso comprueba si ya existe: en un arranque normal no ejecuta ningún DDL. Si el esquema sigue incompleto tras los
-- reintentos el servidor sale con error y Railway conserva la versión anterior. Las FK se validan en segundo plano tras listen Y
-- DESPUÉS de crear los índices, en serie y con el mismo advisory lock (validateTeamFks).
-- Defensa: la base se comparte con Kisses (prefijo kp_). Si team_users ya existe SIN las columnas de CENTRAL, o un índice
-- con nuestro nombre es de otra tabla, el servidor NO arranca (process.exit(1)).
--
-- Qué hace
--   1) team_users: usuarios del negocio (owner | manager | seller). Correo ÚNICO EN TODA LA BASE (lower(email)), así que no
--      puede repetirse entre negocios ni chocar con el correo de acceso de otro dueño. Un solo owner por negocio.
--   2) tenants.team_over_limit_since: marca de «el negocio tiene más usuarios que su plan» (plazo de 3 días para elegir).
--   3) Dueño: tenants.email y tenants.password_hash siguen siendo la FUENTE de las credenciales del dueño; la fila owner de
--      team_users es un ESPEJO que mantiene el trigger team_sync_owner (INSERT y UPDATE de email/clave/nombre en tenants).
--      Un cambio de clave o de correo del dueño sube su token_version. El relleno crea el dueño de cada negocio que no lo tenga.
--   4) «Quién hizo qué»: columnas *_user_id (NULL = antiguo, se muestra «Dueño») en orders, payments (creó y anuló), refunds,
--      credit_notes, expenses (creó y anuló), cash_closings (cerró y reabrió), stock_movements y order_events.
--      Las columnas de texto created_by que ya existían se mantienen.
--   5) Índices (en segundo plano, CONCURRENTLY, con advisory lock; ver BACKGROUND_INDEXES en server.js):
--        orders_tenant_created_desc_idx   (tenant_id, created_at DESC, id DESC)   lista de pedidos por cursor
--        orders_tenant_status_created_idx (tenant_id, delivery_status, created_at DESC, id DESC)   pestañas por estado
--        orders_tenant_delivery_date_idx  (tenant_id, delivery_date) WHERE kind='order' AND delivery_status NOT IN ('cancelled','delivered')
--        conversations_tenant_last_idx    (tenant_id, last_message_at DESC NULLS LAST, wa_id)
--        messages_tenant_wa_time_idx      (tenant_id, wa_id, time DESC, id DESC)
--        <tabla>_<columna>_idx            parcial WHERE <columna> IS NOT NULL, uno por cada *_user_id
--      (orders_tenant_client_idx (tenant_id, client_id) YA existe desde initDB —migración 2026-11-17—: no se vuelve a crear.)
-- ══════════════════════════════════════════════════════════════

-- ── PASO 1: team_users ───────────────────────────────────────────────
BEGIN;
SET LOCAL lock_timeout = '2s';
CREATE TABLE IF NOT EXISTS team_users (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                     TEXT NOT NULL,
  email                    TEXT NOT NULL,                 -- siempre en minúsculas
  password_hash            TEXT NOT NULL,
  role                     TEXT NOT NULL CHECK (role IN ('owner','manager','seller')),
  active                   BOOLEAN NOT NULL DEFAULT true,
  must_change_password     BOOLEAN NOT NULL DEFAULT false, -- contraseña temporal
  temp_password_expires_at TIMESTAMPTZ,                    -- 7 días
  token_version            INTEGER NOT NULL DEFAULT 0,     -- subirlo cierra todas las sesiones de ese usuario
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  deactivated_at           TIMESTAMPTZ,
  last_login_at            TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS team_users_email_lower_uniq ON team_users (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS team_users_one_owner_uniq   ON team_users (tenant_id) WHERE role = 'owner';
CREATE INDEX        IF NOT EXISTS team_users_tenant_idx       ON team_users (tenant_id, active);
COMMIT;

-- ── PASO 2: «quién hizo qué», UNA TRANSACCIÓN POR TABLA (NULL = anterior a la Fase 4B). FK NOT VALID: no recorre la tabla. ──
-- Cada FK se llama <tabla>_<columna>_fk y es ON DELETE SET NULL.
BEGIN; SET LOCAL lock_timeout = '2s';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS created_by_user_id UUID;
ALTER TABLE orders ADD CONSTRAINT orders_created_by_user_id_fk FOREIGN KEY (created_by_user_id) REFERENCES team_users(id) ON DELETE SET NULL NOT VALID;
COMMIT;
BEGIN; SET LOCAL lock_timeout = '2s';
ALTER TABLE payments ADD COLUMN IF NOT EXISTS created_by_user_id UUID;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS voided_by_user_id UUID;
ALTER TABLE payments ADD CONSTRAINT payments_created_by_user_id_fk FOREIGN KEY (created_by_user_id) REFERENCES team_users(id) ON DELETE SET NULL NOT VALID;
ALTER TABLE payments ADD CONSTRAINT payments_voided_by_user_id_fk FOREIGN KEY (voided_by_user_id) REFERENCES team_users(id) ON DELETE SET NULL NOT VALID;
COMMIT;
BEGIN; SET LOCAL lock_timeout = '2s';
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS created_by_user_id UUID;
ALTER TABLE refunds ADD CONSTRAINT refunds_created_by_user_id_fk FOREIGN KEY (created_by_user_id) REFERENCES team_users(id) ON DELETE SET NULL NOT VALID;
COMMIT;
BEGIN; SET LOCAL lock_timeout = '2s';
ALTER TABLE credit_notes ADD COLUMN IF NOT EXISTS created_by_user_id UUID;
ALTER TABLE credit_notes ADD CONSTRAINT credit_notes_created_by_user_id_fk FOREIGN KEY (created_by_user_id) REFERENCES team_users(id) ON DELETE SET NULL NOT VALID;
COMMIT;
BEGIN; SET LOCAL lock_timeout = '2s';
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS created_by_user_id UUID;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS voided_by_user_id UUID;
ALTER TABLE expenses ADD CONSTRAINT expenses_created_by_user_id_fk FOREIGN KEY (created_by_user_id) REFERENCES team_users(id) ON DELETE SET NULL NOT VALID;
ALTER TABLE expenses ADD CONSTRAINT expenses_voided_by_user_id_fk FOREIGN KEY (voided_by_user_id) REFERENCES team_users(id) ON DELETE SET NULL NOT VALID;
COMMIT;
BEGIN; SET LOCAL lock_timeout = '2s';
ALTER TABLE cash_closings ADD COLUMN IF NOT EXISTS closed_by_user_id UUID;
ALTER TABLE cash_closings ADD COLUMN IF NOT EXISTS reopened_by_user_id UUID;
ALTER TABLE cash_closings ADD CONSTRAINT cash_closings_closed_by_user_id_fk FOREIGN KEY (closed_by_user_id) REFERENCES team_users(id) ON DELETE SET NULL NOT VALID;
ALTER TABLE cash_closings ADD CONSTRAINT cash_closings_reopened_by_user_id_fk FOREIGN KEY (reopened_by_user_id) REFERENCES team_users(id) ON DELETE SET NULL NOT VALID;
COMMIT;
BEGIN; SET LOCAL lock_timeout = '2s';
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS created_by_user_id UUID;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_created_by_user_id_fk FOREIGN KEY (created_by_user_id) REFERENCES team_users(id) ON DELETE SET NULL NOT VALID;
COMMIT;
BEGIN; SET LOCAL lock_timeout = '2s';
ALTER TABLE order_events ADD COLUMN IF NOT EXISTS created_by_user_id UUID;
ALTER TABLE order_events ADD CONSTRAINT order_events_created_by_user_id_fk FOREIGN KEY (created_by_user_id) REFERENCES team_users(id) ON DELETE SET NULL NOT VALID;
COMMIT;
-- (si una columna o FK ya existe, esa línea falla y la transacción se revierte: en el servidor cada una se comprueba antes;
--  a mano, quita de aquí lo que ya exista)

-- ── PASO 3: lo que toca tenants, AL FINAL y en su propia transacción ──
BEGIN;
SET LOCAL lock_timeout = '2s';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS team_over_limit_since TIMESTAMPTZ;

-- Espejo del dueño: cualquier escritura en tenants llega a su fila owner
CREATE OR REPLACE FUNCTION team_sync_owner() RETURNS trigger AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO team_users (tenant_id, name, email, password_hash, role)
    VALUES (NEW.id, COALESCE(NULLIF(btrim(NEW.full_name), ''), NEW.business_name), lower(btrim(NEW.email)), NEW.password_hash, 'owner');
  ELSE
    UPDATE team_users SET
      email = lower(btrim(NEW.email)),
      password_hash = NEW.password_hash,
      name = COALESCE(NULLIF(btrim(NEW.full_name), ''), NEW.business_name),
      token_version = token_version + CASE WHEN NEW.password_hash IS DISTINCT FROM OLD.password_hash
                                           OR lower(btrim(NEW.email)) IS DISTINCT FROM lower(btrim(OLD.email)) THEN 1 ELSE 0 END
    WHERE tenant_id = NEW.id AND role = 'owner';
  END IF;
  RETURN NEW;
END
$fn$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS tenants_team_sync_ins ON tenants;
CREATE TRIGGER tenants_team_sync_ins AFTER INSERT ON tenants FOR EACH ROW EXECUTE PROCEDURE team_sync_owner();
DROP TRIGGER IF EXISTS tenants_team_sync_upd ON tenants;
CREATE TRIGGER tenants_team_sync_upd AFTER UPDATE OF email, password_hash, full_name, business_name ON tenants
  FOR EACH ROW WHEN (OLD.email IS DISTINCT FROM NEW.email OR OLD.password_hash IS DISTINCT FROM NEW.password_hash
    OR OLD.full_name IS DISTINCT FROM NEW.full_name OR OLD.business_name IS DISTINCT FROM NEW.business_name)
  EXECUTE PROCEDURE team_sync_owner();
COMMIT;

-- ── PASO 4: relleno (idempotente, rápido): un dueño por negocio que aún no lo tenga ──
INSERT INTO team_users (tenant_id, name, email, password_hash, role)
SELECT t.id, COALESCE(NULLIF(btrim(t.full_name), ''), t.business_name), lower(btrim(t.email)), t.password_hash, 'owner'
FROM tenants t WHERE NOT EXISTS (SELECT 1 FROM team_users u WHERE u.tenant_id = t.id AND u.role = 'owner')
ON CONFLICT DO NOTHING;

-- ── Índices en segundo plano (fuera de transacción; el servidor los crea solo tras listen): ──
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_tenant_created_desc_idx ON orders (tenant_id, created_at DESC, id DESC);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_tenant_status_created_idx ON orders (tenant_id, delivery_status, created_at DESC, id DESC);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_tenant_delivery_date_idx ON orders (tenant_id, delivery_date) WHERE kind = 'order' AND delivery_status NOT IN ('cancelled', 'delivered');
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS conversations_tenant_last_idx ON conversations (tenant_id, last_message_at DESC NULLS LAST, wa_id);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_tenant_wa_time_idx ON messages (tenant_id, wa_id, time DESC, id DESC);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_created_by_user_id_idx ON orders (created_by_user_id) WHERE created_by_user_id IS NOT NULL;
--   (y el mismo patrón para payments.created_by_user_id, payments.voided_by_user_id, refunds, credit_notes, expenses (2),
--    cash_closings (2), stock_movements y order_events)

-- ── Después de los índices: validar las FK, UNA A UNA (con lock_timeout corto; no bloquea lecturas ni escrituras) ──
-- ALTER TABLE orders VALIDATE CONSTRAINT orders_created_by_user_id_fk;   -- y las demás *_user_id_fk

-- Revisión tras desplegar:
--   SELECT role, count(*) FROM team_users GROUP BY 1;                       -- un owner por negocio
--   SELECT count(*) FROM tenants t WHERE NOT EXISTS (SELECT 1 FROM team_users u WHERE u.tenant_id = t.id AND u.role = 'owner');  -- 0
--   SELECT conname, convalidated FROM pg_constraint WHERE conname LIKE '%_user_id_fk';   -- todas true
