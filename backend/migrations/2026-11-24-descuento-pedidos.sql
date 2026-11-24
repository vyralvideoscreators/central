-- ══════════════════════════════════════════════════════════════
-- CENTRAL — descuento por pedido (24-nov-2026)
--
-- server.js ejecuta ESTO MISMO automáticamente al arrancar (initDB). Todo es
-- idempotente: se puede correr varias veces sin efecto adicional.
-- Este archivo sirve para revisarlo o aplicarlo a mano ANTES del deploy, después
-- de hacer el respaldo de la base con backend/scripts/respaldo-produccion.ps1 (pg_dump).
--
-- Diferencias del servidor: reintenta la columna hasta 4 veces (espera 1, 2, 4 s) si la tabla
-- está ocupada; si la columna sigue sin existir, sale con process.exit(1) (los pedidos fallarían
-- sin ella). Si solo falla el CHECK, arranca igual y lo reintenta en el siguiente arranque.
--
-- Nada de esto borra ni modifica datos existentes: añade una columna con valor
-- por defecto 0 (todos los pedidos actuales quedan sin descuento) y un CHECK.
-- No hay relleno de datos.
-- ══════════════════════════════════════════════════════════════

SET lock_timeout = '5s';
-- 1) Importe de descuento del pedido (en dinero, no en %). Siempre >= 0.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount NUMERIC(10,2) NOT NULL DEFAULT 0;

-- 2) No se permiten descuentos negativos. En dos pasos separados (cada uno su propia
--    transacción corta) y con lock_timeout: si la tabla está ocupada se rinde en 5 s.
--    NOT VALID no recorre la tabla; VALIDATE la recorre sin bloquear lecturas ni escrituras.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_discount_nonneg' AND conrelid = 'orders'::regclass) THEN
    ALTER TABLE orders ADD CONSTRAINT orders_discount_nonneg CHECK (discount >= 0) NOT VALID;
  END IF;
END $$;
ALTER TABLE orders VALIDATE CONSTRAINT orders_discount_nonneg;  -- sin efecto si ya está validado
RESET lock_timeout;

-- Comprobación (solo lectura): la columna existe y todos los pedidos antiguos tienen 0
-- SELECT COUNT(*) total, COUNT(*) FILTER (WHERE discount <> 0) con_descuento FROM orders;
-- SELECT conname FROM pg_constraint WHERE conname = 'orders_discount_nonneg';

-- Rollback (solo si hiciera falta; el código nuevo dejaría de funcionar con descuentos):
-- ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_discount_nonneg;
-- ALTER TABLE orders DROP COLUMN IF EXISTS discount;  -- pierde los descuentos guardados
