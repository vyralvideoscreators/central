// Fase 2 — pagos de verdad. Esquema (solo DDL, idempotente), relleno por lotes y el recálculo del
// estado de cobro. Lo comparten server.js y demo-seed.js. SQL documentado en
// migrations/2026-11-25-pagos.sql.
//
// Regla de oro: orders.amount_paid y orders.pay_status son valores DERIVADOS. Se recalculan con una
// SUM sobre payments (no por incremento) dentro de la misma transacción que altera los pagos.
'use strict';

const BACKFILL_NAME = '2026-11-25-pagos-relleno';
const DDL_LOCK_KEY = 72616102;       // pg_advisory_xact_lock del DDL: dos réplicas nunca crean el esquema a la vez
const BACKFILL_LOCK_KEY = 72616103;  // un solo relleno a la vez (si otra réplica lo hace, esta lo salta)
const BACKFILL_BATCH = 1000;

const hasColumn = async (db, table, col) => (await db.query(
  `SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass($1) AND attname = $2 AND NOT attisdropped`, ['public.' + table, col])).rows.length > 0;
// Siempre con el esquema explícito: sin él, to_regclass sigue el search_path y podría ver una tabla homónima de otro esquema
const hasRelation = async (db, name) => (await db.query('SELECT to_regclass($1) IS NOT NULL AS ok', ['public.' + name])).rows[0].ok;
// ¿Existe un índice con ese nombre en public? → null (no existe) | true (es de esa tabla) | false (es de OTRA tabla)
const indexOwner = async (db, name, table) => {
  const { rows } = await db.query(`SELECT i.indrelid = to_regclass($2) AS mine
    FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = $1 AND n.nspname = 'public'`, [name, 'public.' + table]);
  return rows[0] ? !!rows[0].mine : null;
};

// ── Nombres de método de pago ─────────────────────────────────
// "Pago móvil" / "Pago Móvil", "Efectivo $" / "Efectivo USD", "Binance Pay" → un solo nombre para agrupar
// y filtrar. Se normaliza al LEER (el pago conserva lo que el negocio escribió).
const SMALL_WORDS = new Set(['de', 'del', 'la', 'el', 'y', 'en', 'a', 'con', 'por']);
const METHOD_SUFFIX_RE = /(\s+(usd|us\$|ves|bs\.?|eur|pay)|\s*[$€])$/i;
function normalizeMethodName(raw) {
  const original = String(raw === undefined || raw === null ? '' : raw).replace(/\s+/g, ' ').trim();
  let s = original;
  for (let i = 0; i < 5; i++) {
    const t = s.replace(METHOD_SUFFIX_RE, '').trim();
    if (t === s || !t) break;
    s = t;
  }
  if (!s) s = original;
  if (stripAccents(s).toLowerCase() === 'saldo a favor') return 'Saldo a favor';
  return s.split(' ').map((w, i) => {
    const l = w.toLowerCase();
    return i > 0 && SMALL_WORDS.has(l) ? l : l.charAt(0).toUpperCase() + l.slice(1);
  }).join(' ');
}
const stripAccents = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const methodKey = (raw) => stripAccents(normalizeMethodName(raw)).toLowerCase();
// Fase 3: pagar con el saldo a favor del cliente. No es dinero nuevo: no cuenta como cobrado en informes ni en Pagos.
const CREDIT_METHOD = 'Saldo a favor';
const isCreditMethod = (raw) => methodKey(raw) === 'saldo a favor';

// Une filas { method, total, n } con el mismo método canónico. Ordena por total desc y nombre.
function mergeMethodTotals(rows) {
  const by = new Map();
  for (const r of rows) {
    const key = methodKey(r.method), disp = normalizeMethodName(r.method);
    const cur = by.get(key);
    if (!cur) by.set(key, { method: disp, total: Number(r.total) || 0, count: Number(r.n) || 0 });
    else {
      cur.total += Number(r.total) || 0; cur.count += Number(r.n) || 0;
      if (cur.method === stripAccents(cur.method) && disp !== stripAccents(disp)) cur.method = disp; // preferir la forma con acentos
    }
  }
  return [...by.values()].map(m => ({ ...m, total: Math.round(m.total * 100) / 100 }))
    .sort((a, b) => b.total - a.total || a.method.localeCompare(b.method));
}
// Nombres crudos (de la base) que pertenecen al método canónico pedido
const rawMethodsFor = (allRaw, wanted) => { const k = methodKey(wanted); return allRaw.filter(m => methodKey(m) === k); };

