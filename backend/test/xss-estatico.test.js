// Unitaria (sin base de datos): búsqueda estática de XSS en los HTML. Ningún onclick recibe texto de usuario.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

// ── Panel admin ──
const admin = fs.readFileSync(path.join(root, 'central-admin.html'), 'utf8');
const escSrc = admin.match(/function esc\(s\) \{[^\n]*\}/)[0];
const esc = new Function(escSrc + '; return esc;')();
ok(esc(`a'b"c<d>&`) === 'a&#39;b&quot;c&lt;d&gt;&amp;', "esc() del panel escapa la comilla simple (y las demás)");
const safeSrc = admin.match(/function safeId\(s\) \{[^\n]*\}/)[0];
const safeId = new Function(safeSrc + '; return safeId;')();
ok(safeId("x');alert(1);//") === 'xalert1' && safeId('0b9e5c1e-1111-4222-8333-444455556666') === '0b9e5c1e-1111-4222-8333-444455556666', 'safeId() solo deja caracteres de UUID');
const onclicks = admin.split('\n').flatMap((l, i) => (l.match(/onclick="[^"]*"/g) || []).map(m => ({ n: i + 1, m })));
const textFields = /business_name|full_name|\.email|\.name\b|\.country|whatsapp|\.note/;
ok(onclicks.length > 10, 'Se encontraron los onclick del panel (' + onclicks.length + ')');
ok(!onclicks.some(o => textFields.test(o.m)), 'Ningún onclick del panel interpola nombre, correo ni otros textos de usuario');
ok(!onclicks.some(o => /\$\{[^}]*\}|' *\+ *[a-zA-Z]/.test(o.m) && !/safeId|\$\{(page[-+]?\d*|i)\}|' \+ id \+ '|\+ i \+/.test(o.m)), 'Todo onclick con valores dinámicos usa safeId, un índice o un número de página');
ok(!/href=["']?javascript:/i.test(admin), 'El panel no usa href javascript:');

// ── SPA: onclick con '${x}' o ' + x + ' solo con valores de lista cerrada, o con escJsAttr ──
const spa = fs.readFileSync(path.join(root, 'central-mvp-v63 (1) - copia.html'), 'utf8');
const SAFE_TPL = new Set(['containerId', 'e', 'g', 'l.code', 'm.id', 'p']); // ids fijos del código, emojis y códigos de idioma/plan
const bad = [];
spa.split('\n').forEach((l, i) => {
  for (const m of l.matchAll(/onclick="[^"]*'\$\{([^}]*)\}'[^"]*"/g)) {
    for (const q of m[0].matchAll(/'\$\{([^}]*)\}'/g)) if (!SAFE_TPL.has(q[1])) bad.push((i + 1) + ': ' + q[0]);
  }
  for (const m of l.matchAll(/onclick="[^"]*" *\+|onclick="[^"]*'\s*\+\s*([^+]*?)\s*\+\s*'/g)) {
    const expr = m[1] || '';
    if (expr && !/^(escJsAttr\(.*\)|\w+)$/.test(expr)) bad.push((i + 1) + ': ' + m[0].slice(0, 100));
    if (/^\w+$/.test(expr) && !/^(i|n|open)$/.test(expr)) bad.push((i + 1) + ': ' + m[0].slice(0, 100));
  }
});
ok(bad.length === 0, 'SPA: ningún onclick con texto sin pasar por escJsAttr' + (bad.length ? ' -> ' + bad.join(' | ') : ''));

// ── Registro ──
const reg = fs.readFileSync(path.join(root, 'central-registro.html'), 'utf8');
ok(/Object\.hasOwn\(AVISOS/.test(reg), 'central-registro.html: AVISOS se consulta con Object.hasOwn');

process.exit(fails ? 1 : 0);
