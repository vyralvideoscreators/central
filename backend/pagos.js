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
  `SELECT 1 FROM pg_attribute WHERE attrelid = $1::regclass AND attname = $2 AND NOT attisdropped`, [table, col])).rows.length > 0;
const hasRelation = async (db, name) => (await db.query('SELECT to_regclass($1) IS NOT NULL AS ok', [name])).rows[0].ok;

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
  return s.split(' ').map((w, i) => {
    const l = w.toLowerCase();
    return i > 0 && SMALL_WORDS.has(l) ? l : l.charAt(0).toUpperCase() + l.slice(1);
  }).join(' ');
}
const stripAccents = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const methodKey = (raw) => stripAccents(normalizeMethodName(raw)).toLowerCase();

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
async function backfillLegacyPayments(db, limit = BACKFILL_BATCH) {
  const { rows: cand } = await db.query(`
    SELECT o.id, o.pay_method_label FROM orders o
    WHERE o.pay_status = 'ok' AND o.amount_paid = 0 AND o.total_price > 0
      AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id)
    ORDER BY o.id LIMIT $1 FOR UPDATE OF o SKIP LOCKED`, [limit]);
  if (!cand.length) return 0;
  const ids = cand.map(r => r.id);
  const methods = cand.map(r => {
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
    for (const [name, sql] of [
      ['payments_tenant_paid_at_idx', 'CREATE INDEX payments_tenant_paid_at_idx ON payments (tenant_id, paid_at)'],
      ['payments_order_idx',          'CREATE INDEX payments_order_idx ON payments (order_id)'],
      ['payments_client_idx',         'CREATE INDEX payments_client_idx ON payments (client_id) WHERE client_id IS NOT NULL'],
      ['order_events_order_seq_idx',  'CREATE INDEX order_events_order_seq_idx ON order_events (order_id, created_at, seq)'],
      ['order_events_tenant_idx',     'CREATE INDEX order_events_tenant_idx ON order_events (tenant_id)'],
    ]) if (!(await hasRelation(client, name))) await client.query(sql);
    // versión anterior del índice (order_id, created_at): la reemplaza order_events_order_seq_idx
    if (await hasRelation(client, 'order_events_order_idx')) await client.query('DROP INDEX order_events_order_idx');
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

// Recalcula amount_paid y pay_status de UN pedido a partir de sus pagos no anulados.
// Debe llamarse con la fila del pedido ya bloqueada (SELECT … FOR UPDATE) dentro de la transacción.
// Un pedido con total 0 y sin cobros conserva su estado (no tiene nada que cobrar).
async function recalcOrderPayment(db, tenantId, orderId) {
  const { rows } = await db.query(`
    UPDATE orders o SET
      amount_paid = s.paid,
      pay_status = CASE
        WHEN s.paid <= 0 THEN (CASE WHEN COALESCE(o.total_price, 0) <= 0 THEN o.pay_status ELSE 'pend' END)
        WHEN s.paid >= COALESCE(o.total_price, 0) THEN 'ok'
        ELSE 'partial' END,
      updated_at = NOW()
    FROM (SELECT COALESCE(SUM(amount_base), 0) AS paid FROM payments
          WHERE order_id = $1 AND tenant_id = $2 AND voided_at IS NULL) s
    WHERE o.id = $1 AND o.tenant_id = $2
    RETURNING o.*
  `, [orderId, tenantId]);
  return rows[0] || null;
}

module.exports = { ensurePaymentsSchema, runPaymentsBackfill, backfillLegacyPayments, recalcOrderPayment,
  normalizeMethodName, methodKey, mergeMethodTotals, rawMethodsFor };
