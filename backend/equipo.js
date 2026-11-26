// Fase 4B — equipo con roles y registro de quién hizo qué.
// Esquema (solo DDL, idempotente; SQL documentado en migrations/2026-11-28-equipo.sql), relleno del dueño, roles y
// límites por plan. Lo comparten server.js, demo-seed.js y las pruebas.
//
// Decisión de diseño (sincronía tenants ↔ dueño): tenants.email y tenants.password_hash siguen siendo la FUENTE de las
// credenciales del dueño (el registro, el panel admin, la recuperación de clave y el perfil ya escriben ahí). La fila
// owner de team_users es un ESPEJO que mantiene un trigger de la base (team_sync_owner): cualquier escritura en tenants
// —de esta o de la versión anterior del servidor durante el solape del despliegue— llega al dueño sin que haya que
// acordarse de ella en cada ruta. Un cambio de clave o de correo del dueño sube su token_version (cierra sus sesiones
// nuevas). Los demás usuarios solo viven en team_users.
'use strict';

const crypto = require('crypto');
const { hasColumn, hasRelation, ensureOwnIndex } = require('./pagos');

const TEAM_DDL_LOCK_KEY = 72616106;

const ROLES = ['owner', 'manager', 'seller'];
const ROLE_RANK = { seller: 1, manager: 2, owner: 3 };
const ROLE_LABEL = { owner: 'Dueño', manager: 'Encargado', seller: 'Vendedor' };
const PLAN_USER_LIMIT = { basic: 1, pro: 3, business: 10 }; // cuenta al dueño
const OVER_LIMIT_GRACE_DAYS = 3;
const TEMP_PASSWORD_DAYS = 7;
const planLimit = (plan) => PLAN_USER_LIMIT[plan] || 1;

// Columnas propias de CENTRAL: si una tabla team_users ya existe SIN ellas es de otra aplicación (la base se comparte con
// Kisses, que usa el prefijo kp_). Nunca se escribe en ella ni se sigue arrancando.
const TEAM_TABLE_COLS = { team_users: ['tenant_id', 'email', 'password_hash', 'role', 'token_version'] };
async function assertTeamTablesAreOurs(db) {
  for (const [table, cols] of Object.entries(TEAM_TABLE_COLS)) {
    if (!(await hasRelation(db, table))) continue;
    for (const col of cols) {
      if (!(await hasColumn(db, table, col))) {
        console.error(`❌ La tabla ${table} ya existe en la base pero NO es de CENTRAL (le falta la columna ${col}). ` +
          'Se detiene el arranque para no escribir en datos ajenos: renombra esa tabla o cambia el nombre en equipo.js.');
        process.exit(1);
      }
    }
  }
}

// [tabla, columna] que apuntan a team_users (quién hizo qué). NULL = antiguo / dueño anterior a la Fase 4B.
const USER_FK_COLUMNS = [
  ['orders', 'created_by_user_id'],
  ['payments', 'created_by_user_id'], ['payments', 'voided_by_user_id'],
  ['refunds', 'created_by_user_id'],
  ['credit_notes', 'created_by_user_id'],
  ['expenses', 'created_by_user_id'], ['expenses', 'voided_by_user_id'],
  ['cash_closings', 'closed_by_user_id'], ['cash_closings', 'reopened_by_user_id'],
  ['stock_movements', 'created_by_user_id'],
  ['order_events', 'created_by_user_id'],
];
const fkName = (table, col) => `${table}_${col}_fk`;

const OWNER_SYNC_FN = `
CREATE FUNCTION team_sync_owner() RETURNS trigger AS $fn$
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
$fn$ LANGUAGE plpgsql`;

