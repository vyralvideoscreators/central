// Postgres LOCAL para las pruebas de CENTRAL (nunca toca Railway).
//   node test/pg-local.js start    → lo crea la primera vez y lo arranca (puerto 55432)
//   node test/pg-local.js stop
//   node test/pg-local.js status
// Datos en %USERPROFILE%\.central-pg (fuera del repo; CENTRAL_PG_DIR para otro sitio).
// Usuario "postgres" sin contraseña y solo escuchando en esta máquina.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = String(process.env.CENTRAL_PG_PORT || 55432);
const DATA = process.env.CENTRAL_PG_DIR || path.join(os.homedir(), '.central-pg');
const LOG = path.join(DATA, '..', '.central-pg.log');
const exe = (n) => process.platform === 'win32' ? n + '.exe' : n;

function findBin() {
  if (process.env.PG_BIN) return process.env.PG_BIN;
  const roots = process.platform === 'win32'
    ? ['C:/Program Files/PostgreSQL']
    : ['/usr/lib/postgresql', '/opt/homebrew/opt', '/usr/local/opt'];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const versions = fs.readdirSync(root).filter(v => /^\d+/.test(v)).sort((a, b) => parseFloat(b) - parseFloat(a));
    for (const v of versions) {
      const bin = path.join(root, v, 'bin');
      if (fs.existsSync(path.join(bin, exe('pg_ctl')))) return bin;
    }
  }
  try { return path.dirname(execFileSync(process.platform === 'win32' ? 'where' : 'which', ['pg_ctl']).toString().split(/\r?\n/)[0]); }
  catch { throw new Error('No encuentro PostgreSQL instalado (pg_ctl). Instálalo o indica la carpeta con PG_BIN.'); }
}

const bin = findBin();
const run = (tool, args, opts = {}) => String(execFileSync(path.join(bin, exe(tool)), args, { stdio: 'pipe', ...opts }) ?? '');

function status() {
  if (!fs.existsSync(path.join(DATA, 'PG_VERSION'))) return 'no creado';
  try { run('pg_ctl', ['-D', DATA, 'status']); return 'encendido'; } catch { return 'apagado'; }
}

const cmd = process.argv[2] || 'status';
try {
  if (cmd === 'start') {
    if (!fs.existsSync(path.join(DATA, 'PG_VERSION'))) {
      console.log(`Creando Postgres local en ${DATA} …`);
      run('initdb', ['-D', DATA, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8']);
    }
    if (status() === 'encendido') { console.log(`Ya estaba encendido (puerto ${PORT}).`); process.exit(0); }
    // stdio 'ignore': el servidor que arranca pg_ctl hereda las tuberías y en Windows la
    // llamada no terminaría nunca; la salida va al archivo de log (-l)
    run('pg_ctl', ['-D', DATA, '-o', `-p ${PORT} -c listen_addresses=localhost`, '-l', LOG, '-w', 'start'], { stdio: 'ignore' });
    console.log(`Postgres local encendido en el puerto ${PORT}. Ya puedes ejecutar: npm test`);
  } else if (cmd === 'stop') {
    if (status() !== 'encendido') { console.log('No estaba encendido.'); process.exit(0); }
    run('pg_ctl', ['-D', DATA, '-m', 'fast', '-w', 'stop']);
    console.log('Postgres local apagado.');
  } else if (cmd === 'status') {
    console.log(`Postgres local (${DATA}, puerto ${PORT}): ${status()}`);
  } else {
    console.log('Uso: node test/pg-local.js start | stop | status');
    process.exit(2);
  }
} catch (err) {
  console.error('✘ ' + (err.stderr ? err.stderr.toString() : err.message));
  process.exit(1);
}