// Pedidos "pagados a la antigua" (pay_status = 'ok', total > 0, amount_paid = 0, sin pagos): un pago por el
// total, en la moneda base del negocio. UN lote (hasta `limit` pedidos); devuelve cuántos convirtió.
// Seguro de reejecutar y de correr junto a pagos nuevos: bloquea los pedidos (SKIP LOCKED) y solo toca los
// que aún no tienen ningún pago. La condición amount_paid = 0 coincide con orders_legacy_paid_id_idx (por id: da el orden de ORDER BY o.id sin recorrer la tabla).
// Fase 4A: el pago se fecha en el día de creación del pedido; si ese día tiene la caja CERRADA, el pedido se omite (el pago
// aparecería dentro de un día ya contado). Se recoge en cuanto se reabre ese día. (Si cash_closings aún no existe, no hay cierres.)
async function backfillLegacyPayments(db, limit = BACKFILL_BATCH) {
  const hasClosings = await hasRelation(db, 'cash_closings');
  const { rows: cand } = await db.query(`
    SELECT o.id, o.tenant_id, o.pay_method_label FROM orders o
    WHERE o.pay_status = 'ok' AND o.amount_paid = 0 AND o.total_price > 0
      AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id)${hasClosings ? `
      AND NOT EXISTS (
        SELECT 1 FROM cash_closings cc JOIN tenants tt ON tt.id = cc.tenant_id
        WHERE cc.tenant_id = o.tenant_id AND cc.reopened_at IS NULL AND tt.timezone IS NOT NULL
          AND cc.day = ((o.created_at AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE tt.timezone)::date)` : ''}
    ORDER BY o.id LIMIT $1 FOR UPDATE OF o SKIP LOCKED`, [limit]);
  if (!cand.length) return 0;
  // Orden de bloqueo: pedido (arriba) → tenant. Se toma el tenant FOR KEY SHARE (como cualquier operación de dinero) y, YA con el
  // candado, se repite la comprobación de cierre con la zona efectiva (misma regla que tzOf): un cierre de caja que llegó entre
  // el SELECT y el INSERT espera al cierre o, si ya se confirmó, deja el pedido fuera.
  let keep = cand;
  if (hasClosings) {
    const ops = require('./operacion'); // carga diferida: operacion.js requiere este archivo
    const tIds = [...new Set(cand.map(r => r.tenant_id))].sort();
    const { rows: ts } = await db.query('SELECT id, country, timezone FROM tenants WHERE id = ANY($1::uuid[]) ORDER BY id FOR KEY SHARE', [tIds]);
    const tzBy = new Map(ts.map(t => [t.id, ops.tzOf(t)]));
    const { rows: closed } = await db.query(`
      SELECT c.id FROM unnest($1::uuid[], $2::uuid[], $3::text[]) AS c(id, tenant_id, tz)
      JOIN orders o ON o.id = c.id
      JOIN cash_closings cc ON cc.tenant_id = c.tenant_id AND cc.reopened_at IS NULL
        AND cc.day = ((o.created_at AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE c.tz)::date
      WHERE c.tz IS NOT NULL`, [cand.map(r => r.id), cand.map(r => r.tenant_id), cand.map(r => tzBy.get(r.tenant_id) || null)]);
    if (closed.length) { const skip = new Set(closed.map(r => r.id)); keep = cand.filter(r => !skip.has(r.id)); }
    if (!keep.length) return 0;
  }
  const ids = keep.map(r => r.id);
  const methods = keep.map(r => {
    const lbl = String(r.pay_method_label || '').trim();
    return !lbl || lbl === '—' ? 'Sin Especificar' : normalizeMethodName(lbl);
  });
  const { rowCount } = await db.query(`
    WITH ins AS (
      INSERT INTO payments (tenant_id, order_id, client_id, amount, currency, exchange_rate, amount_base,
                            method, note, paid_at, created_by)
      SELECT o.tenant_id, o.id, o.client_id, o.total_price, t.base_currency, 1, o.total_price,
             m.method, 'Registrado antes de la Fase 2',
             o.created_at AT TIME ZONE current_setting('TimeZone'), 'system'
      FROM unnest($1::uuid[], $2::text[]) AS m(id, method)
      JOIN orders o ON o.id = m.id JOIN tenants t ON t.id = o.tenant_id
      RETURNING order_id, tenant_id, amount_base
    ), ev AS (
      INSERT INTO order_events (tenant_id, order_id, type, data, created_by)
      SELECT tenant_id, order_id, 'migrated', jsonb_build_object('amountBase', amount_base), 'system' FROM ins
    )
    UPDATE orders o SET amount_paid = ins.amount_base FROM ins WHERE o.id = ins.order_id AND o.tenant_id = ins.tenant_id
  `, [ids, methods]);
  return rowCount;
}

// Relleno por lotes, cada uno en su transacción. Se ejecuta EN CADA ARRANQUE (no hay marca única): la
// versión anterior del servidor puede seguir creando pedidos 'ok' sin pago durante el despliegue. Es barato
// gracias a orders_legacy_paid_id_idx (índice parcial, ver BACKGROUND_INDEXES); mientras ese índice no
// exista, es una consulta normal sobre orders. Un fallo solo se registra: se reintenta al siguiente arranque.
async function runPaymentsBackfill(pool, batch = BACKFILL_BATCH) {
  let total = 0;
  try {
    for (let i = 0; i < 100000; i++) {
      const client = await pool.connect();
      let n;
      try {
        await client.query('BEGIN');
        const { rows: [lk] } = await client.query('SELECT pg_try_advisory_xact_lock($1) AS ok', [BACKFILL_LOCK_KEY]);
        if (!lk.ok) { await client.query('ROLLBACK'); return total; } // otra réplica lo está haciendo
        await client.query(`SET LOCAL lock_timeout = '5s'`);
        n = await backfillLegacyPayments(client, batch);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
      total += n;
      if (n < batch) break;
    }
    await pool.query(`INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING`, [BACKFILL_NAME]);
    if (total) console.log(`✅ Pagos: ${total} pedido(s) antiguos pagados convertidos en un pago`);
  } catch (err) {
    console.error('⚠️  Relleno de pagos (se reintenta en el próximo arranque):', err.message);
  }
  return total;
}

// Esquema de pagos: SOLO DDL, en una transacción corta con advisory lock. Antes de cada ALTER/CREATE se
// comprueba si ya existe: en un arranque normal no se ejecuta ningún DDL (no se toman bloqueos sobre
// orders/tenants). Devuelve true si el esquema quedó completo; el relleno de datos va aparte.
async function ensurePaymentsSchema(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [DDL_LOCK_KEY]);
    await client.query(`SET LOCAL lock_timeout = '5s'`);
    // ADD COLUMN IF NOT EXISTS pide el bloqueo aunque la columna exista: solo se ejecuta si falta
    if (!(await hasColumn(client, 'tenants', 'base_currency')))
      await client.query(`ALTER TABLE tenants ADD COLUMN base_currency TEXT NOT NULL DEFAULT 'USD'`);
    if (!(await hasColumn(client, 'orders', 'amount_paid')))
      await client.query(`ALTER TABLE orders ADD COLUMN amount_paid NUMERIC(12,2) NOT NULL DEFAULT 0`);
    if (!(await hasRelation(client, 'payments'))) {
      await client.query(`
        CREATE TABLE payments (
          id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          order_id      UUID NOT NULL REFERENCES orders(id)  ON DELETE CASCADE,
          client_id     UUID REFERENCES clients(id) ON DELETE SET NULL,
          amount        NUMERIC(12,2) NOT NULL CHECK (amount > 0),
          currency      TEXT NOT NULL,
          exchange_rate NUMERIC(18,6) NOT NULL DEFAULT 1 CHECK (exchange_rate > 0),
          amount_base   NUMERIC(12,2) NOT NULL CHECK (amount_base > 0),
          method        TEXT NOT NULL,
          reference     TEXT,
          paid_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
          note          TEXT,
          created_at    TIMESTAMPTZ DEFAULT now(),
          created_by    TEXT NOT NULL DEFAULT 'owner',
          voided_at     TIMESTAMPTZ,
          void_reason   TEXT
        )`);
    }
    if (!(await hasRelation(client, 'order_events'))) {
      await client.query(`
        CREATE TABLE order_events (
          id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          order_id   UUID NOT NULL REFERENCES orders(id)  ON DELETE CASCADE,
          type       TEXT NOT NULL,
          data       JSONB,
          created_by TEXT DEFAULT 'owner',
          created_at TIMESTAMPTZ DEFAULT now(),
          -- orden de inserción: varios eventos de una misma transacción comparten created_at (now())
          seq        BIGINT GENERATED ALWAYS AS IDENTITY
        )`);
    } else if (!(await hasColumn(client, 'order_events', 'seq'))) {
      await client.query(`ALTER TABLE order_events ADD COLUMN seq BIGINT GENERATED ALWAYS AS IDENTITY`);
    }
    // Índices de tablas NUEVAS (vacías): se crean aquí, no en BACKGROUND_INDEXES
    for (const [name, table, sql] of [
      ['payments_tenant_paid_at_idx', 'payments',     'CREATE INDEX payments_tenant_paid_at_idx ON payments (tenant_id, paid_at)'],
      ['payments_order_idx',          'payments',     'CREATE INDEX payments_order_idx ON payments (order_id)'],
      ['payments_client_idx',         'payments',     'CREATE INDEX payments_client_idx ON payments (client_id) WHERE client_id IS NOT NULL'],
      ['order_events_order_seq_idx',  'order_events', 'CREATE INDEX order_events_order_seq_idx ON order_events (order_id, created_at, seq)'],
      ['order_events_tenant_idx',     'order_events', 'CREATE INDEX order_events_tenant_idx ON order_events (tenant_id)'],
    ]) await ensureOwnIndex(client, name, table, sql);
    // versión anterior del índice (order_id, created_at): la reemplaza order_events_order_seq_idx.
    // Solo se borra si es de order_events (base compartida: nunca tocar un índice ajeno).
    if ((await indexOwner(client, 'order_events_order_idx', 'order_events')) === true) {
      await client.query('DROP INDEX public.order_events_order_idx');
    }
    if (!(await hasRelation(client, 'tenant_settings'))) {
      await client.query(`
        CREATE TABLE tenant_settings (
          tenant_id        UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
          payment_methods  JSONB NOT NULL DEFAULT '[]',
          delivery_methods JSONB NOT NULL DEFAULT '{}',
          updated_at       TIMESTAMPTZ DEFAULT now()
        )`);
    }
    if (!(await hasRelation(client, 'schema_migrations'))) {
      await client.query(`CREATE TABLE schema_migrations (
        name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // No se devuelve false aquí: si el fallo fue en un paso secundario, el esquema puede estar completo;
    // la comprobación de abajo decide (y initDB reintenta si falta).
    console.error('⚠️  Migración de pagos:', err.message);
  } finally {
    client.release();
  }
  // Comprobación: sin esto los pedidos fallarían (amount_paid) y no hay pagos
  try {
    return (await hasColumn(pool, 'tenants', 'base_currency')) && (await hasColumn(pool, 'orders', 'amount_paid'))
      && (await hasRelation(pool, 'payments')) && (await hasRelation(pool, 'order_events'))
      && (await hasRelation(pool, 'tenant_settings')) && (await hasRelation(pool, 'schema_migrations'));
  } catch (err) {
    console.error('❌ Comprobación del esquema de pagos:', err.message);
    return false;
  }
}

// Recalcula amount_paid, credited_total y pay_status de UN pedido (Fase 3):
//   total efectivo = total_price − Σ notas de crédito
//   amount_paid    = Σ pagos no anulados − Σ reembolsos   (cobrado NETO, moneda base)
//   saldo          = total efectivo − amount_paid
// Debe llamarse con la fila del pedido ya bloqueada (SELECT … FOR UPDATE) dentro de la transacción.
// Un pedido con total efectivo 0 y sin cobros conserva su estado (no tiene nada que cobrar).
async function recalcOrderPayment(db, tenantId, orderId) {
  const { rows } = await db.query(`
    UPDATE orders o SET
      credited_total = s.credited,
      amount_paid = s.paid - s.refunded,
      pay_status = CASE
        WHEN s.paid - s.refunded <= 0 THEN (CASE WHEN COALESCE(o.total_price, 0) - s.credited <= 0 THEN o.pay_status ELSE 'pend' END)
        WHEN s.paid - s.refunded >= COALESCE(o.total_price, 0) - s.credited THEN 'ok'
        ELSE 'partial' END,
      updated_at = NOW()
    FROM (SELECT
      (SELECT COALESCE(SUM(amount_base), 0) FROM payments WHERE order_id = $1 AND tenant_id = $2 AND voided_at IS NULL) AS paid,
      (SELECT COALESCE(SUM(amount_base), 0) FROM refunds  WHERE order_id = $1 AND tenant_id = $2) AS refunded,
      (SELECT COALESCE(SUM(amount_base), 0) FROM credit_notes WHERE order_id = $1 AND tenant_id = $2) AS credited) s
    WHERE o.id = $1 AND o.tenant_id = $2
    RETURNING o.*
  `, [orderId, tenantId]);
  return rows[0] || null;
}

// ── Fase 3: ciclo completo del pedido ─────────────────────────
// Presupuestos (orders.kind), anulación, impuesto, fecha/zona de entrega, notas de crédito, reembolsos y saldo
// a favor. SQL documentado en migrations/2026-11-26-ciclo-pedido.sql. Solo DDL, con advisory lock.
const CYCLE_DDL_LOCK_KEY = 72616104;
// Columnas propias de CENTRAL en cada tabla nueva: si una tabla con ese nombre ya existe SIN ellas, es de otra aplicación
// (la base se comparte con Kisses). Nunca se escribe en ella ni se sigue arrancando.
const CYCLE_TABLE_COLS = {
  credit_notes:          ['tenant_id', 'order_id', 'number', 'amount_base'],
  credit_note_items:     ['tenant_id', 'credit_note_id', 'order_item_id'],
  refunds:               ['tenant_id', 'order_id', 'credit_note_id', 'amount_base'],
  client_credit_entries: ['tenant_id', 'client_id', 'kind', 'amount'],
};
async function assertCycleTablesAreOurs(db) {
  for (const [table, cols] of Object.entries(CYCLE_TABLE_COLS)) {
    if (!(await hasRelation(db, table))) continue;
    for (const col of cols) {
      if (!(await hasColumn(db, table, col))) {
        console.error(`❌ La tabla ${table} ya existe en la base pero NO es de CENTRAL (le falta la columna ${col}). ` +
          'Se detiene el arranque para no escribir en datos ajenos: renombra esa tabla o cambia el nombre en pagos.js.');
        process.exit(1);
      }
    }
  }
}
// Crea el índice si no existe; si el nombre ya lo usa OTRA tabla, detiene el arranque (mismo motivo)
async function ensureOwnIndex(db, name, table, sql) {
  const owner = await indexOwner(db, name, table);
  if (owner === false) {
    console.error(`❌ Ya existe un índice ${name} que no es de la tabla ${table}. Se detiene el arranque: cambia el nombre del índice.`);
    process.exit(1);
  }
  if (owner === null) await db.query(sql);
}

// VALIDATE del CHECK de orders.kind: se hace DESPUÉS de listen (recorre orders). Tolerante a fallos: si no puede,
// se reintenta en el próximo arranque (mientras tanto el CHECK ya impide filas nuevas inválidas).
async function validateOrdersKindCheck(pool) {
  let client;
  try {
    client = await pool.connect();
    const { rows: [c] } = await client.query(
      `SELECT convalidated FROM pg_constraint WHERE conname = 'orders_kind_check' AND conrelid = to_regclass('public.orders')`);
    if (!c || c.convalidated) return;
    await client.query(`SET lock_timeout = '5s'`);
    await client.query('ALTER TABLE public.orders VALIDATE CONSTRAINT orders_kind_check');
    console.log('✅ CHECK orders_kind_check validado');
  } catch (err) {
    console.error('⚠️  VALIDATE orders_kind_check (se reintentará en el próximo arranque):', err.message);
  } finally {
    if (client) { await client.query('RESET lock_timeout').catch(() => {}); client.release(); }
  }
}

async function ensureOrderCycleSchema(pool) {
  await assertCycleTablesAreOurs(pool); // antes de tocar nada
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [CYCLE_DDL_LOCK_KEY]);
    await client.query(`SET LOCAL lock_timeout = '5s'`);
    // ADD COLUMN IF NOT EXISTS pide el bloqueo aunque exista: solo se ejecuta si falta (DEFAULT constante = instantáneo)
    for (const [table, col, ddl] of [
      ['tenants', 'quote_seq',        'INTEGER NOT NULL DEFAULT 0'],
      ['tenants', 'credit_note_seq',  'INTEGER NOT NULL DEFAULT 0'],
      ['orders',  'kind',             "TEXT NOT NULL DEFAULT 'order'"],
      ['orders',  'quote_number',     'INTEGER'],
      ['orders',  'cancelled_at',     'TIMESTAMPTZ'],
      ['orders',  'cancel_reason',    'TEXT'],
      ['orders',  'tax_rate',         'NUMERIC(5,2) NOT NULL DEFAULT 0'],
      ['orders',  'tax_amount',       'NUMERIC(10,2) NOT NULL DEFAULT 0'],
      ['orders',  'delivery_date',    'DATE'],
      ['orders',  'delivery_zone',    'TEXT'],
      ['orders',  'credited_total',   'NUMERIC(12,2) NOT NULL DEFAULT 0'],
      ['tenant_settings', 'tax',      "JSONB NOT NULL DEFAULT '{}'"],
      ['tenant_settings', 'zones',    "JSONB NOT NULL DEFAULT '[]'"],
    ]) if (!(await hasColumn(client, table, col))) await client.query(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);

    if (!(await hasRelation(client, 'credit_notes'))) {
      await client.query(`
        CREATE TABLE credit_notes (
          id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          order_id    UUID NOT NULL REFERENCES orders(id)  ON DELETE CASCADE,
          client_id   UUID REFERENCES clients(id) ON DELETE SET NULL,
          number      INTEGER NOT NULL,
          amount_base NUMERIC(12,2) NOT NULL CHECK (amount_base > 0),
          reason      TEXT NOT NULL,
          created_by  TEXT NOT NULL DEFAULT 'owner',
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (tenant_id, number)
        )`);
    }
    if (!(await hasRelation(client, 'credit_note_items'))) {
      await client.query(`
        CREATE TABLE credit_note_items (
          id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          credit_note_id UUID NOT NULL REFERENCES credit_notes(id) ON DELETE CASCADE,
          order_item_id  UUID,
          name           TEXT NOT NULL,
          qty            INTEGER NOT NULL DEFAULT 1 CHECK (qty >= 0),
          amount         NUMERIC(12,2) NOT NULL CHECK (amount >= 0)
        )`);
    }
    if (!(await hasRelation(client, 'refunds'))) {
      await client.query(`
        CREATE TABLE refunds (
          id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          order_id       UUID NOT NULL REFERENCES orders(id)  ON DELETE CASCADE,
          credit_note_id UUID REFERENCES credit_notes(id) ON DELETE SET NULL,
          amount         NUMERIC(12,2) NOT NULL CHECK (amount > 0),
          currency       TEXT NOT NULL,
          exchange_rate  NUMERIC(18,6) NOT NULL DEFAULT 1 CHECK (exchange_rate > 0),
          amount_base    NUMERIC(12,2) NOT NULL CHECK (amount_base > 0),
          method         TEXT NOT NULL,
          reference      TEXT,
          reason         TEXT,
          created_by     TEXT NOT NULL DEFAULT 'owner',
          created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
    }
    if (!(await hasRelation(client, 'client_credit_entries'))) {
      await client.query(`
        CREATE TABLE client_credit_entries (
          id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          client_id  UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
          amount     NUMERIC(12,2) NOT NULL CHECK (amount <> 0),
          kind       TEXT NOT NULL CHECK (kind IN ('refund_to_credit', 'credit_payment', 'credit_payment_void')),
          order_id   UUID REFERENCES orders(id) ON DELETE SET NULL,
          ref_id     UUID,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
    }
    // Tablas NUEVAS (vacías): sus índices se crean aquí
    for (const [name, table, sql] of [
      ['credit_notes_order_idx',     'credit_notes',          'CREATE INDEX credit_notes_order_idx ON credit_notes (order_id)'],
      ['credit_notes_client_idx',    'credit_notes',          'CREATE INDEX credit_notes_client_idx ON credit_notes (client_id) WHERE client_id IS NOT NULL'],
      ['credit_note_items_note_idx', 'credit_note_items',     'CREATE INDEX credit_note_items_note_idx ON credit_note_items (credit_note_id)'],
      ['credit_note_items_item_idx', 'credit_note_items',     'CREATE INDEX credit_note_items_item_idx ON credit_note_items (order_item_id) WHERE order_item_id IS NOT NULL'],
      ['refunds_tenant_created_idx', 'refunds',               'CREATE INDEX refunds_tenant_created_idx ON refunds (tenant_id, created_at)'],
      ['refunds_order_idx',          'refunds',               'CREATE INDEX refunds_order_idx ON refunds (order_id)'],
      ['refunds_credit_note_idx',    'refunds',               'CREATE INDEX refunds_credit_note_idx ON refunds (credit_note_id) WHERE credit_note_id IS NOT NULL'],
      // (tenant_id, client_id) INCLUDE (amount): el saldo a favor es un index-only scan y el prefijo tenant_id sirve a los informes
      ['client_credit_tenant_client_idx', 'client_credit_entries', 'CREATE INDEX client_credit_tenant_client_idx ON client_credit_entries (tenant_id, client_id) INCLUDE (amount)'],
      ['client_credit_order_idx',    'client_credit_entries', 'CREATE INDEX client_credit_order_idx ON client_credit_entries (order_id) WHERE order_id IS NOT NULL'],
    ]) await ensureOwnIndex(client, name, table, sql);
    // Versiones anteriores (redundantes con client_credit_tenant_client_idx): solo si de verdad son de esta tabla
    for (const old of ['client_credit_client_idx', 'client_credit_tenant_idx']) {
      if ((await indexOwner(client, old, 'client_credit_entries')) === true) await client.query(`DROP INDEX public.${old}`);
    }
    // CHECK de orders.kind: ADD ... NOT VALID no recorre la tabla (solo el bloqueo breve, con lock_timeout y el advisory
    // lock de arriba). El VALIDATE, que sí la recorre, va en segundo plano tras listen (validateOrdersKindCheck).
    const { rows: ck } = await client.query(
      `SELECT 1 FROM pg_constraint WHERE conname = 'orders_kind_check' AND conrelid = to_regclass('public.orders')`);
    if (!ck[0]) await client.query(`ALTER TABLE public.orders ADD CONSTRAINT orders_kind_check CHECK (kind IN ('order','quote')) NOT VALID`);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('⚠️  Migración del ciclo del pedido:', err.message);
  } finally {
    client.release();
  }
  try {
    const cols = [['tenants', 'quote_seq'], ['tenants', 'credit_note_seq'], ['orders', 'kind'], ['orders', 'quote_number'],
      ['orders', 'cancelled_at'], ['orders', 'cancel_reason'], ['orders', 'tax_rate'], ['orders', 'tax_amount'],
      ['orders', 'delivery_date'], ['orders', 'delivery_zone'], ['orders', 'credited_total'],
      ['tenant_settings', 'tax'], ['tenant_settings', 'zones']];
    for (const [t, c] of cols) if (!(await hasColumn(pool, t, c))) return false;
    for (const r of Object.keys(CYCLE_TABLE_COLS)) if (!(await hasRelation(pool, r))) return false;
    await assertCycleTablesAreOurs(pool);
    return true;
  } catch (err) {
    console.error('❌ Comprobación del esquema del ciclo del pedido:', err.message);
    return false;
  }
}

module.exports = { ensurePaymentsSchema, ensureOrderCycleSchema, validateOrdersKindCheck, CREDIT_METHOD, isCreditMethod, runPaymentsBackfill, backfillLegacyPayments, recalcOrderPayment,
  normalizeMethodName, methodKey, mergeMethodTotals, rawMethodsFor, hasColumn, hasRelation, indexOwner, ensureOwnIndex };
