---
name: revisar-central
description: Revisa los cambios de CENTRAL con el equipo de revisores — mira qué cambió en el diff, lanza EN PARALELO solo los revisores que aplican (multitenant, seguridad, contrato API, demos, escala, diseño) y junta sus informes en uno solo ordenado por gravedad, sin duplicados. Úsala cuando se pida "revisa los cambios", "revisa antes de subir", "pásale los revisores", o al terminar una funcionalidad y antes de desplegar.
---

# Revisar cambios de CENTRAL

## 1. Qué se revisa
- Por defecto: lo que no está en producción → `git diff origin/main...HEAD` + cambios sin commitear (`git diff HEAD`). Haz `git fetch` primero.
- Si el usuario da un rango, commit o archivo, usa ese.
- Si no hay cambios, dilo y termina.

## 2. Qué revisores tocan
Clasifica con `git diff --stat` y mirando el contenido del diff:

| Si el diff… | Revisor |
|---|---|
| toca SQL (`query(`, `SELECT/INSERT/UPDATE/DELETE`, `initDB`, `migrations/`) | `revisor-multitenant` |
| toca `server.js` o el SPA (siempre que haya código) | `revisor-seguridad` |
| cambia una ruta (`app.get/post/put/patch/delete`), su cuerpo/respuesta, o un `fetch`/`apiJson` del SPA | `revisor-contrato-api` |
| toca `DEMO_ALLOWED_ROUTES`, `simulateIfDemo`, `demoBilling`, `/api/send*`, `/api/billing*`, `/api/admin*`, `demo-seed.js`, `wipeDemoData` | `revisor-demos` |
| toca listas o informes, `initDB`/migraciones, el webhook, cachés en memoria o carga datos en el SPA | `revisor-escala` |
| añade o cambia pantallas/modales/CSS del SPA | `revisor-diseno` (global) |

Si dudas, inclúyelo: es más barato revisar de más que desplegar un fallo. Solo documentación o pruebas → `revisor-contrato-api` no aplica; basta con confirmarlo.

## 3. Lanzarlos a la vez
En **un solo mensaje**, una llamada al agente por revisor (se ejecutan en paralelo). A cada uno:
- el rango exacto del diff y la lista de archivos;
- un resumen de una línea de qué pretende el cambio;
- "solo lectura; informe con el formato `[GRAVEDAD] archivo:línea — problema — escenario — arreglo`".

## 4. Informe único
- Junta los hallazgos, **quita duplicados** (el mismo problema visto por dos revisores = uno, citando a ambos) y ordénalos: CRÍTICO/GRAVE → ALTO → MEDIO → BAJO.
- Verifica los graves tú mismo leyendo el código antes de darlos por buenos; si uno no se sostiene, dilo.
- Cierra con: qué revisores pasaron sin hallazgos, y la recomendación (arreglar antes de desplegar / se puede desplegar).
- Pregunta al usuario si corrige ahora. Si dice que sí: corregir, `npm test` (skill `probar-central`) y, si el arreglo fue importante, volver a pasar solo el revisor afectado.
