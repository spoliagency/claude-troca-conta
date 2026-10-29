'use strict';
// Apoio dos testes: cada teste ganha um CLAUDE_CONFIG_DIR proprio e falso. Nada toca no login real.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'trocar-conta.js');
const FAKE_SECURITY = path.join(__dirname, 'fake-security.js');

function criarMundo({ keychain = false, extraEnv = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'troca-conta-t-'));
  const w = {
    dir,
    cred: path.join(dir, '.credentials.json'),
    ident: path.join(dir, '.claude.json'),
    contas: path.join(dir, 'contas'),
    db: path.join(dir, 'keychain-db.json'),
    env: {
      ...process.env, CLAUDE_CONFIG_DIR: dir, TROCAR_SEM_AVISO: '1', TROCAR_ACORDAR_MS: '30',
      ...(keychain ? { TROCAR_STORE: 'keychain', TROCAR_MAC: '1', TROCAR_SECURITY_BIN: FAKE_SECURITY, FAKE_SECURITY_DB: path.join(dir, 'keychain-db.json'), TROCAR_KEYCHAIN_SERVICE: 'Claude Code-credentials', TROCAR_KEYCHAIN_ACCOUNT: 'claude-code-user' } : {}),
      ...extraEnv,
    },
    keychain,
  };
  w.run = (args, input, env = {}) => spawnSync('node', [SCRIPT, ...args], { env: { ...w.env, ...env }, input, encoding: 'utf8' });
  w.hookIn = (msg, sessao, error = 'rate_limit') => JSON.stringify({ hook_event_name: 'StopFailure', error, session_id: sessao, last_assistant_message: msg });
  w.hook = (msg, sessao, env) => w.run(['trocar', '--hook'], w.hookIn(msg, sessao), env);
  w.hookAsync = (msg, sessao, env = {}) => new Promise((res) => {
    const p = spawn('node', [SCRIPT, 'trocar', '--hook'], { env: { ...w.env, ...env } });
    let err = ''; p.stderr.on('data', (d) => { err += d; });
    p.on('close', (status) => res({ status, stderr: err }));
    p.stdin.end(w.hookIn(msg, sessao));
  });

  // --- leitura/escrita da credencial no store do mundo (arquivo ou Keychain falso) ---
  w.lerCred = () => (keychain ? lerKeychainComoClaude(w) : JSON.parse(fs.readFileSync(w.cred, 'utf8')));
  w.gravarCred = (obj) => {
    if (!keychain) return fs.writeFileSync(w.cred, JSON.stringify(obj));
    const db = fs.existsSync(w.db) ? JSON.parse(fs.readFileSync(w.db, 'utf8')) : {};
    for (const k of Object.keys(db)) delete db[k];
    db['Claude Code-credentials\u0000claude-code-user'] = JSON.stringify(obj);
    fs.writeFileSync(w.db, JSON.stringify(db));
  };
  w.logar = (email, tok, extra = {}) => {
    const c = fs.existsSync(w.cred) || (keychain && fs.existsSync(w.db)) ? w.lerCred() : { mcpOAuth: { servidorX: 'TOKEN-MCP-INTACTO' } };
    c.claudeAiOauth = { accessToken: 'acc-' + tok, refreshToken: 'ref-' + tok, expiresAt: Date.now() + 3600e3, refreshTokenExpiresAt: Date.now() + 20 * 864e5, subscriptionType: 'pro' };
    for (const k of ['trustedDeviceToken', 'trustedDeviceEnrolledAfterRefusalAtMs']) delete c[k];
    Object.assign(c, extra);
    w.gravarCred(c);
    fs.writeFileSync(w.ident, JSON.stringify({ outraChave: 42, oauthAccount: { emailAddress: email, displayName: tok } }));
  };
  w.quem = () => JSON.parse(fs.readFileSync(w.ident, 'utf8')).oauthAccount.emailAddress;
  w.tok = () => w.lerCred().claudeAiOauth.accessToken;
  w.estado = () => JSON.parse(fs.readFileSync(path.join(w.contas, 'estado.json'), 'utf8'));
  w.mudarEstado = (f) => { const e = w.estado(); f(e); fs.writeFileSync(path.join(w.contas, 'estado.json'), JSON.stringify(e)); };
  w.slot = (email) => JSON.parse(fs.readFileSync(path.join(w.contas, email + '.json'), 'utf8'));
  w.mudarSlot = (email, f) => { const s = w.slot(email); f(s); fs.writeFileSync(path.join(w.contas, email + '.json'), JSON.stringify(s)); };
  w.log = () => { try { return fs.readFileSync(path.join(w.contas, 'trocas.log'), 'utf8'); } catch { return ''; } };
  w.limpar = () => fs.rmSync(dir, { recursive: true, force: true });
  return w;
}

// Le o Keychain falso do jeito que o Claude Code le (item unico, senao manifest + pedacos em base64).
function lerKeychainComoClaude(w) {
  const db = JSON.parse(fs.readFileSync(w.db, 'utf8'));
  const get = (a) => db['Claude Code-credentials\u0000' + a];
  const unico = get('claude-code-user');
  if (unico) return JSON.parse(unico);
  const man = JSON.parse(get('claude-code-user#m'));
  const partes = Array.from({ length: man.n }, (_, i) => get(`claude-code-user#${i}`));
  const b64 = partes.join('');
  if (b64.length !== man.l) throw new Error('manifest nao confere');
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
}

module.exports = { criarMundo, SCRIPT, FAKE_SECURITY, lerKeychainComoClaude };
