---
name: central-deploy
description: Checklist de deploy para CENTRAL — verificar antes de hacer push a main (que dispara deploy automático a producción en Railway). Úsalo cuando se vaya a subir cambios al backend o cambios críticos del frontend.
---

# Checklist de deploy — CENTRAL

## ⚠ Recordatorio crítico

**Push a `main` = deploy automático a producción en Railway.**
Los cambios afectan negocios reales con clientes reales.

## Ejecuta este checklist antes de aprobar el push

### 1. Código
- [ ] No hay `console.log` con datos sensibles (tokens, passwords, PII)
- [ ] No hay credenciales hardcodeadas (API keys, secrets)
- [ ] No hay archivos `.env` staged para commit
- [ ] Todas las queries SQL nuevas/modificadas filtran por `tenant_id`
- [ ] Los endpoints nuevos usan `requireAuth`
- [ ] Los errores responden con `err.message`, no con el stack completo

### 2. Base de datos
- [ ] Si hay migración de esquema (nueva tabla/columna/índice): ¿se ejecutó en producción?
- [ ] Si se eliminó o renombró una columna: ¿el código viejo ya no la usa?
- [ ] Las queries nuevas fueron probadas con `railway run` contra la DB de producción

### 3. Variables de entorno
- [ ] Las variables nuevas están en `.env.example`
- [ ] Si la variable es requerida en runtime: ¿está configurada en Railway?
  - Ir a Railway → proyecto → Variables para verificar

### 4. nixpacks / build
- [ ] `backend/nixpacks.toml` no tiene paquetes inválidos (solo nombres de nixpkgs reales)
- [ ] `backend/package.json` incluye todas las dependencias nuevas

### 5. Integraciones externas
- [ ] Si se modificó el webhook de WhatsApp/Instagram: ¿el verify token sigue igual?
- [ ] Si se modificó Stripe webhook: ¿el secret sigue configurado?
- [ ] Si se usó Resend: ¿`RESEND_FROM` usa un dominio verificado en producción?

### 6. Frontend
- [ ] Los cambios al HTML no rompen la estructura de vistas existentes
- [ ] `BACKEND_URL` apunta a producción (no a localhost)
- [ ] Los loaders tienen fallback a datos demo

## Después del deploy

1. Abrir Railway → Deployments → ver que el build pase
2. Verificar `/health` endpoint: `https://central-backend-production.up.railway.app/health`
3. Probar el flujo crítico: login → crear pedido → ver en lista

## Si el build falla

Causas más comunes en CENTRAL:
- `nixpacks.toml` con nombre de paquete inválido
- Dependencia nueva en código pero no en `package.json`
- Error de sintaxis en `server.js` (Node 18 strict)
- Variable de entorno requerida no configurada en Railway
