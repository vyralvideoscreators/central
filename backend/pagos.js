// Fase 2 — pagos de verdad. Esquema (idempotente), relleno de una sola vez y el recálculo del
// estado de cobro. Lo comparten server.js y demo-seed.js. SQL documentado en
// migrations/2026-11-25-pagos.sql.
//
// Regla de oro: orders.amount_paid y orders.pay_status son valores DERIVADOS. Se recalculan con una
// SUM sobre payments (no por incremento) dentro de la misma transacción que altera los pagos.
'use strict';

const BACKFILL_NAME = '2026-11-25-pagos-relleno';

const hasColumn = async (db, table, col) => (await db.query(
  `SELECT 1 FROM pg_attribute WHERE attrelid = $1::regclass AND attname = $2 AND NOT attisdropped`, [table, col])).rows.length > 0;

// Pedidos "pagados a la antigua" (pay_status = 'ok', total > 0, sin pagos): un pago por el total, en la
// moneda base del negocio. Seguro de reejecutar: solo toca pedidos que aún no tienen ningún pago.
async function backfillLegacyPayments(db) {
  const { rowCount } = await db.query(`
    WITH ins AS (
      INSERT INTO payments (tenant_id, order_id, client_id, amount, currency, exchange_rate, amount_base,
                            method, note, paid_at, created_by)
      SELECT o.tenant_id, o.id, o.client_id, o.total_price, t.base_currency, 1, o.total_price,
             COALESCE(NULLIF(NULLIF(btrim(o.pay_method_label), '—'), ''), 'Sin especificar'),
             'Registrado antes de la Fase 2',
             o.created_at AT TIME ZONE current_setting('TimeZone'), 'system'
      FROM orders o JOIN tenants t ON t.id = o.tenant_id
      WHERE o.pay_status = 'ok' AND o.total_price > 0
        AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id)
      RETURNING order_id, tenant_id, amount_base
    ), ev AS (
      INSERT INTO order_events (tenant_id, order_id, type, data, created_by)
      SELECT tenant_id, order_id, 'migrated', jsonb_build_object('amountBase', amount_base), 'system' FROM ins
    )
    UPDATE orders o SET amount_paid = ins.amount_base FROM ins WHERE o.id = ins.order_id AND o.tenant_id = ins.tenant_id
  `);
  return rowCount;
}

// Crea/actualiza el esquema de pagos y hace el relleno UNA sola vez (marca en schema_migrations).
// Todo en una transacción; lock_timeout para no dejar en cola a las peticiones si la tabla está ocupada.
async function ensurePaymentsSchema(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '5s'`);
    // ADD COLUMN IF NOT EXISTS pide el bloqueo aunque la columna exista: solo se ejecuta si falta
    if (!(await hasColumn(client, 'tenants', 'base_currency')))
      await client.query(`ALTER TABLE tenants ADD COLUMN base_currency TEXT NOT NULL DEFAULT 'USD'`);
    if (!(await hasColumn(client, 'orders', 'amount_paid')))
      await client.query(`ALTER TABLE orders ADD COLUMN amount_paid NUMERIC(12,2) NOT NULL DEFAULT 0`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS payments (
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
    await client.query(`CREATE INDEX IF NOT EXISTS payments_tenant_paid_at_idx ON payments (tenant_id, paid_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS payments_order_idx ON payments (order_id)`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS order_events (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        order_id   UUID NOT NULL REFERENCES orders(id)  ON DELETE CASCADE,
        type       TEXT NOT NULL,
        data       JSONB,
        created_by TEXT DEFAULT 'owner',
        created_at TIMESTAMPTZ DEFAULT now()
      )`);
    await client.query(`CREATE INDEX IF NOT EXISTS order_events_order_idx ON order_events (order_id, created_at)`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS tenant_settings (
        tenant_id        UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
        payment_methods  JSONB NOT NULL DEFAULT '[]',
        delivery_methods JSONB NOT NULL DEFAULT '{}',
        updated_at       TIMESTAMPTZ DEFAULT now()
      )`);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    // Relleno de una sola vez: la marca se escribe en la misma transacción que el relleno
    const mark = await client.query(`INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING RETURNING name`, [BACKFILL_NAME]);
    let filled = 0;
    if (mark.rows[0]) filled = await backfillLegacyPayments(client);
    await client.query('COMMIT');
    if (mark.rows[0]) console.log(`✅ Pagos: esquema listo; ${filled} pedido(s) antiguos pagados convertidos en un pago`);
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ Migración de pagos:', err.message);
    return false;
  } finally {
    client.release();
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

module.exports = { ensurePaymentsSchema, backfillLegacyPayments, recalcOrderPayment };
