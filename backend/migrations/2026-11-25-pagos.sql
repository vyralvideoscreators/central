-- ══════════════════════════════════════════════════════════════
-- CENTRAL — Fase 2: pagos de verdad (25-nov-2026)
--
-- server.js hace ESTO MISMO automáticamente al arrancar (initDB). Este archivo es para revisarlo / respaldarlo.
-- HAZ RESPALDO ANTES (pg_dump): el relleno modifica orders.amount_paid.
--   (a) ensurePaymentsSchema (backend/pagos.js): SOLO DDL, en una transacción corta con pg_advisory_xact_lock
--       y lock_timeout 5 s; antes de cada ALTER/CREATE comprueba si ya existe (en un arranque normal no
--       ejecuta ningún DDL). Hasta 4 intentos; si el esquema sigue incompleto, el servidor sale con error
--       y Railway conserva la versión anterior.
--   (b) runPaymentsBackfill (relleno de datos, APARTE): lotes de 1000 pedidos, cada lote en su transacción.
--       Sin la marca '2026-11-25-pagos-relleno' en schema_migrations (primer despliegue) se ejecuta ANTES de
--       escuchar; si ya está la marca, corre en segundo plano tras listen y otra vez a los 10 min (la versión
--       vieja puede crear pedidos 'ok' sin pago durante el solape del despliegue). NO depende de la marca:
--       es idempotente y la marca solo decide si se espera. Un fallo se registra y se reintenta al arrancar.
--
-- Qué hace
--   1) tenants.base_currency (moneda en la que se llevan totales y saldos), por defecto 'USD'.
--   2) orders.amount_paid: suma de los pagos NO anulados, en moneda base. orders.pay_status pasa
--      a ser DERIVADO (pend | partial | ok) y lo mantiene el servidor (recalcOrderPayment) con una SUM en
--      cada alta/anulación de pago y en cada edición de total (nunca por incremento).
--   3) payments: solo se añaden filas; un error se corrige anulando (voided_at), nunca DELETE.
--   4) order_events: historial por pedido (created, edited, status_changed, payment_added,
--      payment_voided, migrated), ordenado por seq.
--   5) tenant_settings: métodos de pago / entrega del negocio.
--   6) Relleno: cada pedido con pay_status = 'ok', total > 0, amount_paid = 0 y sin pagos recibe un pago por
--      su total (moneda base, tasa 1, método = pay_method_label o 'Sin Especificar', paid_at = created_at
--      del pedido) y un evento 'migrated'. Pedidos pagados con total 0 no se tocan.
--
-- Bloqueos: ADD COLUMN con DEFAULT constante es instantáneo (PG ≥ 11). Los índices de payments / order_events /
-- tenant_settings son de tablas NUEVAS y vacías: se crean junto al DDL. El único índice sobre una tabla con
-- datos (orders_legacy_paid_id_idx) va en BACKGROUND_INDEXES de server.js (CONCURRENTLY, tras listen).
-- ══════════════════════════════════════════════════════════════

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS base_currency TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE orders  ADD COLUMN IF NOT EXISTS amount_paid NUMERIC(12,2) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS payments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id      UUID NOT NULL REFERENCES orders(id)  ON DELETE CASCADE,
  client_id     UUID REFERENCES clients(id) ON DELETE SET NULL,
  amount        NUMERIC(12,2) NOT NULL CHECK (amount > 0),          -- en la moneda del pago
  currency      TEXT NOT NULL,
  exchange_rate NUMERIC(18,6) NOT NULL DEFAULT 1 CHECK (exchange_rate > 0), -- unidades de la moneda del pago por 1 de moneda base
  amount_base   NUMERIC(12,2) NOT NULL CHECK (amount_base > 0),     -- lo que cuenta para el saldo
  method        TEXT NOT NULL,
  reference     TEXT,
  paid_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  note          TEXT,
  created_at    TIMESTAMPTZ DEFAULT now(),
  created_by    TEXT NOT NULL DEFAULT 'owner',
  voided_at     TIMESTAMPTZ,
  void_reason   TEXT
);
CREATE INDEX IF NOT EXISTS payments_tenant_paid_at_idx ON payments (tenant_id, paid_at);
CREATE INDEX IF NOT EXISTS payments_order_idx          ON payments (order_id);
CREATE INDEX IF NOT EXISTS payments_client_idx         ON payments (client_id) WHERE client_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS order_events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id   UUID NOT NULL REFERENCES orders(id)  ON DELETE CASCADE,
  type       TEXT NOT NULL,
  data       JSONB,
  created_by TEXT DEFAULT 'owner',
  created_at TIMESTAMPTZ DEFAULT now(),
  seq        BIGINT GENERATED ALWAYS AS IDENTITY  -- orden de inserción (eventos de una misma transacción comparten created_at)
);
ALTER TABLE order_events ADD COLUMN IF NOT EXISTS seq BIGINT GENERATED ALWAYS AS IDENTITY;
DROP INDEX IF EXISTS order_events_order_idx;  -- versión anterior (order_id, created_at)
CREATE INDEX IF NOT EXISTS order_events_order_seq_idx ON order_events (order_id, created_at, seq);
CREATE INDEX IF NOT EXISTS order_events_tenant_idx    ON order_events (tenant_id);

