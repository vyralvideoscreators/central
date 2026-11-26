-- ══════════════════════════════════════════════════════════════
-- CENTRAL — Fase 4A: dinero y existencias (27-nov-2026)
--
-- server.js hace ESTO MISMO automáticamente al arrancar (initDB → ensureStockExpensesSchema en backend/operacion.js).
-- Este archivo es para revisarlo / respaldarlo. HAZ RESPALDO ANTES (backend/scripts/respaldo-produccion.ps1).
-- No hay relleno de datos: los pedidos y productos anteriores quedan sin costo (unit_cost / cost NULL), sin control de
-- existencias (track_stock = false) y sin variante (variant_key NULL).
--
-- Cómo se aplica: SOLO DDL, en una transacción corta con pg_advisory_xact_lock (72616105) y lock_timeout 5 s; antes de
-- cada ALTER/CREATE comprueba si ya existe (en un arranque normal no ejecuta ningún DDL). Hasta 4 intentos; si el
-- esquema sigue incompleto, el servidor sale con error y Railway conserva la versión anterior. Todas las columnas nuevas
-- son NULL o llevan DEFAULT constante (instantáneo en PG ≥ 11: no reescriben order_items). No hay índices en tablas
-- grandes existentes; los de las 4 tablas nuevas (vacías) se crean en el mismo DDL.
-- Defensa: la base se comparte con Kisses (prefijo kp_). Si una de las 4 tablas nuevas ya existe SIN las columnas
-- propias de CENTRAL, o un índice con nuestro nombre es de otra tabla, el servidor NO arranca (process.exit(1)).
--
-- Qué hace
--   1) Gastos: tabla expenses (solo se insertan o se anulan con motivo; todo en moneda base: amount_base).
--      Categorías editables en tenant_settings.expense_categories (NULL = lista por defecto de 7).
--   2) Cierre de caja por día: cash_closings. Un día cerrado a la vez (índice único parcial WHERE reopened_at IS NULL);
--      reabrir NO borra: marca reopened_at/reopen_reason y se conserva el historial. Con el día cerrado el servidor rechaza
--      pagos, anulaciones de pago, reembolsos y gastos de ese día (comprobado dentro de la misma transacción; la fila del
--      tenant se bloquea FOR SHARE en operaciones de dinero y FOR UPDATE al cerrar/reabrir).
--   3) Costo y existencias: catalog_products.cost (≥ 0) y track_stock; order_items.unit_cost (foto del costo al vender)
--      y variant_key; stock_levels (nivel por producto y variante, puede ser negativo) y stock_movements (historial).
-- ══════════════════════════════════════════════════════════════

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS cost        NUMERIC(12,2) CHECK (cost IS NULL OR cost >= 0);
ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS track_stock BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE order_items      ADD COLUMN IF NOT EXISTS unit_cost   NUMERIC(12,2);
ALTER TABLE order_items      ADD COLUMN IF NOT EXISTS variant_key TEXT;
ALTER TABLE tenant_settings  ADD COLUMN IF NOT EXISTS expense_categories JSONB;

CREATE TABLE IF NOT EXISTS expenses (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  spent_on      DATE NOT NULL,                       -- día del negocio (su zona horaria)
  amount        NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  currency      TEXT NOT NULL,
  exchange_rate NUMERIC(18,6) NOT NULL DEFAULT 1 CHECK (exchange_rate > 0),
  amount_base   NUMERIC(12,2) NOT NULL CHECK (amount_base > 0),
  category      TEXT NOT NULL,
  method        TEXT NOT NULL,
  note          TEXT,
  created_by    TEXT NOT NULL DEFAULT 'owner',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at     TIMESTAMPTZ,
  void_reason   TEXT
);

CREATE TABLE IF NOT EXISTS cash_closings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  day           DATE NOT NULL,
  -- Por MÉTODO Y MONEDA: claves "método|MONEDA" (ej. "Efectivo|USD", "Efectivo|VES"), con el importe ORIGINAL de cada moneda.
  -- (Los cierres antiguos, con claves solo por método, se leen como moneda base.)
  expected      JSONB NOT NULL,                      -- { "método|MONEDA": cobros − reembolsos − gastos }
  counted       JSONB NOT NULL,                      -- { "método|MONEDA": importe contado }
  difference    JSONB NOT NULL,                      -- { "método|MONEDA": contado − esperado }
  note          TEXT,
  closed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_by     TEXT NOT NULL DEFAULT 'owner',
  reopened_at   TIMESTAMPTZ,
  reopen_reason TEXT
);

CREATE TABLE IF NOT EXISTS stock_levels (
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id  UUID NOT NULL REFERENCES catalog_products(id) ON DELETE CASCADE,
  variant_key TEXT NOT NULL DEFAULT '',              -- '' sin variante; si no, «talla|color» normalizado
  qty         INTEGER NOT NULL DEFAULT 0,            -- puede quedar negativo (se permite vender sin existencias)
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, product_id, variant_key)
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id  UUID NOT NULL REFERENCES catalog_products(id) ON DELETE CASCADE,
  variant_key TEXT NOT NULL DEFAULT '',
  delta       INTEGER NOT NULL CHECK (delta <> 0),
  qty_after   INTEGER NOT NULL,
  reason      TEXT NOT NULL CHECK (reason IN ('sale','cancel','return','edit','adjust_in','adjust_out','count')),
  order_id    UUID REFERENCES orders(id) ON DELETE SET NULL,
  note        TEXT,
  created_by  TEXT NOT NULL DEFAULT 'owner',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tablas NUEVAS (vacías): sus índices se crean aquí
CREATE INDEX IF NOT EXISTS expenses_tenant_spent_idx    ON expenses (tenant_id, spent_on);
CREATE UNIQUE INDEX IF NOT EXISTS cash_closings_open_day_uniq ON cash_closings (tenant_id, day) WHERE reopened_at IS NULL;
CREATE INDEX IF NOT EXISTS cash_closings_tenant_day_idx ON cash_closings (tenant_id, day);
CREATE INDEX IF NOT EXISTS stock_levels_product_idx     ON stock_levels (product_id);
CREATE INDEX IF NOT EXISTS stock_movements_product_idx  ON stock_movements (tenant_id, product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS stock_movements_fk_product_idx ON stock_movements (product_id);  -- ON DELETE CASCADE de catalog_products
CREATE INDEX IF NOT EXISTS stock_movements_order_idx    ON stock_movements (order_id) WHERE order_id IS NOT NULL;

COMMIT;

-- Índice GRANDE (orders ya tiene datos): NO va en initDB sino en BACKGROUND_INDEXES (server.js), que lo crea DESPUÉS de empezar a
-- escuchar, fuera de transacción y con un advisory lock. Aquí solo queda documentado; CONCURRENTLY no puede ir dentro de BEGIN/COMMIT.
-- Informes, utilidad y por cobrar filtran pedidos por (negocio, fecha de creación) sobre created_at crudo:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_tenant_created_idx ON orders (tenant_id, created_at);
