-- ══════════════════════════════════════════════════════════════
-- CENTRAL — índice de artículos por pedido (24-nov-2026)
--
-- server.js ejecuta ESTO MISMO automáticamente al arrancar (initDB). Idempotente.
-- No modifica datos. CONCURRENTLY: no bloquea escrituras mientras se construye y
-- debe ejecutarse FUERA de una transacción (en psql, sin BEGIN).
-- Sirve para: editar pedidos (reemplazar artículos), informes y borrar pedidos,
-- que hasta ahora recorrían order_items entera.
-- ══════════════════════════════════════════════════════════════

CREATE INDEX CONCURRENTLY IF NOT EXISTS order_items_tenant_order_idx ON order_items (tenant_id, order_id);

-- Si una construcción se interrumpe, el índice queda INVÁLIDO; initDB lo detecta, lo borra y lo rehace.
-- Comprobación (solo lectura):
-- SELECT c.relname, i.indisvalid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
--  WHERE c.relname = 'order_items_tenant_order_idx';

-- Rollback (sin pérdida de datos):
-- DROP INDEX CONCURRENTLY IF EXISTS order_items_tenant_order_idx;
