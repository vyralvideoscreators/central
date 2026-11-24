-- ══════════════════════════════════════════════════════════════
-- CENTRAL — descuento por pedido (24-nov-2026)
--
-- server.js ejecuta ESTO MISMO automáticamente al arrancar (initDB). Todo es
-- idempotente: se puede correr varias veces sin efecto adicional.
-- Este archivo sirve para revisarlo o aplicarlo a mano ANTES del deploy, después
-- de hacer el respaldo de la base con backend/scripts/respaldo-produccion.ps1 (pg_dump).
--
-- Nada de esto borra ni modifica datos existentes: añade una columna con valor
-- por defecto 0 (todos los pedidos actuales quedan sin descuento) y un CHECK.
-- No hay relleno de datos.
-- ══════════════════════════════════════════════════════════════

-- 1) Importe de descuento del pedido (en dinero, no en %). Siempre >= 0.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount NUMERIC(10,2) NOT NULL DEFAULT 0;

-- 2) No se permiten descuentos negativos. NOT VALID + VALIDATE para bloquear
--    la tabla lo mínimo; solo se crea si todavía no existe.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_discount_nonneg' AND conrelid = 'orders'::regclass) THEN
    ALTER TABLE orders ADD CONSTRAINT orders_discount_nonneg CHECK (discount >= 0) NOT VALID;
    ALTER TABLE orders VALIDATE CONSTRAINT orders_discount_nonneg;
  END IF;
END $$;

-- Comprobación (solo lectura): la columna existe y todos los pedidos antiguos tienen 0
-- SELECT COUNT(*) total, COUNT(*) FILTER (WHERE discount <> 0) con_descuento FROM orders;
-- SELECT conname FROM pg_constraint WHERE conname = 'orders_discount_nonneg';

-- Rollback (solo si hiciera falta; el código nuevo dejaría de funcionar con descuentos):
-- ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_discount_nonneg;
-- ALTER TABLE orders DROP COLUMN IF EXISTS discount;  -- pierde los descuentos guardados
