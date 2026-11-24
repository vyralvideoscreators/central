---
name: central-db-schema
description: Cambiar el esquema de la base de datos de CENTRAL (nueva tabla, columna, índice, tipo) con datos reales en producción. Genera el SQL de migración seguro, verifica que no rompa el código existente y da los pasos exactos para ejecutarlo.
---

# Agente de migración DB — CENTRAL

## Contexto

- **DB**: PostgreSQL en Railway (producción con datos reales de negocios)
- **Acceso producción**: `railway run psql $DATABASE_URL` (ejecutado por Carlos)
- **Multi-tenant**: toda tabla de datos debe tener `tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE`
- **IDs**: usar `UUID DEFAULT gen_random_uuid()` para PKs

## Tu proceso

### 1. Analizar el impacto
Antes de escribir SQL:
- ¿Qué código existente en `server.js` toca esta tabla?
- ¿Hay índices que se van a invalidar?
- ¿La migración es reversible?
- ¿Hay datos existentes que migrar?

### 2. Generar SQL seguro

**Agregar columna (sin romper código existente):**
```sql
-- Siempre nullable o con DEFAULT para no bloquear filas existentes
ALTER TABLE tabla ADD COLUMN nueva_col TEXT;
-- o con DEFAULT:
ALTER TABLE tabla ADD COLUMN activo BOOLEAN DEFAULT true NOT NULL;
```

**Nueva tabla:**
```sql
CREATE TABLE IF NOT EXISTS nueva_tabla (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- ... columnas ...
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_nueva_tabla_tenant ON nueva_tabla(tenant_id);
```

**Nuevo índice (puede tardar en tablas grandes):**
```sql
-- Usar CONCURRENTLY para no bloquear la tabla
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_nombre ON tabla(columna);
```

**Renombrar columna (necesita actualizar código simultáneamente):**
```sql
-- Paso 1: agregar columna nueva
ALTER TABLE tabla ADD COLUMN nueva TEXT;
-- Paso 2: copiar datos
UPDATE tabla SET nueva = vieja;
-- Paso 3: (después de deployar código que usa la nueva): eliminar vieja
ALTER TABLE tabla DROP COLUMN vieja;
```

### 3. Verificar en `server.js`
Buscar todas las queries que tocan la tabla modificada y confirmar que:
- Siguen funcionando con el esquema nuevo
- Si se agregó NOT NULL sin DEFAULT: el código ya envía ese campo
- Si se eliminó una columna: el código ya no la referencia

### 4. Formato de entrega

Entregar:
1. **SQL de migración** — listo para copiar y pegar en `railway run psql`
2. **Cambios en `server.js`** — si los hay, diff exacto
3. **Pasos de ejecución** — orden exacto (¿primero código o primero DB?)
4. **Rollback** — SQL inverso si algo sale mal

## Reglas de seguridad

- **Nunca** `DROP TABLE` ni `DROP COLUMN` sin verificar que el código no la use
- **Nunca** `ALTER COLUMN ... NOT NULL` sin agregar DEFAULT o verificar que todas las filas tienen valor
- **Nunca** ejecutar en producción sin haber probado la sintaxis
- **Siempre** incluir `IF NOT EXISTS` / `IF EXISTS` para idempotencia
- Para tablas con muchas filas: usar `CONCURRENTLY` en índices, y hacer UPDATE en batches si es un backfill grande
