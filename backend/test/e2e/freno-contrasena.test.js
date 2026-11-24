// Freno de intentos de la contraseña actual (cambio de clave / de correo), largo máximo de claves
// y migraciones de pedidos (CHECK del descuento validado, índice de order_items).
// Se ejecuta con `npm test` (test/run.js arranca el servidor con Meta simulada y una base local vacía).
const { ok, j, send, reg, db: dbConnect, run } = require('../helpers/harness');
const JSONH = { 'Content-Type': 'application/json' };

run(async () => {
  const db = await dbConnect();
  const A = await reg('Freno A');
  const B = await reg('Freno B');
  const wrongPw = () => send(A.H, 'PUT', '/api/tenant/password', { currentPassword: 'mala', newPassword: 'otraClave789' });

  // 3 fallos, luego un guardado correcto de otro campo: NO debe reiniciar el contador (antes sí lo hacía)
  for (let k = 0; k < 3; k++) ok((await wrongPw()).status === 401, 'Fallo ' + (k + 1) + ' → 401');
  let r = await send(A.H, 'PUT', '/api/tenant/profile', { business_name: 'Freno A2' });
  ok(r.status === 200, 'Guardar el nombre (200) en medio de los fallos');
  // Los fallos al cambiar el correo cuentan en el mismo contador
  r = await send(A.H, 'PUT', '/api/tenant/profile', { email: 'otro' + Date.now() + '@test.local', currentPassword: 'mala' });
  ok(r.status === 401, 'Fallo 4 (cambio de correo) → 401');
  ok((await wrongPw()).status === 401, 'Fallo 5 → 401');
  r = await wrongPw();
  ok(r.status === 429, 'Fallo 6 → 429 bloqueado');
  r = await send(A.H, 'PUT', '/api/tenant/password', { currentPassword: 'password123', newPassword: 'otraClave789' });
  ok(r.status === 429, 'Bloqueado incluso con la contraseña correcta (no se puede seguir probando)');
  r = await send(A.H, 'PUT', '/api/tenant/profile', { email: 'otro2' + Date.now() + '@test.local', currentPassword: 'password123' });
  ok(r.status === 429, 'El cambio de correo también queda bloqueado');
  r = await send(A.H, 'PUT', '/api/tenant/profile', { business_name: 'Freno A3' });
  ok(r.status === 200, 'Los campos que no piden contraseña siguen funcionando');
  ok((await j('/api/tenant/login', { method: 'POST', headers: JSONH, body: JSON.stringify({ email: A.email, password: 'password123' }) })).status === 200,
    'La contraseña no cambió y el login normal sigue funcionando');

  // El freno es por negocio: otro negocio desde la misma IP no queda bloqueado
  r = await send(B.H, 'PUT', '/api/tenant/password', { currentPassword: 'mala', newPassword: 'otraClave789' });
  ok(r.status === 401, 'Otro negocio: fallo → 401 (no 429)');
  r = await send(B.H, 'PUT', '/api/tenant/password', { currentPassword: 'password123', newPassword: 'otraClave789' });
  ok(r.status === 200, 'Otro negocio: cambio correcto → 200');

  // En paralelo: 20 intentos a la vez no pueden pasar todos antes de contarse
  const P = await reg('Freno P');
  const codes = (await Promise.all(Array.from({ length: 20 }, () =>
    send(P.H, 'PUT', '/api/tenant/password', { currentPassword: 'mala', newPassword: 'otraClave789' })))).map(x => x.status);
  ok(codes.filter(c => c === 401).length <= 5 && codes.filter(c => c === 429).length >= 15,
    'Ráfaga de 20 en paralelo: como mucho 5 se comprueban, el resto 429 (' + codes.join(',') + ')');
  await db.query('DELETE FROM tenants WHERE id=$1', [P.id]);

  // Largo máximo (bcrypt solo usa 72 bytes)
  const long = 'a'.repeat(73);
  r = await send(B.H, 'PUT', '/api/tenant/password', { currentPassword: 'otraClave789', newPassword: long });
  ok(r.status === 400 && /demasiado larga/.test(r.body.error), 'Clave nueva de 73 bytes → 400');
  r = await send(B.H, 'PUT', '/api/tenant/password', { currentPassword: 'otraClave789', newPassword: 'ñ'.repeat(37) });
  ok(r.status === 400, '37 "ñ" (74 bytes) → 400');
  r = await send(B.H, 'PUT', '/api/tenant/password', { currentPassword: 'otraClave789', newPassword: 'b'.repeat(72) });
  ok(r.status === 200, 'Clave de 72 bytes → 200');
  r = await j('/api/tenant/register', { method: 'POST', headers: JSONH,
    body: JSON.stringify({ businessName: 'Larga', email: 'larga' + Date.now() + '@test.local', password: long }) });
  ok(r.status === 400 && r.body.field === 'password', 'Registro con clave de 73 bytes → 400');

  // Migraciones: CHECK validado e índice válido
  const c = await db.query(`SELECT convalidated FROM pg_constraint WHERE conname = 'orders_discount_nonneg'`);
  ok(c.rows[0] && c.rows[0].convalidated === true, 'CHECK orders_discount_nonneg existe y está validado');
  const ix = await db.query(`SELECT i.indisvalid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid WHERE c.relname = 'order_items_tenant_order_idx'`);
  ok(ix.rows[0] && ix.rows[0].indisvalid === true, 'Índice order_items_tenant_order_idx existe y es válido');

  for (const t of [A.id, B.id]) await db.query('DELETE FROM tenants WHERE id=$1', [t]);
  await db.end();
});
