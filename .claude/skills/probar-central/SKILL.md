---
name: probar-central
description: Prueba CENTRAL en local — enciende el Postgres local, ejecuta la suite (npm test) o levanta el servidor local con Meta simulada para probar en el navegador. Úsala cuando se pida "prueba", "corre los tests", "¿esto rompe algo?", "levanta CENTRAL en local", "quiero verlo en el navegador", o antes de entregar cualquier cambio de backend o SPA. Nunca usa la base de producción.
---

# Probar CENTRAL en local

Todo ocurre en esta máquina: Postgres local, servidor con Meta simulada y sin ninguna clave real. **Nunca** se apunta a Railway (el runner y el servidor local se niegan).

## 1. Postgres local
```bash
cd backend && node test/pg-local.js status
```
- `encendido` → seguir.
- `apagado` o `no creado` → `node test/pg-local.js start` (la primera vez lo crea en `%USERPROFILE%\.central-pg`, puerto 55432).
- Si no encuentra PostgreSQL: necesita estar instalado (en este equipo está en `C:\Program Files\PostgreSQL\18`); si está en otro sitio, `PG_BIN=<carpeta bin>`.
- Al terminar la sesión puede apagarse con `node test/pg-local.js stop` (no es obligatorio).

## 2. Suite de pruebas
```bash
cd backend && npm test              # todo
cd backend && npm test -- informes  # solo archivos cuyo nombre contiene "informes"
```
- Crea una base vacía `central_test`, arranca el servidor con Meta simulada, ejecuta `test/*.test.js` y `test/e2e/*.test.js` y lo borra todo.
- Salida: una línea por archivo (✔/✘, nº de comprobaciones). Si algo falla, muestra las líneas `FAIL`.
- Antes de dar algo por terminado: **todo en verde**. Si un fallo no tiene que ver con el cambio, dilo; no lo ocultes ni borres la prueba.
- Comprobaciones rápidas adicionales:
  - `node --check backend/server.js`
  - los `<script>` del SPA parsean:
    ```bash
    node -e "const s=require('fs').readFileSync('backend/central-mvp-v63 (1) - copia.html','utf8');[...s.matchAll(/<script>([\s\S]*?)<\/script>/g)].forEach((m,i)=>{try{new Function(m[1])}catch(e){console.log('script',i,e.message);process.exitCode=1}})"
    ```

## 3. Probar a mano en el navegador
- Arrancar con el launch **`central-local`** (`preview_start`) o `node backend/test/servidor-local.js` → http://localhost:3999.
- Base persistente `central_dev` (los datos se conservan entre arranques). Admin del panel: `admin@test.local` / `adminpass` (`/central-admin.html`), clave de demos `0123456789abcdef0123456789abcdef01234567`.
- Para entrar al SPA: crear una cuenta en `/central-registro.html` (o con `POST /api/tenant/register`).
- Mensajes a WhatsApp/Instagram: simulados, quedan en `backend/test/.meta-calls.jsonl`.
- Para simular un chat entrante, insertar en `conversations`/`messages` de `central_dev` con el `tenant_id` de la cuenta (psql en `C:\Program Files\PostgreSQL\18\bin\psql.exe -p 55432 -U postgres -d central_dev`).
- Casos a comprobar en un cambio de pantalla: flujo feliz, fallo del servidor (en la consola: sustituir `window.fetch` por uno que devuelva 500 para la ruta) y doble clic. Revisar la consola sin errores.

## 4. Informe
Di qué se ejecutó y el resultado (copiar el resumen de `npm test`), qué se comprobó a mano y qué no se pudo probar (p. ej. envíos reales a Meta, Stripe, varias réplicas).
