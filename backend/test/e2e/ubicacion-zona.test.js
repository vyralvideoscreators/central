// Zona horaria = SOLO la de la ubicación del negocio (país + zona en Ajustes). Nunca la del navegador.
const { ok, j, send, reg, db: dbConnect, run, DEMO_KEY, adminToken } = require('../helpers/harness');
const post = (H, u, b) => send(H, 'POST', u, b);
const put = (H, u, b) => send(H, 'PUT', u, b);
const LOC_MSG = 'Configura la ubicación del negocio en Ajustes → Ubicación';
const isLoc = (r) => r.status === 400 && r.body && r.body.error === 'location_required' && r.body.message === LOC_MSG;

run(async () => {
  const db = await dbConnect();

  // ── Registro: la zona sale del país ──
  const V = await reg('Zona Venezuela');
  let r = await j('/api/tenant/profile', { headers: V.H });
  ok(r.status === 200 && r.body.country === 'Venezuela' && r.body.timezone === 'America/Caracas' && r.body.timezoneOptions.join() === 'America/Caracas',
    'Registro con país Venezuela: zona America/Caracas y una sola opción');
  const M = await reg('Zona México', { country: 'méxico' });
  r = await j('/api/tenant/profile', { headers: M.H });
  ok(r.body.country === 'México' && r.body.timezone === 'America/Mexico_City' && r.body.timezoneOptions.length === 6, 'País «méxico» → canónico «México», zona por defecto y 6 opciones');
  const O = await reg('Zona Otro', { country: 'Otro' });
  r = await j('/api/tenant/profile', { headers: O.H });
  ok(r.body.country === 'Otro' && r.body.timezone === null && r.body.timezoneOptions.length > 40, '«Otro»: sin zona por defecto y con lista amplia');
  const N = await reg('Zona Sin País', { country: null });
  r = await j('/api/tenant/profile', { headers: N.H });
  ok(r.body.country === null && r.body.timezone === null && r.body.timezoneOptions.length === 0, 'Sin país: sin zona y sin opciones');
  r = await j('/api/tenant/settings', { headers: M.H });
  ok(r.body.country === 'México' && r.body.timezone === 'America/Mexico_City' && r.body.timezoneOptions.includes('America/Cancun'), 'GET /api/tenant/settings trae country, timezone y timezoneOptions');
  await db.query("UPDATE tenants SET plan='pro' WHERE id = ANY($1)", [[V.id, M.id, O.id, N.id]]);

  // ── PUT profile: país y zona ──
  r = await put(M.H, '/api/tenant/profile', { timezone: 'America/Bogota' });
  ok(r.status === 400 && /no pertenece al país/.test(r.body.error), 'Una zona que no es del país → 400');
  r = await put(M.H, '/api/tenant/profile', { country: 'Marte' });
  ok(r.status === 400 && /País no válido/.test(r.body.error), 'Un país fuera de la lista → 400');
  r = await put(M.H, '/api/tenant/profile', { timezone: 'America/Cancun' });
  ok(r.status === 200 && r.body.tenant.timezone === 'America/Cancun' && r.body.tenant.country === 'México' && r.body.tenant.timezoneOptions.length === 6, 'México: elegir otra de sus zonas');
  r = await put(M.H, '/api/tenant/profile', { country: 'Colombia' });
  ok(r.status === 200 && r.body.tenant.timezone === 'America/Bogota' && r.body.tenant.country === 'Colombia', 'Cambiar a un país de una sola zona: se asigna sola');
  r = await put(M.H, '/api/tenant/profile', { country: 'España', timezone: 'Atlantic/Canary' });
  ok(r.status === 200 && r.body.tenant.timezone === 'Atlantic/Canary', 'País y zona a la vez');
  r = await put(M.H, '/api/tenant/profile', { business_name: 'Zona México SA' });
  ok(r.status === 200 && r.body.tenant.timezone === 'Atlantic/Canary', 'Editar solo el nombre no toca la ubicación');
  r = await put(O.H, '/api/tenant/profile', { timezone: 'America/New_York' });
  ok(r.status === 200 && r.body.tenant.timezone === 'America/New_York', '«Otro»: elegir una zona de su lista');
  r = await put(O.H, '/api/tenant/profile', { timezone: 'Asia/Tokyo' });
  ok(r.status === 400, '«Otro»: una zona fuera de la lista → 400');
  r = await put(O.H, '/api/tenant/profile', { timezone: 'America/Caracas' });
  ok(r.status === 200, '«Otro» admite también las zonas de los países de la lista');
  await put(O.H, '/api/tenant/profile', { timezone: 'America/New_York' });
  await put(M.H, '/api/tenant/profile', { country: 'México' });

  // ── Si la zona guardada no es del país, se recalcula desde el país ──
  await db.query("UPDATE tenants SET timezone='Asia/Tokyo' WHERE id=$1", [V.id]);
  r = await j('/api/tenant/profile', { headers: V.H });
  ok(r.body.timezone === 'America/Caracas', 'Zona guardada de otro país → se recalcula (Caracas)');
  r = await j('/api/reports?period=hoy', { headers: V.H });
  ok(r.status === 200 && r.body.timezone === 'America/Caracas', 'Los informes usan la recalculada');

  // ── El tz del navegador se ignora en todas las rutas ──
  for (const u of ['/api/reports?period=hoy&tz=Asia/Tokyo', '/api/payments?period=today&tz=Asia/Tokyo', '/api/expenses?tz=Asia/Tokyo', '/api/cash?tz=Asia/Tokyo',
    '/api/reports/profit?period=mes&tz=Asia/Tokyo', '/api/reports/receivables?tz=Asia/Tokyo', '/api/tenant/settings?tz=Asia/Tokyo']) {
    r = await j(u, { headers: V.H });
    ok(r.status === 200 && r.body.timezone === 'America/Caracas' || (u.includes('receivables') && r.status === 200), `tz del navegador ignorado: ${u.split('?')[0]}`);
  }
  r = await j('/api/reports?period=hoy&tz=Nada/Mala', { headers: V.H });
  ok(r.status === 200, 'Un tz inválido tampoco rompe al cliente que aún lo manda');
  const before = (await db.query('SELECT timezone FROM tenants WHERE id=$1', [N.id])).rows[0].timezone;
  r = await j('/api/reports?period=hoy&tz=Asia/Tokyo', { headers: N.H });
  ok(isLoc(r) && (await db.query('SELECT timezone FROM tenants WHERE id=$1', [N.id])).rows[0].timezone === before, 'Sin ubicación el tz del navegador NO se guarda ni se usa');

  // ── Auto-respuesta: la zona ya no se fija desde ahí ──
  await db.query("UPDATE tenants SET timezone='America/Caracas' WHERE id=$1", [V.id]);
  r = await put(V.H, '/api/tenant/auto-reply', { timezone: 'Asia/Tokyo' });
  ok(r.status === 200 && (await db.query('SELECT timezone FROM tenants WHERE id=$1', [V.id])).rows[0].timezone === 'America/Caracas', 'PUT auto-reply con timezone: se ignora sin romper al cliente');
  r = await put(V.H, '/api/tenant/auto-reply', { enabled: false, timezone: 'Asia/Tokyo' });
  ok(r.status === 200, 'PUT auto-reply con otros campos y timezone: 200');
  r = await j('/api/tenant/auto-reply', { headers: V.H });
  ok(r.body.timezone === 'America/Caracas', 'GET auto-reply devuelve la zona del negocio');

  // ── Sin zona válida: las rutas que calculan días → 400 location_required ──
  for (const T of [O, N]) {
    const label = T === O ? '«Otro» sin zona' : 'sin país';
    if (T === O) { await db.query('UPDATE tenants SET timezone=NULL WHERE id=$1', [O.id]); }
    for (const u of ['/api/reports?period=hoy', '/api/reports/profit?period=mes', '/api/reports/receivables', '/api/payments?period=today', '/api/expenses', '/api/cash', '/api/cash/2026-01-15']) {
      r = await j(u, { headers: T.H });
      ok(isLoc(r), `${label}: GET ${u.split('?')[0]} → 400 location_required`);
    }
    r = await post(T.H, '/api/expenses', { amount: 5, category: 'Otros', method: 'Efectivo' });
    ok(isLoc(r), `${label}: registrar un gasto → location_required`);
    r = await post(T.H, '/api/cash/2026-01-15/close', { counted: [] });
    ok(isLoc(r), `${label}: cerrar la caja → location_required`);
    r = await post(T.H, '/api/cash/2026-01-15/reopen', { reason: 'x' });
    ok(isLoc(r), `${label}: reabrir la caja → location_required`);
    // Las ventas NO se cortan
    const o = (await post(T.H, '/api/orders', { clientName: 'Cli', items: [{ name: 'Art', qty: 1, unitPrice: 50 }] })).body;
    r = await post(T.H, `/api/orders/${o.id}/payments`, { amount: 20, method: 'Efectivo' });
    ok(r.status === 200 && r.body.order.amountPaid === 20, `${label}: los cobros de pedidos siguen funcionando`);
    r = await post(T.H, `/api/orders/${o.id}/payments`, { amount: 10, method: 'Efectivo', paidAt: '2026-01-10' });
    ok(isLoc(r), `${label}: una fecha de pago sin hora necesita la zona → location_required`);
    r = await j('/api/tenant/settings', { headers: T.H });
    ok(r.status === 200 && r.body.timezone === null, `${label}: los ajustes responden con timezone null`);
  }
  // Sin zona no hay cierres, así que registrar un pago no se bloquea por «día cerrado»
  ok((await db.query('SELECT COUNT(*)::int n FROM cash_closings WHERE tenant_id = ANY($1)', [[O.id, N.id]])).rows[0].n === 0, 'Sin zona no se creó ningún cierre');
  // «Otro» con zona elegida: todo vuelve a funcionar
  r = await put(O.H, '/api/tenant/profile', { timezone: 'America/New_York' });
  r = await j('/api/reports?period=hoy', { headers: O.H });
  ok(r.status === 200 && r.body.timezone === 'America/New_York', '«Otro» con zona elegida: los informes funcionan');

  // ── La zona no cambia con cierres de caja vigentes ──
  r = await j('/api/cash/2026-01-01', { headers: M.H });
  const today = r.body.today;
  r = await post(M.H, `/api/cash/${today}/close`, { counted: [] });
  ok(r.status === 200 && r.body.status === 'closed', 'México cierra la caja de hoy (sin movimientos)');
  r = await put(M.H, '/api/tenant/profile', { timezone: 'America/Cancun' });
  ok(r.status === 400 && /cierres de caja vigentes/.test(r.body.error), 'Cambiar de zona con un cierre vigente → 400 con explicación');
  r = await put(M.H, '/api/tenant/profile', { country: 'Colombia' });
  ok(r.status === 400 && /cierres de caja vigentes/.test(r.body.error), 'Cambiar de país (y de zona) con un cierre vigente → 400');
  r = await put(M.H, '/api/tenant/profile', { country: 'México', timezone: 'America/Mexico_City' });
  ok(r.status === 200 && r.body.tenant.timezone === 'America/Mexico_City', 'Repetir la misma ubicación no cambia nada: permitido');
  r = await put(M.H, '/api/tenant/profile', { business_name: 'Con cierre' });
  ok(r.status === 200, 'Editar el nombre con un cierre vigente: permitido');
  r = await post(M.H, `/api/cash/${today}/reopen`, { reason: 'cambiar zona' });
  r = await put(M.H, '/api/tenant/profile', { timezone: 'America/Cancun' });
  ok(r.status === 200 && r.body.tenant.timezone === 'America/Cancun', 'Reabiertos los cierres, la zona se puede cambiar');

  // ── Demos: la zona sale del país; sin país, Venezuela / Caracas ──
  const adm = await adminToken();
  const AH = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adm, 'X-Demo-Key': DEMO_KEY };
  const mk = async (tag, country) => (await j('/api/admin/demos', { method: 'POST', headers: AH, body: JSON.stringify({
    email: `zona${tag}${Date.now()}@test.local`, businessName: 'Demo Zona ' + tag, days: 2, sendEmail: false, ...(country === undefined ? {} : { country }) }) })).body;
  const d1 = await mk('co', 'Colombia'), d2 = await mk('nada'), d3 = await mk('mx', 'México');
  const zone = async (id) => (await db.query('SELECT country, timezone FROM tenants WHERE id=$1', [id])).rows[0];
  const z1 = await zone(d1.tenantId), z2 = await zone(d2.tenantId), z3 = await zone(d3.tenantId);
  ok(z1.country === 'Colombia' && z1.timezone === 'America/Bogota', 'Demo con país Colombia → America/Bogota');
  ok(z2.country === 'Venezuela' && z2.timezone === 'America/Caracas', 'Demo sin país → Venezuela / America/Caracas');
  ok(z3.country === 'México' && z3.timezone === 'America/Mexico_City', 'Demo con país México → Mexico_City');
  const dl = (await j('/api/tenant/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: d1.email, password: d1.password }) })).body;
  r = await j('/api/reports?period=mes', { headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + dl.token } });
  ok(r.status === 200 && r.body.timezone === 'America/Bogota', 'La demo usa su zona en los informes');
  for (const d of [d1, d2, d3]) await db.query('DELETE FROM tenants WHERE id=$1', [d.tenantId]);

  for (const t of [V, M, O, N]) await db.query('DELETE FROM tenants WHERE id=$1', [t.id]);
  await db.end();
});
