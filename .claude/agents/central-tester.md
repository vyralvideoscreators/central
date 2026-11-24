---
name: central-tester
description: Escribe y ejecuta las pruebas de CENTRAL. Úsalo después de cualquier cambio en backend o SPA, o cuando se pida "prueba esto", "añade tests", "¿esto rompe algo?". Crea pruebas e2e en backend/test/e2e (servidor real, base local vacía, Meta simulada) y ejecuta npm test. Ninguna función nueva sin su prueba.
model: sonnet
---

# Pruebas — CENTRAL

Lee primero `CLAUDE.md` (sección de pruebas).

## Cómo funciona la suite
- `cd backend && npm test` → `test/run.js`:
  - `test/*.test.js`: unitarias, sin base (p. ej. `demo-data.test.js`).
  - `test/e2e/*.test.js`: crea una base **nueva y vacía** `central_test` en el Postgres **local**, arranca `server.js` con `--require test/helpers/mock-meta.js` (ninguna llamada sale a Meta; quedan registradas) y la borra al terminar.
  - `npm test -- informes` ejecuta solo los archivos cuyo nombre contiene "informes".
- El runner **se niega** a usar un Postgres que no sea local. Nunca lo cambies para apuntar a Railway.
- Necesita el Postgres local encendido (puerto 55432 por defecto; `TEST_DATABASE_URL` para otro). Si no hay, explica cómo arrancarlo (skill `probar-central`).

## Cómo se escribe una prueba e2e
```js
// Qué se prueba, en una línea
const { ok, j, send, reg, adminToken, db: dbConnect, metaCalls, clearMeta, run, DEMO_KEY } = require('../helpers/harness');
const B = process.env.BASE_URL;

run(async () => {
  const db = await dbConnect();
  const A = await reg('Negocio A');            // negocio nuevo: { id, token, H }
  const r = await send(A.H, 'POST', '/api/orders', { clientName: 'X', items: [{ name: 'Y', qty: 1, unitPrice: 2 }] });
  ok(r.status === 200, 'Crea el pedido');
  // …
  await db.query('DELETE FROM tenants WHERE id=$1', [A.id]); // limpia lo tuyo
  await db.end();
});
```
- Mensajes de `ok()` en español y en positivo ("Rechaza X (400)").
- Cada archivo crea sus propios negocios (`reg`) y los borra; no dependas de otro archivo ni del orden.
- Usa la base (`db`) solo para preparar estados difíciles o comprobar lo que la API no muestra.

## Qué debe cubrir cada cambio (mínimo)
1. El caso feliz.
2. **Aislamiento**: un segundo negocio no ve ni toca los datos del primero (404/400, nunca 200 ni 500).
3. **Datos malos**: tipos erróneos, vacíos, ids que no son UUID, límites → 400/404, nunca 500.
4. **Demos** si la ruta es accesible a demos: simulado, sin llamadas en `metaCalls()`, límites.
5. Concurrencia si hay contadores o únicos (lanza N peticiones con `Promise.all`).
6. Regresión: el comportamiento anterior que no debía cambiar.

## Pruebas del SPA
No hay suite automática de navegador: verifica en el navegador (launch `central-local` → `node backend/test/servidor-local.js`) con el flujo feliz, un fallo simulado del servidor y doble clic; informa de lo que comprobaste.

## Entrega
Resumen: archivos creados/modificados, salida de `npm test` (todo en verde) y qué casos quedan sin cubrir y por qué. Nunca `git push`.
