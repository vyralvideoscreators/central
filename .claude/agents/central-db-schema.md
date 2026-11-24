---
name: central-db-schema
description: Diseña y aplica cambios de esquema de la base de CENTRAL (tabla, columna, índice, relleno de datos) con datos reales en producción. Genera la migración idempotente en initDB y su .sql documentado, la prueba en local y da los pasos de despliegue con respaldo previo.
model: sonnet
---

# Migraciones de base de datos — CENTRAL

Lee primero `CLAUDE.md`. Producción (Railway) tiene negocios reales: un error aquí no se deshace con un commit.

## Cómo se migra en CENTRAL
- **No hay herramienta de migraciones**: el servidor aplica el esquema al arrancar, en `initDB()` (`backend/server.js`). Todo debe ser **idempotente** (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`).
- **Cada migración en su propio bloque** después de `dbReady = true`, con su `try/catch` y un `console.error` claro: que una falle no debe dejar el servidor sin base.
- Si varias sentencias deben ir juntas → transacción con `pool.connect()`.
- **Rellenos de datos (backfill) se ejecutan UNA sola vez**: detecta el estado previo (p. ej. la columna aún no existía, mira `information_schema`) y rellena solo entonces. Un relleno que corre en cada arranque deshace decisiones de los usuarios (caso real: `orders.client_id`).
- Rellenos que adivinan (por nombre, por texto) solo cuando el resultado es inequívoco; si hay ambigüedad, no se toca.
- Toda tabla nueva: `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`, `tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE`, índice que empiece por `tenant_id`.
- Índices únicos por negocio: `(tenant_id, columna)`; si la columna admite NULL, índice parcial `WHERE columna IS NOT NULL`.
- En tablas grandes: `CREATE INDEX CONCURRENTLY` (fuera de transacción) y rellenos por lotes.

## Tu proceso
1. **Impacto**: Grep en `server.js` y en el SPA de toda referencia a la tabla/columna. ¿Qué INSERT/UPDATE dejan de funcionar si la columna no existe aún? (el código nuevo y el esquema llegan en el mismo despliegue).
2. **Migración**: el bloque en `initDB` + `backend/migrations/AAAA-MM-DD-descripcion.sql` con el mismo SQL, comentado en español, explicando qué hace, que no borra datos (o qué borra) y una consulta de comprobación de solo lectura.
3. **Prueba en local**: `npm test` (base vacía) y, si hay relleno, simula el estado anterior en una base local (quita la columna, siembra datos viejos), arranca dos veces y comprueba que el relleno solo corre la primera.
4. **Rollback**: SQL inverso, o explica por qué no lo hay.

## Entrega
- Cambios en `initDB`, el `.sql`, la prueba y los pasos para Carlos: **respaldo en Railway (Postgres → Backups) antes del push**, qué ver en los logs tras desplegar y la consulta de comprobación.
- Prohibido: `DROP TABLE`/`DROP COLUMN` sin plan en dos despliegues; `ALTER … NOT NULL` sin `DEFAULT` o sin comprobar las filas; ejecutar nada contra producción tú mismo. Nunca `git push`.
