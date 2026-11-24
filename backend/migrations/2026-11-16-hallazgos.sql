-- ══════════════════════════════════════════════════════════════
-- CENTRAL — migración de los 10 hallazgos (16-nov-2026)
--
-- server.js ejecuta ESTO MISMO automáticamente al arrancar (initDB), y todo es
-- idempotente: se puede correr varias veces sin efecto adicional.
-- Este archivo sirve para revisarlo o aplicarlo a mano ANTES del deploy, después
-- de hacer el respaldo de la base con backend/scripts/respaldo-produccion.ps1 (pg_dump).
--
-- Nada de esto borra datos: añade columnas, rellena columnas nuevas, pasa a
-- minúsculas los correos (sin tocar los que chocarían) y crea índices.
-- ══════════════════════════════════════════════════════════════

-- 0) Columnas de recuperación de clave (ya existen en producción; por si acaso)
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS reset_token TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMP;

-- 1) Respuesta automática fuera de horario (apagada por defecto)
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS auto_reply_enabled BOOLEAN DEFAULT false;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS off_hours_message TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS business_hours JSONB;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS timezone TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_auto_reply_at TIMESTAMPTZ;

-- 2) Correos en minúsculas + índice único sin distinguir mayúsculas
--    (comprobado el 16-nov-2026: 0 choques en producción, 1 correo con mayúsculas)
UPDATE tenants t SET email = lower(trim(t.email))
WHERE t.email <> lower(trim(t.email))
  AND NOT EXISTS (SELECT 1 FROM tenants o WHERE o.id <> t.id AND lower(trim(o.email)) = lower(trim(t.email)));
CREATE UNIQUE INDEX IF NOT EXISTS tenants_email_lower_uniq ON tenants (lower(email));

-- 3) Numeración de pedidos propia de cada negocio
BEGIN;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS order_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders  ADD COLUMN IF NOT EXISTS tenant_order_number INTEGER;

WITH base AS (
  SELECT tenant_id, COALESCE(MAX(tenant_order_number), 0) AS mx FROM orders GROUP BY tenant_id
), n AS (
  SELECT o.id, b.mx + ROW_NUMBER() OVER (PARTITION BY o.tenant_id ORDER BY o.created_at, o.order_number) AS rn
  FROM orders o JOIN base b ON b.tenant_id = o.tenant_id
  WHERE o.tenant_order_number IS NULL
)
UPDATE orders o SET tenant_order_number = n.rn FROM n WHERE o.id = n.id;

UPDATE tenants t SET order_seq = s.mx
FROM (SELECT tenant_id, MAX(tenant_order_number) AS mx FROM orders GROUP BY tenant_id) s
WHERE t.id = s.tenant_id AND t.order_seq < s.mx;

CREATE UNIQUE INDEX IF NOT EXISTS orders_tenant_order_number_uniq ON orders (tenant_id, tenant_order_number);
COMMIT;

-- Comprobación (solo lectura): cada negocio con sus pedidos numerados 1..N
-- SELECT tenant_id, COUNT(*) pedidos, MIN(tenant_order_number), MAX(tenant_order_number)
-- FROM orders GROUP BY tenant_id;
