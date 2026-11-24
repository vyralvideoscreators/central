-- ══════════════════════════════════════════════════════════════
-- CENTRAL — pedidos vinculados a la ficha del cliente (17-nov-2026)
--
-- server.js ejecuta ESTO MISMO automáticamente al arrancar (initDB); el relleno del paso 3
-- solo corre la primera vez (cuando se crea la columna convo_key). Todo es
-- idempotente: se puede correr varias veces sin efecto adicional.
-- Este archivo sirve para revisarlo o aplicarlo a mano ANTES del deploy, después
-- de hacer el respaldo de la base con backend/scripts/respaldo-produccion.ps1 (pg_dump).
--
-- Nada de esto borra datos: añade una columna, dos índices y rellena
-- orders.client_id donde está vacío.
-- ══════════════════════════════════════════════════════════════

-- 1) La conversación (waId o ig_…) de la que salió cada ficha. Evita fichas
--    duplicadas cuando se hacen varios pedidos desde el mismo chat.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS convo_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS clients_tenant_convo_key_uniq
  ON clients (tenant_id, convo_key) WHERE convo_key IS NOT NULL;

-- 2) Búsqueda de los pedidos de una ficha
CREATE INDEX IF NOT EXISTS orders_tenant_client_idx ON orders (tenant_id, client_id);

-- 3) Pedidos antiguos sin ficha: se vinculan SOLO si en ese negocio hay
--    exactamente un cliente con ese nombre. Si hay dos con el mismo nombre,
--    el pedido se queda sin vincular (mejor eso que mezclar historiales).
UPDATE orders o SET client_id = c.id
FROM clients c
WHERE o.client_id IS NULL AND c.tenant_id = o.tenant_id AND c.name = o.client_name
  AND (SELECT COUNT(*) FROM clients c2 WHERE c2.tenant_id = o.tenant_id AND c2.name = o.client_name) = 1;

-- Comprobación (solo lectura): pedidos con y sin ficha por negocio
-- SELECT tenant_id, COUNT(*) FILTER (WHERE client_id IS NOT NULL) con_ficha,
--        COUNT(*) FILTER (WHERE client_id IS NULL) sin_ficha
-- FROM orders GROUP BY tenant_id;
