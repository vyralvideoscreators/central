// Utilidades de las pruebas del equipo (Fase 4B)
const { j, send, reg, db } = require('./harness');
const JSONH = { 'Content-Type': 'application/json' };

const login = (email, password, ip) => j('/api/tenant/login', { method: 'POST',
  headers: { ...JSONH, ...(ip ? { 'X-Forwarded-For': ip } : {}) }, body: JSON.stringify({ email, password }) });
const authH = (token) => ({ ...JSONH, Authorization: 'Bearer ' + token });

// Sube de plan un negocio (la facturación real no se prueba aquí)
async function setPlan(c, tenantId, plan) { await c.query('UPDATE tenants SET plan = $1 WHERE id = $2', [plan, tenantId]); }

// El dueño crea un usuario y este entra y cambia la contraseña temporal. Devuelve { id, email, password, token, H }
async function makeUser(owner, role, name, opts = {}) {
  const email = (opts.emailPrefix || role) + Date.now() + Math.floor(Math.random() * 1e6) + '@test.local';
  const r = await send(owner.H, 'POST', '/api/team', { name: name || role, email, role });
  if (r.status !== 200) throw new Error('No se pudo crear el usuario: ' + JSON.stringify(r.body));
  const temp = r.body.tempPassword;
  const l = await login(email, temp);
  if (l.status !== 200) throw new Error('No entró con la temporal: ' + JSON.stringify(l.body));
  let token = l.body.token;
  const password = 'Clave-' + Math.floor(Math.random() * 1e6) + 'xY';
  if (!opts.keepTemp) {
    const c = await send(authH(token), 'PUT', '/api/tenant/password', { currentPassword: temp, newPassword: password });
    if (c.status !== 200) throw new Error('No pudo cambiar la temporal: ' + JSON.stringify(c.body));
    token = c.body.token;
  }
  return { id: r.body.user.id, email, temp, password: opts.keepTemp ? temp : password, token, H: authH(token), role };
}

module.exports = { login, authH, setPlan, makeUser, JSONH, j, send, reg, db };
