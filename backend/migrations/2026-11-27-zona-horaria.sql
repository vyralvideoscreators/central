-- Zona horaria = la de la ubicación del negocio (país + zona). Documentación del relleno de datos que hace initDB
-- (backfillTenantTimezones en server.js). NO cambia el esquema: tenants.country y tenants.timezone ya existen.
--
-- Regla: tenants.timezone se fija SOLO desde la ubicación (país y zona), nunca desde el navegador.
--   · País con una zona (Venezuela, Colombia, Argentina…): esa zona.
--   · País con varias (México 6, Chile 2, Ecuador 2, España 2): la primera de la lista por defecto; el negocio elige otra en Ajustes.
--   · «Otro»: sin zona por defecto (lista amplia de América y Europa para elegir).
--   · Sin país (cuentas antiguas): no se toca (se respeta la zona que ya tuvieran).
--
-- El servidor lo hace en cada arranque, de forma idempotente y barata (tenants es una tabla pequeña); equivale a, para cada país
-- con zona por defecto (aquí Venezuela como ejemplo):
UPDATE tenants
   SET timezone = 'America/Caracas'
 WHERE country = 'Venezuela'
   AND (timezone IS NULL OR timezone <> ALL (ARRAY['America/Caracas']));
-- (La lista completa de países y zonas está en operacion.js → COUNTRY_TIMEZONES.)
--
-- Respaldo previo: no hace falta (solo actualiza zonas que faltaban o eran de otro país). Para revisarlo antes:
--   SELECT country, timezone, COUNT(*) FROM tenants GROUP BY 1, 2 ORDER BY 1, 2;
