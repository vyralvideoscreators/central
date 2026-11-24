// Entorno para arrancar server.js en local (pruebas y servidor de desarrollo):
// base de datos local, claves de prueba y TODAS las claves de servicios externos vacías.
const path = require('path');

const DEFAULT_ADMIN_URL = 'postgres://postgres@127.0.0.1:55432/postgres';

// Solo Postgres en esta máquina. Nunca Railway.
function assertLocalDb(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error('La URL de la base no es válida'); }
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname) || /railway|rlwy/i.test(url)) {
    throw new Error(`Solo se permite un Postgres LOCAL. Host recibido: "${u.hostname}". ¿Seguro que no es producción?`);
  }
  return u;
}

function dbUrlFor(adminUrl, dbName) {
  const u = new URL(adminUrl);
  u.pathname = '/' + dbName;
  u.search = '?sslmode=disable';
  return u.toString();
}

function serverEnv({ port, dbUrl, metaLog }) {
  return {
    ...process.env,
    PORT: String(port), DATABASE_URL: dbUrl, APP_URL: `http://localhost:${port}`,
    JWT_SECRET: 'jwt_de_pruebas_locales_0123456789abcdef', NODE_ENV: 'test', RAILWAY_ENVIRONMENT: '',
    ADMIN_EMAIL: 'admin@test.local', ADMIN_PASSWORD: 'adminpass',
    DEMO_CREATION_KEY: '0123456789abcdef0123456789abcdef01234567',
    META_LOG: metaLog || '',
    // Vacías a propósito: dotenv no las rellena desde un .env local y nada sale a servicios reales
    RESEND_API_KEY: '', RESEND_FROM: '', STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '',
    STRIPE_PRICE_PRO: '', STRIPE_PRICE_BUSINESS: '',
    WHATSAPP_TOKEN: '', WHATSAPP_PHONE_NUMBER_ID: '', INSTAGRAM_ACCESS_TOKEN: '', INSTAGRAM_ACCOUNT_ID: '',
    META_APP_SECRET: '', INSTAGRAM_APP_SECRET: '', DEFAULT_TENANT_EMAIL: '', DEFAULT_TENANT_PASSWORD: '',
  };
}

const MOCK_META = path.join(__dirname, 'mock-meta.js');

module.exports = { DEFAULT_ADMIN_URL, assertLocalDb, dbUrlFor, serverEnv, MOCK_META };
