// Cambio de contraseña y de correo de acceso: exigen la contraseña actual
// Se ejecuta con `npm test` (test/run.js arranca el servidor con Meta simulada y una base local vacía).
const { ok, j, send, reg, db: dbConnect, run, DEMO_KEY, adminToken } = require('../helpers/harness');
const JSONH = { 'Content-Type': 'application/json' };
const login = (email, password) => j('/api/tenant/login', { method: 'POST', headers: JSONH, body: JSON.stringify({ email, password }) });

run(async () => {
  const db = await dbConnect();
  const A = await reg('Clave A');

  // Cambio correcto
  let r = await send(A.H, 'PUT', '/api/tenant/password', { currentPassword: 'password123', newPassword: 'nuevaClave456' });
  ok(r.status === 200 && r.body.success === true, 'Cambio de contraseña → 200');
  // La sesión anterior se cierra (token_version) y la respuesta trae el token nuevo
  const oldAuth = A.H.Authorization;
  ok(!!r.body.token, 'El cambio de contraseña devuelve un token nuevo');
  ok((await j('/api/tenant/profile', { headers: { Authorization: oldAuth } })).status === 401, 'El token anterior ya no vale tras cambiar la contraseña');
  A.H.Authorization = 'Bearer ' + r.body.token;
  r = await login(A.email, 'nuevaClave456');
  ok(r.status === 200 && !!r.body.token, 'Login con la contraseña nueva');
  r = await login(A.email, 'password123');
  ok(r.status === 401, 'La contraseña vieja ya no entra');

  // Errores
  r = await send(A.H, 'PUT', '/api/tenant/password', { currentPassword: 'mala', newPassword: 'otraClave789' });
  ok(r.status === 401 && r.body.error === 'La contraseña actual no es correcta', 'Actual incorrecta → 401');
  r = await send(A.H, 'PUT', '/api/tenant/password', { currentPassword: 'nuevaClave456', newPassword: 'corta' });
  ok(r.status === 400, 'Nueva demasiado corta → 400');
  r = await send(A.H, 'PUT', '/api/tenant/password', { currentPassword: 'nuevaClave456', newPassword: 'nuevaClave456' });
  ok(r.status === 400, 'Nueva igual a la actual → 400');
  r = await send(A.H, 'PUT', '/api/tenant/password', { newPassword: 'otraClave789' });
  ok(r.status === 400, 'Sin contraseña actual → 400');
  r = await send(A.H, 'PUT', '/api/tenant/password', { currentPassword: { $ne: 1 }, newPassword: 'otraClave789' });
  ok(r.status === 400, 'Tipos raros → 400 (no 500)');
  r = await j('/api/tenant/password', { method: 'PUT', headers: JSONH, body: JSON.stringify({ currentPassword: 'x', newPassword: 'otraClave789' }) });
  ok(r.status === 401, 'Sin sesión → 401');
  ok((await login(A.email, 'nuevaClave456')).status === 200, 'Tras los rechazos la contraseña sigue siendo la nueva');

  // Correo: exige la contraseña actual
  const newEmail = 'nuevo' + Date.now() + '@test.local';
  r = await send(A.H, 'PUT', '/api/tenant/profile', { email: newEmail });
  ok(r.status === 401, 'Cambiar correo sin contraseña → 401');
  r = await send(A.H, 'PUT', '/api/tenant/profile', { email: newEmail, currentPassword: 'incorrecta' });
  ok(r.status === 401 && r.body.error === 'La contraseña actual no es correcta', 'Cambiar correo con contraseña incorrecta → 401');
  ok((await db.query('SELECT email FROM tenants WHERE id=$1', [A.id])).rows[0].email === A.email, 'El correo no cambió');
  r = await send(A.H, 'PUT', '/api/tenant/profile', { email: 'no-es-correo', currentPassword: 'nuevaClave456' });
  ok(r.status === 400, 'Correo inválido → 400');
  r = await send(A.H, 'PUT', '/api/tenant/profile', { email: newEmail.toUpperCase(), currentPassword: 'nuevaClave456' });
  ok(r.status === 200 && r.body.tenant.email === newEmail, 'Cambiar correo con la contraseña correcta → 200 (en minúsculas)');
  ok(!!r.body.token, 'Cambiar el correo del dueño devuelve un token nuevo');
  A.H.Authorization = 'Bearer ' + r.body.token;
  ok((await login(newEmail, 'nuevaClave456')).status === 200, 'Login con el correo nuevo');

  // Los demás campos no piden contraseña; repetir el mismo correo tampoco
  r = await send(A.H, 'PUT', '/api/tenant/profile', { business_name: 'Clave A2', country: 'Venezuela' });
  ok(r.status === 200 && r.body.tenant.business_name === 'Clave A2', 'Cambiar nombre del negocio sin contraseña → 200');
  r = await send(A.H, 'PUT', '/api/tenant/profile', { business_name: 'Clave A3', email: newEmail });
  ok(r.status === 200, 'Enviar el mismo correo (sin cambio) no pide contraseña');

  // Demo: la ruta nueva está bloqueada
  const AH = { ...JSONH, Authorization: 'Bearer ' + (await adminToken()), 'X-Demo-Key': DEMO_KEY };
  const demoEmail = 'democlave' + Date.now() + '@test.local';
  const demo = (await j('/api/admin/demos', { method: 'POST', headers: AH, body: JSON.stringify({ email: demoEmail, businessName: 'Demo Clave', days: 3, sendEmail: false }) })).body;
  const dl = (await login(demoEmail, demo.password)).body;
  const DH = { ...JSONH, Authorization: 'Bearer ' + dl.token };
  r = await send(DH, 'PUT', '/api/tenant/password', { currentPassword: demo.password, newPassword: 'otraClave789' });
  ok(r.status === 403 && r.body.error === 'demo_blocked', 'Demo: cambiar contraseña → 403 demo_blocked');
  ok((await login(demoEmail, demo.password)).status === 200, 'La contraseña de la demo no cambió');

  for (const t of [A.id, demo.tenantId]) await db.query('DELETE FROM tenants WHERE id=$1', [t]);
  await db.end();
});
