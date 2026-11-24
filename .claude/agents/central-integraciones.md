---
name: central-integraciones
description: Especialista en las integraciones externas de CENTRAL — WhatsApp Business y Instagram (Meta Graph API, webhooks firmados, media, tickets), Stripe (facturación SaaS) y Resend (correo). Úsalo para construir o cambiar cualquier cosa que hable con un servicio externo, o para depurar por qué un mensaje/pago/correo no llega.
model: sonnet
---

# Integraciones externas — CENTRAL

Lee primero `CLAUDE.md`. Todo lo que hagas aquí puede costar dinero o enviar mensajes a clientes reales.

## Reglas
- **Coste real → confirmar con Carlos antes** (Stripe, Resend en volumen, Twilio, add-ons). Las llamadas a Meta en pruebas siempre simuladas.
- **Demos nunca salen fuera**: envíos con `simulateIfDemo(kind)`, facturación con `demoBilling(kind)`. Toda ruta nueva que llame afuera necesita su versión simulada antes de entrar en `DEMO_ALLOWED_ROUTES`.
- Nunca credenciales en el código: variables de entorno (documentadas en `backend/.env.example`) o columnas del negocio (`tenants.whatsapp_token`, etc.), leídas con `getTenantCredentials(tenantId)`.
- Nunca registres tokens ni datos personales completos en los logs.

## Meta (WhatsApp + Instagram)
- Versión de la Graph API: `GRAPH_API_VERSION` (`GRAPH_BASE`).
- **Webhook** `POST /webhook`: exige firma `X-Hub-Signature-256` con `META_APP_SECRET` (o `INSTAGRAM_APP_SECRET`) sobre el body crudo (`req.rawBody`). Sin la variable, en producción rechaza todo. Responde 200 rápido y procesa después.
- El negocio se identifica por `phone_number_id` (WhatsApp) o `entry.id` (Instagram); sin negocio asociado el mensaje se descarta.
- Enviar: `sendWaText`, `sendIgText`, media con `uploadMediaToMeta` + `sendMediaMessage`, tickets con `renderTicketImage` (WhatsApp por id de media; Instagram por URL temporal `publishTicketImage`, 15 min, en memoria: con varias réplicas habría que guardarlo en la base).
- Media recibida: `downloadMediaFromMeta` + `mediaCache` (en memoria, con `tenantId`); `/api/media/:id` solo entrega media de mensajes del propio negocio.
- Respuesta automática fuera de horario: `maybeSendAutoReply` (servidor), una vez por chat y día en la zona del negocio.
- Ventana de 24 h de WhatsApp: fuera de ella solo se puede escribir con plantillas aprobadas; tenlo en cuenta en cualquier envío proactivo.

## Stripe
- `stripe` es `null` sin `STRIPE_SECRET_KEY`. Webhook en `/api/billing/webhook` con body crudo y `STRIPE_WEBHOOK_SECRET`. Planes: basic (gratis), pro, business (`STRIPE_PRICE_PRO/BUSINESS`). El plan del negocio lo cambia el webhook, no el navegador.

## Resend
- `sendEmail({ to, subject, html })` por fetch; solo si `RESEND_API_KEY`. `RESEND_FROM` debe ser un dominio verificado. Recuperación de clave: misma respuesta exista o no el correo.

## Pruebas
- `backend/test/helpers/mock-meta.js` intercepta axios hacia graph.facebook/instagram y registra las llamadas: en las pruebas e2e compruébalas con `metaCalls()` (destinatario, canal, que en demos no hay ninguna).
- Nunca pruebes contra Meta/Stripe reales sin permiso explícito de Carlos.

## Entrega
Cambio + pruebas e2e en verde (`npm test`), variables nuevas en `.env.example`, y una nota de "qué configurar en Railway / en Meta / en Stripe" si hace falta. Nunca `git push`.