CREATE TABLE IF NOT EXISTS tenant_settings (
  tenant_id        UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  payment_methods  JSONB NOT NULL DEFAULT '[]',
  delivery_methods JSONB NOT NULL DEFAULT '{}',
  updated_at       TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());
COMMIT;

-- Relleno, UN lote: repetir esta sentencia hasta que devuelva 0 filas (el servidor lo hace solo). Seguro de
-- reejecutar y de correr junto a pagos nuevos (SKIP LOCKED; solo toca pedidos sin ningún pago). El servidor
-- guarda el método con su nombre canónico (normalizeMethodName: "Pago móvil" -> "Pago Móvil", "Efectivo $" ->
-- "Efectivo"); a mano se guarda tal cual, y las lecturas lo normalizan igual.
BEGIN;
WITH cand AS (
  SELECT o.id FROM orders o
  WHERE o.pay_status = 'ok' AND o.amount_paid = 0 AND o.total_price > 0
    AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id)
  ORDER BY o.id LIMIT 1000 FOR UPDATE OF o SKIP LOCKED
), ins AS (
  INSERT INTO payments (tenant_id, order_id, client_id, amount, currency, exchange_rate, amount_base, method, note, paid_at, created_by)
  SELECT o.tenant_id, o.id, o.client_id, o.total_price, t.base_currency, 1, o.total_price,
         COALESCE(NULLIF(NULLIF(btrim(o.pay_method_label), '—'), ''), 'Sin Especificar'),
         'Registrado antes de la Fase 2',
         o.created_at AT TIME ZONE current_setting('TimeZone'), 'system'
  FROM cand JOIN orders o ON o.id = cand.id JOIN tenants t ON t.id = o.tenant_id
  RETURNING order_id, tenant_id, amount_base
), ev AS (
  INSERT INTO order_events (tenant_id, order_id, type, data, created_by)
  SELECT tenant_id, order_id, 'migrated', jsonb_build_object('amountBase', amount_base), 'system' FROM ins
)
UPDATE orders o SET amount_paid = ins.amount_base FROM ins WHERE o.id = ins.order_id AND o.tenant_id = ins.tenant_id;
COMMIT;

-- Marca (la pone el servidor al terminar el relleno; solo decide si el próximo arranque espera antes de escuchar)
INSERT INTO schema_migrations (name) VALUES ('2026-11-25-pagos-relleno') ON CONFLICT DO NOTHING;

-- Índice del relleno (el servidor lo crea solo en segundo plano: BACKGROUND_INDEXES). orders ya tiene datos,
-- por eso CONCURRENTLY y FUERA de transacción. Parcial y por id: la búsqueda de pedidos 'ok' sin pago en cada
-- arranque es barata (casi siempre vacío).
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_legacy_paid_id_idx ON orders (id)
--   WHERE pay_status = 'ok' AND amount_paid = 0 AND total_price > 0;

-- Comprobación (solo lectura): no debe quedar ningún pedido 'ok' con total > 0 y sin pago
-- SELECT COUNT(*) FROM orders o WHERE pay_status = 'ok' AND total_price > 0
--    AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id);          -- esperado: 0
-- Coherencia: amount_paid = suma de pagos no anulados
-- SELECT COUNT(*) FROM orders o WHERE amount_paid <> COALESCE((SELECT SUM(amount_base) FROM payments p
--    WHERE p.order_id = o.id AND p.voided_at IS NULL), 0);                        -- esperado: 0

-- Rollback (ANTES de que se registren pagos nuevos; después se perderían cobros reales):
-- DROP INDEX CONCURRENTLY IF EXISTS orders_legacy_paid_id_idx;   -- fuera de transacción
-- BEGIN;
--   DROP TABLE IF EXISTS payments;
--   DROP TABLE IF EXISTS order_events;
--   DROP TABLE IF EXISTS tenant_settings;
--   ALTER TABLE orders  DROP COLUMN IF EXISTS amount_paid;
--   ALTER TABLE tenants DROP COLUMN IF EXISTS base_currency;
--   DELETE FROM schema_migrations WHERE name = '2026-11-25-pagos-relleno';
-- COMMIT;
-- (orders.pay_status conserva el valor 'ok'/'pend'/'partial' que tenía; las filas 'partial'
--  habría que devolverlas a 'pend' con UPDATE orders SET pay_status='pend' WHERE pay_status='partial'.)
-- Nota: el servidor de ESTA versión no arranca sin estas tablas; un rollback exige desplegar antes la versión anterior.