// Solo DDL, PARTIDO en transacciones cortas (cada una con lock_timeout de 2 s y hasta 4 reintentos), todas bajo UN advisory lock global
// (sesión) para que dos réplicas no se pisen. Orden: (1) team_users y sus índices (tabla nueva, vacía); (2) por cada tabla existente,
// sus columnas «quién hizo qué» y sus FK NOT VALID, cada tabla en su propia transacción (un bloqueo de pedidos no frena a pagos);
// (3) AL FINAL, en su propia transacción, lo que toca tenants: la columna, la función del espejo y los triggers (tenants es la tabla
// más usada: su bloqueo es el último y el más corto). Antes de abrir cada transacción se comprueba si hace falta: en un arranque
// normal no se ejecuta ningún DDL. El relleno de tenants (runTeamBackfill) lo llama server.js después. Devuelve true si el esquema quedó completo.
const STEP_LOCK_TIMEOUT = '2s', STEP_ATTEMPTS = 4;
async function runDdlStep(pool, label, fn) {
  let lastErr;
  for (let attempt = 1; attempt <= STEP_ATTEMPTS; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL lock_timeout = '${STEP_LOCK_TIMEOUT}'`);
      await fn(client);
      await client.query('COMMIT');
      return true;
    } catch (err) {
      lastErr = err;
      await client.query('ROLLBACK').catch(() => {});
    } finally {
      client.release();
    }
    if (attempt < STEP_ATTEMPTS) await new Promise(r => setTimeout(r, 400 * attempt));
  }
  console.error(`⚠️  Migración del equipo (${label}):`, lastErr && lastErr.message);
  return false;
}
const hasConstraint = async (db, table, name) => !!(await db.query(
  'SELECT 1 FROM pg_constraint WHERE conname = $1 AND conrelid = to_regclass($2)', [name, 'public.' + table])).rows[0];

async function ensureTeamSchema(pool) {
  await assertTeamTablesAreOurs(pool); // antes de tocar nada
  const lock = await pool.connect();
  try {
    // Lock global de sesión (espera hasta 30 s a que otra réplica termine). Se suelta al final, pase lo que pase.
    await lock.query(`SET lock_timeout = '30s'`);
    await lock.query('SELECT pg_advisory_lock($1)', [TEAM_DDL_LOCK_KEY]);
    await lock.query('RESET lock_timeout');
    try {
      // 1) team_users (tabla nueva)
      if (!(await hasRelation(pool, 'team_users'))) {
        await runDdlStep(pool, 'team_users', async (c) => {
          await c.query(`
            CREATE TABLE IF NOT EXISTS team_users (
              id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
              tenant_id                UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
              name                     TEXT NOT NULL,
              email                    TEXT NOT NULL,
              password_hash            TEXT NOT NULL,
              role                     TEXT NOT NULL CHECK (role IN ('owner','manager','seller')),
              active                   BOOLEAN NOT NULL DEFAULT true,
              must_change_password     BOOLEAN NOT NULL DEFAULT false,
              temp_password_expires_at TIMESTAMPTZ,
              token_version            INTEGER NOT NULL DEFAULT 0,
              created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
              deactivated_at           TIMESTAMPTZ,
              last_login_at            TIMESTAMPTZ
            )`);
        });
      }
      // Tabla NUEVA (vacía): sus índices se crean aquí, no en BACKGROUND_INDEXES
      if (await hasRelation(pool, 'team_users')) {
        await assertTeamTablesAreOurs(pool);
        await runDdlStep(pool, 'índices de team_users', async (c) => {
          await ensureOwnIndex(c, 'team_users_email_lower_uniq', 'team_users',
            'CREATE UNIQUE INDEX team_users_email_lower_uniq ON team_users (lower(email))');
          await ensureOwnIndex(c, 'team_users_one_owner_uniq', 'team_users',
            `CREATE UNIQUE INDEX team_users_one_owner_uniq ON team_users (tenant_id) WHERE role = 'owner'`);
          await ensureOwnIndex(c, 'team_users_tenant_idx', 'team_users',
            'CREATE INDEX team_users_tenant_idx ON team_users (tenant_id, active)');
        });
      }
      // 2) Columnas «quién hizo qué»: NULL (instantáneo, solo catálogo). La FK se añade NOT VALID (no recorre la tabla) y se valida
      // en segundo plano tras listen (validateTeamFks). Una transacción por tabla.
      const byTable = new Map();
      for (const [t, col] of USER_FK_COLUMNS) byTable.set(t, [...(byTable.get(t) || []), col]);
      for (const [table, cols] of byTable) {
        let needed = false;
        for (const col of cols) if (!(await hasColumn(pool, table, col)) || !(await hasConstraint(pool, table, fkName(table, col)))) needed = true;
        if (!needed) continue;
        await runDdlStep(pool, table, async (c) => {
          for (const col of cols) {
            if (!(await hasColumn(c, table, col))) await c.query(`ALTER TABLE ${table} ADD COLUMN ${col} UUID`);
            if (!(await hasConstraint(c, table, fkName(table, col)))) {
              await c.query(`ALTER TABLE ${table} ADD CONSTRAINT ${fkName(table, col)} FOREIGN KEY (${col}) REFERENCES team_users(id) ON DELETE SET NULL NOT VALID`);
            }
          }
        });
      }
      // 3) Lo que toca tenants, AL FINAL y en su propia transacción: la columna, la función del espejo y los triggers
      const trigCount = async (db) => (await db.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname IN ('tenants_team_sync_ins','tenants_team_sync_upd')
        AND tgrelid = to_regclass('public.tenants') AND NOT tgisinternal`)).rows[0].n;
      const hasFn = async (db) => !!(await db.query(`SELECT 1 FROM pg_proc WHERE proname = 'team_sync_owner' AND pronamespace = 'public'::regnamespace`)).rows[0];
      if (!(await hasColumn(pool, 'tenants', 'team_over_limit_since')) || !(await hasFn(pool)) || (await trigCount(pool)) < 2) {
        await runDdlStep(pool, 'tenants', async (c) => {
          if (!(await hasColumn(c, 'tenants', 'team_over_limit_since'))) await c.query('ALTER TABLE tenants ADD COLUMN team_over_limit_since TIMESTAMPTZ');
          if (!(await hasFn(c))) await c.query(OWNER_SYNC_FN);
          for (const [name, ddl] of [
            ['tenants_team_sync_ins', `CREATE TRIGGER tenants_team_sync_ins AFTER INSERT ON tenants FOR EACH ROW EXECUTE PROCEDURE team_sync_owner()`],
            ['tenants_team_sync_upd', `CREATE TRIGGER tenants_team_sync_upd AFTER UPDATE OF email, password_hash, full_name, business_name ON tenants
               FOR EACH ROW WHEN (OLD.email IS DISTINCT FROM NEW.email OR OLD.password_hash IS DISTINCT FROM NEW.password_hash
                 OR OLD.full_name IS DISTINCT FROM NEW.full_name OR OLD.business_name IS DISTINCT FROM NEW.business_name)
               EXECUTE PROCEDURE team_sync_owner()`],
          ]) {
            const { rows } = await c.query('SELECT 1 FROM pg_trigger WHERE tgname = $1 AND tgrelid = to_regclass($2) AND NOT tgisinternal', [name, 'public.tenants']);
            if (!rows[0]) await c.query(ddl);
          }
        });
      }
    } finally {
      await lock.query('SELECT pg_advisory_unlock($1)', [TEAM_DDL_LOCK_KEY]).catch(() => {});
    }
  } catch (err) {
    console.error('⚠️  Migración del equipo:', err.message);
  } finally {
    lock.release();
  }
  try {
    if (!(await hasColumn(pool, 'tenants', 'team_over_limit_since'))) return false;
    if (!(await hasRelation(pool, 'team_users'))) return false;
    await assertTeamTablesAreOurs(pool);
    for (const [t, c] of USER_FK_COLUMNS) if (!(await hasColumn(pool, t, c))) return false;
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname IN ('tenants_team_sync_ins','tenants_team_sync_upd')
      AND tgrelid = to_regclass('public.tenants') AND NOT tgisinternal`);
    return rows[0].n === 2;
  } catch (err) {
    console.error('❌ Comprobación del esquema del equipo:', err.message);
    return false;
  }
}

// VALIDATE de las FK NOT VALID: se hace DESPUÉS de listen y de ensureIndexes (los índices de las columnas ya existen), EN SERIE y bajo el
// advisory lock global del equipo (una réplica a la vez). Recorre cada tabla con un bloqueo que no impide leer ni escribir; cada VALIDATE
// espera como mucho 2 s el bloqueo. Tolerante a fallos: se reintenta en el siguiente arranque; mientras tanto la FK vigila las filas nuevas.
async function validateTeamFks(pool) {
  const client = await pool.connect();
  let locked = false;
  try {
    locked = (await client.query('SELECT pg_try_advisory_lock($1) AS ok', [TEAM_DDL_LOCK_KEY])).rows[0].ok;
    if (!locked) return;
    await client.query(`SET lock_timeout = '${STEP_LOCK_TIMEOUT}'`);
    for (const [table, col] of USER_FK_COLUMNS) {
      try {
        const { rows } = await client.query(
          'SELECT convalidated FROM pg_constraint WHERE conname = $1 AND conrelid = to_regclass($2)', [fkName(table, col), 'public.' + table]);
        if (rows[0] && !rows[0].convalidated) await client.query(`ALTER TABLE ${table} VALIDATE CONSTRAINT ${fkName(table, col)}`);
      } catch (err) { console.error(`⚠️  VALIDATE ${fkName(table, col)}:`, err.message); }
    }
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1)', [TEAM_DDL_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

// Relleno idempotente y rápido (tenants es pequeña): un dueño por negocio que aún no lo tenga, y corrige el espejo si algo
// escribió en tenants cuando el trigger todavía no existía. Sin cambios no escribe nada.
async function runTeamBackfill(pool) {
  const ins = await pool.query(`
    INSERT INTO team_users (tenant_id, name, email, password_hash, role)
    SELECT t.id, COALESCE(NULLIF(btrim(t.full_name), ''), t.business_name), lower(btrim(t.email)), t.password_hash, 'owner'
    FROM tenants t WHERE NOT EXISTS (SELECT 1 FROM team_users u WHERE u.tenant_id = t.id AND u.role = 'owner')
    ON CONFLICT DO NOTHING`);
  const { rows: missing } = await pool.query(`
    SELECT t.id, t.email FROM tenants t WHERE NOT EXISTS (SELECT 1 FROM team_users u WHERE u.tenant_id = t.id AND u.role = 'owner') LIMIT 20`);
  for (const m of missing) console.error(`❌ El negocio ${m.id} (${m.email}) no tiene usuario dueño: su correo choca con otro usuario del equipo. Revísalo a mano.`);
  const upd = await pool.query(`
    UPDATE team_users u SET email = lower(btrim(t.email)), password_hash = t.password_hash, token_version = u.token_version + 1
    FROM tenants t WHERE u.tenant_id = t.id AND u.role = 'owner'
      AND (u.email <> lower(btrim(t.email)) OR u.password_hash <> t.password_hash)`);
  return { created: ins.rowCount, resynced: upd.rowCount };
}

// ── Roles ──────────────────────────────────────────────────────
// Rol MÍNIMO por ruta (cada rol incluye a los de abajo: owner ⊃ manager ⊃ seller). Lista blanca: una ruta con requireAuth
// que no esté aquí solo la puede usar el dueño (y la prueba e2e `equipo-roles` falla hasta que se clasifique).
// Reglas finas dentro de la ruta (no cambian la clasificación de aquí):
//  · PUT /api/tenant/profile: el correo de acceso solo lo cambia el dueño.
//  · PUT /api/tenant/settings: la moneda base solo la cambia el dueño.
//  · GET /api/catalog y GET /api/stock: al vendedor se le quita el costo.
const ROUTE_MIN_ROLE = {
  // Cuenta
  'GET /api/tenant/profile': 'seller', 'PUT /api/tenant/password': 'seller', 'PUT /api/tenant/profile': 'manager',
  'PUT /api/tenant/whatsapp': 'owner', 'GET /api/tenant/test-whatsapp': 'owner',
  'GET /api/tenant/auto-reply': 'manager', 'PUT /api/tenant/auto-reply': 'manager',
  'GET /api/tenant/settings': 'seller', 'PUT /api/tenant/settings': 'manager',
  // Chats y mensajes
  'GET /api/conversations': 'seller', 'GET /api/conversations/:waId': 'seller', 'GET /api/media/:mediaId': 'seller',
  'POST /api/send': 'seller', 'POST /api/send-media': 'seller', 'POST /api/send-ticket': 'seller', 'POST /api/send-instagram': 'seller',
  // Pedidos y presupuestos
  'GET /api/orders': 'seller', 'POST /api/orders': 'seller', 'PATCH /api/orders/:id': 'seller', 'POST /api/orders/:id/convert': 'seller',
  'POST /api/orders/:id/cancel': 'manager', 'POST /api/orders/:id/returns': 'manager', 'GET /api/orders/:id/returns': 'seller',
  'GET /api/orders/:id/events': 'seller', 'GET /api/clients/:id/credit': 'seller',
  // Cobros
  'GET /api/orders/:id/payments': 'seller', 'POST /api/orders/:id/payments': 'seller', 'POST /api/payments/:id/void': 'manager',
  'GET /api/payments': 'seller',
  // Gastos y caja
  'GET /api/expenses': 'manager', 'POST /api/expenses': 'manager', 'POST /api/expenses/:id/void': 'manager',
  'GET /api/cash': 'manager', 'GET /api/cash/:day': 'manager', 'POST /api/cash/:day/close': 'manager',
  'GET /api/cash-closed': 'seller', 'POST /api/cash/:day/reopen': 'owner',
  // Informes
  'GET /api/reports': 'manager', 'GET /api/reports/profit': 'manager', 'GET /api/reports/receivables': 'manager',
  // Clientes
  'GET /api/clients': 'seller', 'POST /api/clients': 'seller', 'PATCH /api/clients/:id': 'seller', 'DELETE /api/clients/:id': 'manager',
  // Catálogo y existencias
  'GET /api/catalog': 'seller', 'POST /api/catalog': 'manager', 'PATCH /api/catalog/:id': 'manager', 'DELETE /api/catalog/:id': 'manager',
  'GET /api/stock': 'seller', 'POST /api/stock/adjust': 'manager', 'GET /api/stock/movements': 'manager',
  // Plan y facturación
  'POST /api/billing/create-checkout': 'owner', 'GET /api/billing/status': 'owner', 'POST /api/billing/cancel': 'owner', 'POST /api/billing/portal': 'owner',
  // Equipo
  'GET /api/team': 'owner', 'POST /api/team': 'owner', 'PATCH /api/team/:id': 'owner', 'POST /api/team/:id/reset-password': 'owner',
  'POST /api/team/resolve-limit': 'owner',
};
const roleAtLeast = (role, min) => (ROLE_RANK[role] || 0) >= (ROLE_RANK[min] || 99);

// Contraseña temporal fuerte y legible: 12 caracteres sin ambiguos (0/O, 1/l/I), con mayúscula, minúscula y número, en
// grupos de 4. Se muestra UNA vez al dueño.
function generateTempPassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ', lower = 'abcdefghijkmnopqrstuvwxyz', digits = '23456789';
  const all = upper + lower + digits;
  const pick = (s) => s[crypto.randomInt(s.length)];
  const chars = [pick(upper), pick(lower), pick(digits)];
  while (chars.length < 12) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  const s = chars.join('');
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

module.exports = {
  TEAM_DDL_LOCK_KEY, ROLES, ROLE_RANK, ROLE_LABEL, PLAN_USER_LIMIT, OVER_LIMIT_GRACE_DAYS, TEMP_PASSWORD_DAYS, planLimit,
  USER_FK_COLUMNS, ensureTeamSchema, validateTeamFks, runTeamBackfill, ROUTE_MIN_ROLE, roleAtLeast, generateTempPassword,
};
