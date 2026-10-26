// Comprueba que los datos de las demos son 100 % inventados: ningún nombre, apellido,
// producto, teléfono, usuario o mensaje puede aparecer en los datos originales de la app.
// Uso: node backend/test/demo-data.test.js   (desde la raíz del repo)
const { execSync } = require('child_process');
const path = require('path');
const { DEMO_DATA } = require('../demo-seed');

const repo = path.resolve(__dirname, '..', '..');
const git = (ref) => { try { return execSync(`git show "${ref}"`, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); } catch { return ''; } };
const corpusSources = [
  'c472c0b:central-mvp-v63 (1) - copia.html',
  'c472c0b:backend/central-mvp-v63 (1) - copia.html',
  '4fdca86:backend/central-mvp-v63 (1) - copia.html',
  '44ec1a8:backend/demo-seed.js',
];
const norm = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const corpus = norm(corpusSources.map(git).join('\n'));
if (corpus.length < 100000) { console.error('No se pudo leer el material original desde git'); process.exit(2); }
const digits = corpus.replace(/\D/g, '');

const checks = [];
const add = (kind, value) => { if (value && String(value).trim()) checks.push([kind, String(value).trim()]); };
const { PRODUCTS, CLIENTS, CONVOS } = DEMO_DATA;
for (const c of CLIENTS) {
  add('cliente', c.name);
  c.name.split(' ').slice(1).forEach(sur => add('apellido', sur));
  add('instagram', c.ig);
  add('nota', c.notes);
}
for (const p of PRODUCTS) add('producto', p.name);
for (const cv of CONVOS) {
  if (cv.lead) { add('prospecto', cv.lead.name); cv.lead.name.split(' ').slice(1).forEach(s => add('apellido', s)); }
  for (const [, text] of cv.msgs) add('mensaje', text);
}

let fails = 0;
for (const [kind, value] of checks) {
  if (corpus.includes(norm(value))) { console.log(`FAIL ${kind} ya existe en los datos originales: "${value}"`); fails++; }
}
const phones = [...CLIENTS.map(c => c.phone), ...CONVOS.map(c => c.lead && c.lead.phone)].filter(Boolean);
for (const ph of phones) {
  const local = ph.replace(/\D/g, '').slice(-7);
  if (digits.includes(local)) { console.log(`FAIL teléfono ya existe en los datos originales: ${ph}`); fails++; }
  if (!/555 ?2\d{3}$/.test(ph)) { console.log(`FAIL teléfono fuera del bloque ficticio 555-2xxx: ${ph}`); fails++; }
}
console.log(`${checks.length + phones.length} comprobaciones, ${fails} coincidencias`);
process.exit(fails ? 1 : 0);
