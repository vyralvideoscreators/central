-- ══════════════════════════════════════════════════════════════
-- CENTRAL — Fase 3: ciclo completo del pedido (26-nov-2026)
--
-- server.js hace ESTO MISMO automáticamente al arrancar (initDB → ensureOrderCycleSchema en backend/pagos.js).
-- Este archivo es para revisarlo / respaldarlo. HAZ RESPALDO ANTES (backend/scripts/respaldo-produccion.ps1).
-- No hay relleno de datos: los pedidos anteriores quedan como pedidos normales (kind = 'order'), sin impuesto
-- (tax_rate = 0), sin fecha ni zona de entrega y sin notas de crédito.
--
-- Cómo se aplica: SOLO DDL, en una transacción corta con pg_advisory_xact_lock y lock_timeout 5 s; antes de
-- cada ALTER/CREATE comprueba si ya existe (en un arranque normal no ejecuta ningún DDL). Hasta 4 intentos; si
-- el esquema sigue incompleto, el servidor sale con error y Railway conserva la versión anterior. Todas las
-- columnas nuevas de orders/tenants llevan DEFAULT constante (instantáneo en PG ≥ 11).
-- Los dos índices sobre orders van en BACKGROUND_INDEXES (CONCURRENTLY, tras listen), no en el arranque.
--
-- Qué hace
--   1) Presupuestos: orders.kind ('order' | 'quote'), orders.quote_number (contador propio tenants.quote_seq,
--      se muestra P-0001). Un presupuesto tiene tenant_order_number NULL hasta que se convierte en pedido.
--   2) Anulación: orders.cancelled_at / cancel_reason. delivery_status admite además 'preparing' y 'on_the_way';
--      'cancelled' solo lo pone POST /api/orders/:id/cancel.
--   3) Impuesto: orders.tax_rate (%) y orders.tax_amount = foto tomada al crear; tenant_settings.tax
--      ({enabled, rate, label}).
--   4) Entrega: orders.delivery_date (DATE) y orders.delivery_zone; tenant_settings.zones
--      ([{name, cost}]).
--   5) Devoluciones: credit_notes (NC-0001, contador tenants.credit_note_seq), credit_note_items,
--      refunds. orders.credited_total = Σ notas de crédito (derivado, lo recalcula recalcOrderPayment).
--      total efectivo = total_price − credited_total; amount_paid = Σ pagos no anulados − Σ reembolsos.
--   6) Saldo a favor: client_credit_entries (movimientos con signo; saldo = SUM(amount), nunca negativo).
--      Se paga con el método canónico 'Saldo a favor'.
--
-- Reglas contables: el dinero no se edita, se registra. Notas de crédito, reembolsos y movimientos de saldo
-- solo se insertan (esta fase no los anula). No hay DELETE ni UPDATE de importes.
-- ══════════════════════════════════════════════════════════════

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS quote_seq       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS credit_note_seq INTEGER NOT NULL DEFAULT 0;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS kind           TEXT NOT NULL DEFAULT 'order';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS quote_number   INTEGER;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_at   TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancel_reason  TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tax_rate       NUMERIC(5,2)  NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tax_amount     NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_date  DATE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_zone  TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS credited_total NUMERIC(12,2) NOT NULL DEFAULT 0;

ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS tax   JSONB NOT NULL DEFAULT '{}';
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS zones JSONB NOT NULL DEFAULT '[]';

CREATE TABLE IF NOT EXISTS credit_notes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id    UUID NOT NULL REFERENCES orders(id)  ON DELETE CASCADE,
  client_id   UUID REFERENCES clients(id) ON DELETE SET NULL,
  number      INTEGER NOT NULL,                                   -- NC-0001, propio de cada negocio
  amount_base NUMERIC(12,2) NOT NULL CHECK (amount_base > 0),
  reason      TEXT NOT NULL,
  created_by  TEXT NOT NULL DEFAULT 'owner',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);

CREATE TABLE IF NOT EXISTS credit_note_items (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  credit_note_id UUID NOT NULL REFERENCES credit_notes(id) ON DELETE CASCADE,
  order_item_id  UUID,                                            -- NULL = devolución por importe
  name           TEXT NOT NULL,
  qty            INTEGER NOT NULL DEFAULT 1 CHECK (qty >= 0),
  amount         NUMERIC(12,2) NOT NULL CHECK (amount >= 0)
);

CREATE TABLE IF NOT EXISTS refunds (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id       UUID NOT NULL REFERENCES orders(id)  ON DELETE CASCADE,
  credit_note_id UUID REFERENCES credit_notes(id) ON DELETE SET NULL,   -- NULL = reembolso por anulación
  amount         NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  currency       TEXT NOT NULL,
  exchange_rate  NUMERIC(18,6) NOT NULL DEFAULT 1 CHECK (exchange_rate > 0),
  amount_base    NUMERIC(12,2) NOT NULL CHECK (amount_base > 0),
  method         TEXT NOT NULL,                                   -- 'Saldo a favor' = el dinero queda como crédito
  reference      TEXT,
  reason         TEXT,
  created_by     TEXT NOT NULL DEFAULT 'owner',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS client_credit_entries (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id  UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  amount     NUMERIC(12,2) NOT NULL CHECK (amount <> 0),          -- con signo
  kind       TEXT NOT NULL CHECK (kind IN ('refund_to_credit', 'credit_payment', 'credit_payment_void')),
  order_id   UUID REFERENCES orders(id) ON DELETE SET NULL,
  ref_id     UUID,                                                -- refund o payment que lo originó
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tablas nuevas (vacías): sus índices se crean junto al DDL
CREATE INDEX IF NOT EXISTS credit_notes_order_idx     ON credit_notes (order_id);
CREATE INDEX IF NOT EXISTS credit_note_items_note_idx ON credit_note_items (credit_note_id);
CREATE INDEX IF NOT EXISTS credit_note_items_item_idx ON credit_note_items (order_item_id) WHERE order_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS refunds_tenant_created_idx ON refunds (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS refunds_order_idx          ON refunds (order_id);
CREATE INDEX IF NOT EXISTS client_credit_client_idx   ON client_credit_entries (client_id);
CREATE INDEX IF NOT EXISTS client_credit_tenant_idx   ON client_credit_entries (tenant_id);

COMMIT;

-- CHECK de orders.kind: NOT VALID y después VALIDATE (no bloquea escrituras). Fuera de la transacción.
ALTER TABLE orders ADD CONSTRAINT orders_kind_check CHECK (kind IN ('order', 'quote')) NOT VALID;
ALTER TABLE orders VALIDATE CONSTRAINT orders_kind_check;

-- Índices sobre orders (tabla con datos): los crea ensureIndexes() con CONCURRENTLY tras listen. A mano:
--   CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS orders_tenant_quote_number_uniq
--     ON orders (tenant_id, quote_number) WHERE quote_number IS NOT NULL;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_tenant_delivery_date_idx
--     ON orders (tenant_id, delivery_date) WHERE delivery_date IS NOT NULL;
