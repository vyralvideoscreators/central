-- ══════════════════════════════════════════════════════════════
-- CENTRAL — índice de artículos por pedido (24-nov-2026)
--
-- server.js hace ESTO MISMO automáticamente al arrancar, en segundo plano después
-- de empezar a escuchar (ensureIndexes, con advisory lock para que dos réplicas no
-- lo construyan a la vez). Idempotente. No modifica datos.
--
-- CONCURRENTLY: no bloquea escrituras mientras se construye y debe ejecutarse FUERA
-- de una transacción: en psql sin BEGIN y sin -1 / --single-transaction; en un
-- cliente gráfico, con autocommit activado.
--
-- Sirve para: la lista de pedidos (JOIN por order_id), editar pedidos, informes y
-- el ON DELETE CASCADE de orders (borrar un negocio o "Hacer real" una demo), que
-- hasta ahora recorrían order_items entera. Es índice de clave foránea, por eso va
-- solo por order_id (un UUID único por pedido).
-- ══════════════════════════════════════════════════════════════

CREATE INDEX CONCURRENTLY IF NOT EXISTS order_items_order_idx ON order_items (order_id);

-- Si una construcción se interrumpe, el índice queda INVÁLIDO; el servidor lo detecta,
-- lo borra y lo rehace en el siguiente arranque.
-- Comprobación (solo lectura):
-- SELECT c.relname, i.indisvalid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
--  WHERE c.relname = 'order_items_order_idx';

-- Rollback (sin pérdida de datos):
-- DROP INDEX CONCURRENTLY IF EXISTS order_items_order_idx;
