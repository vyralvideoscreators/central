---
name: desplegar-central
description: Acompaña un despliegue de CENTRAL a producción (Railway). ANTES del push - pasa el control central-deploy y da a Carlos el veredicto y los pasos (respaldo, variables, comando). DESPUÉS del push - verifica en solo lectura que el build terminó, que /health responde con base de datos, los logs de migración y que Kisses sigue en pie. Úsala con "voy a subir", "prepárame el deploy", "hice el push, verifícalo". Nunca hace push ni cambia nada en Railway.
---

# Desplegar CENTRAL

**El push lo hace Carlos** (además `git push` está bloqueado en los permisos). Esta skill prepara y verifica; no despliega ni modifica nada en Railway.

## A. Antes del push
1. Si hay cambios sin revisar, propone primero la skill `revisar-central`.
2. Lanza el agente **`central-deploy`** (pruebas, migraciones, variables, dependencias) y espera su veredicto.
3. Entrega a Carlos, corto y claro:
   - qué se va a desplegar (en lenguaje de negocio);
   - **pasos previos**: respaldo en Railway (Postgres → Backups) si hay cambio de esquema; variables a crear en Railway; configuración en Meta/Stripe si aplica;
   - el comando en su propio bloque: `git push origin main`;
   - qué comprobarás después.

## B. Después del push ("hice el push, verifícalo")
Todo en **solo lectura**:
1. **Código**: `git fetch` y comprobar que `origin/main` tiene el commit esperado (`git log --oneline -3 origin/main`).
2. **Build/deploy en Railway** (proyecto `diligent-wonder`, servicio `central-backend`): con la CLI (`railway.cmd`, en PowerShell `railway.ps1` está bloqueado) o la API GraphQL de solo lectura (`backboard.railway.com/graphql/v2`, token de `~/.railway/config.json`): el último despliegue del servicio tiene el commit esperado y estado `SUCCESS`. Si sigue construyendo, esperar y volver a mirar (sin bucles agresivos).
3. **Salud**: `curl -s https://central-backend-production.up.railway.app/health` → `{"status":"ok","db":true}`.
4. **Logs**: últimas líneas del arranque del servicio: migraciones esperadas (p. ej. `✅ … aplicadas`), ningún `❌`/`⚠️` nuevo, `escuchando en puerto`.
5. **Páginas públicas**: `/central-registro.html`, `/central-admin.html` y `/app` responden 200; `/server.js` responde 404.
6. **Kisses** (comparte la base `railway`): su servicio `kissesandpaws` sigue `SUCCESS` y su `/health` responde.
7. No pruebes con cuentas reales ni crees datos en producción. Si hace falta una prueba funcional, pide a Carlos que la haga (login → pedido → ticket → informes) y dile exactamente qué mirar.

## C. Si algo falla
- Build fallido: leer el log de build y localizar la causa (dependencia, sintaxis, nixpacks, variable). Proponer el arreglo como commit nuevo; el push lo hace Carlos.
- Servidor caído o `/health` sin base: revisar logs; si es urgente, recomendar a Carlos **volver al despliegue anterior** desde Railway (Deployments → Redeploy del anterior). Restaurar el respaldo de la base solo si una migración dañó datos, y solo él.

## Informe
Una tabla corta "comprobación → resultado" y el veredicto: desplegado y sano / desplegado con avisos / con problemas (qué hacer).
