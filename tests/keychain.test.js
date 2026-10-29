'use strict';
// Store do Keychain (Mac) contra um `security` falso. Prova a logica e o formato (item unico x pedacos);
// NAO prova o comportamento do macOS real (permissoes de acesso ao Keychain, saida do `security -w`).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { criarMundo, lerKeychainComoClaude } = require('./helpers');
const { servicoKeychain } = require('../scripts/lib/store');

const LONGE = "You've hit your limit · resets in 3 days";
const grande = () => ({ mcpOAuth: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`servidor${i}`, { accessToken: 'x'.repeat(120), refreshToken: 'y'.repeat(120) }])) });

function mundoKc(base = {}) {
  const w = criarMundo({ keychain: true });
  w.gravarCred({ ...base });
  w.logar('a@x.com', 'A'); w.run(['salvar']);
  w.logar('b@x.com', 'B'); w.run(['salvar']);
  return w;
}

test('item unico (credencial pequena): troca e le de volta igual ao que o Claude leria', (t) => {
  const w = mundoKc({ mcpOAuth: { s: 'pequeno' } }); t.after(w.limpar);
  const r = w.hook(LONGE, 's1');
  assert.equal(r.status, 2, r.stderr + w.log());
  assert.equal(w.quem(), 'a@x.com'); assert.equal(w.tok(), 'acc-A');
  const db = JSON.parse(fs.readFileSync(w.db, 'utf8'));
  assert.deepEqual(Object.keys(db), ['Claude Code-credentials\u0000claude-code-user'], 'continua um item so');
  assert.equal(w.lerCred().mcpOAuth.s, 'pequeno');
});

test('credencial grande vira pedacos (manifest + base64 de 2400) e o item unico antigo some', (t) => {
  const w = mundoKc(grande()); t.after(w.limpar);
  const antes = JSON.parse(fs.readFileSync(w.db, 'utf8'));
  assert.ok(Buffer.byteLength(Object.values(antes)[0]) > 1800, 'o cenario precisa passar do limite da linha');
  const r = w.hook(LONGE, 's1');
  assert.equal(r.status, 2, r.stderr + w.log());
  const db = JSON.parse(fs.readFileSync(w.db, 'utf8'));
  const chaves = Object.keys(db).map((k) => k.split('\u0000')[1]);
  assert.ok(chaves.includes('claude-code-user#m') && chaves.includes('claude-code-user#0'));
  assert.ok(!chaves.includes('claude-code-user'), 'o item unico antigo mascararia os pedacos');
  const man = JSON.parse(db['Claude Code-credentials\u0000claude-code-user#m']);
  assert.equal(man.l, Array.from({ length: man.n }, (_, i) => db[`Claude Code-credentials\u0000claude-code-user#${i}`]).join('').length);
  const lido = lerKeychainComoClaude(w); // leitor independente, escrito como o do Claude
  assert.equal(lido.claudeAiOauth.accessToken, 'acc-A');
  assert.equal(Object.keys(lido.mcpOAuth).length, 40, 'nenhum servidor MCP pode se perder');
});

test('troca de ida e volta com pedacos continua consistente', (t) => {
  const w = mundoKc(grande()); t.after(w.limpar);
  w.hook(LONGE, 's1');
  w.mudarEstado((e) => { delete e._ultimaTroca; delete e['b@x.com']; });
  w.hook(LONGE, 's1');
  assert.equal(w.quem(), 'b@x.com'); assert.equal(lerKeychainComoClaude(w).claudeAiOauth.accessToken, 'acc-B');
});

test('leitura de credencial ja dividida em pedacos (como o Claude grava)', (t) => {
  const w = criarMundo({ keychain: true }); t.after(w.limpar);
  const cred = { ...grande(), claudeAiOauth: { accessToken: 'acc-A', refreshToken: 'r', refreshTokenExpiresAt: Date.now() + 864e6, subscriptionType: 'pro' } };
  const b64 = Buffer.from(JSON.stringify(cred)).toString('base64');
  const db = {}; const n = Math.ceil(b64.length / 2400);
  for (let i = 0; i < n; i++) db[`Claude Code-credentials\u0000claude-code-user#${i}`] = b64.slice(i * 2400, (i + 1) * 2400);
  db['Claude Code-credentials\u0000claude-code-user#m'] = JSON.stringify({ n, l: b64.length });
  fs.writeFileSync(w.db, JSON.stringify(db));
  fs.writeFileSync(w.ident, JSON.stringify({ oauthAccount: { emailAddress: 'a@x.com' } }));
  assert.match(w.run(['salvar']).stdout, /guardada: a@x\.com/);
  assert.match(w.run(['diagnosticar']).stdout, /Keychain: formato pedacos/);
});

test('pedaco faltando: diagnosticar acusa e trocar NAO altera nada', (t) => {
  const w = mundoKc(grande()); t.after(w.limpar);
  w.hook(LONGE, 's1'); // forca o formato em pedacos
  w.mudarEstado((e) => { delete e._ultimaTroca; delete e['b@x.com']; delete e['a@x.com']; });
  const db = JSON.parse(fs.readFileSync(w.db, 'utf8'));
  delete db['Claude Code-credentials\u0000claude-code-user#1'];
  fs.writeFileSync(w.db, JSON.stringify(db));
  const antes = fs.readFileSync(w.db, 'utf8');
  const d = w.run(['diagnosticar']);
  assert.equal(d.status, 1); assert.match(d.stdout, /falta o pedaco 1/);
  const r = w.hook(LONGE, 's1');
  assert.equal(r.status, 1); assert.equal(fs.readFileSync(w.db, 'utf8'), antes, 'keychain intocado');
  assert.equal(w.quem(), 'a@x.com');
});

test('gravacao corrompida no Keychain: a releitura acusa e o login anterior e restaurado', (t) => {
  for (const base of [{ mcpOAuth: { s: 'pequeno' } }, grande()]) { // item unico e pedacos
    const w = mundoKc(base); t.after(w.limpar);
    const antes = w.lerCred();
    const r = w.run(['trocar'], undefined, { FAKE_SECURITY_CORRUPT_ONCE: require('path').join(w.dir, 'corrompeu.flag') });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(w.log(), /conteudo nao e JSON|nao confere/, 'a releitura tem que acusar a gravacao ruim');
    assert.deepEqual(w.lerCred(), antes, 'o login tem que voltar ao que era');
    assert.equal(w.quem(), 'b@x.com', 'a identidade nao pode ter mudado');
  }
});

test('gravacao valida mas com outro conteudo: a comparacao pega e o login anterior volta', (t) => {
  const w = mundoKc({ mcpOAuth: { s: 'pequeno' } }); t.after(w.limpar);
  const antes = w.lerCred();
  const r = w.run(['trocar'], undefined, { FAKE_SECURITY_WRONG_ONCE: require('path').join(w.dir, 'errado.flag') });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(w.log(), /leitura de volta nao confere/);
  assert.deepEqual(w.lerCred(), antes); assert.equal(w.quem(), 'b@x.com');
});

test('Mac sem a opcao ligada: recusa com instrucao e nao toca em nada', (t) => {
  const w = mundoKc({}); t.after(w.limpar);
  const antes = fs.readFileSync(w.db, 'utf8');
  const r = w.run(['trocar'], undefined, { TROCAR_MAC: '' });
  assert.equal(r.status, 1); assert.match(r.stderr, /experimental/);
  assert.equal(fs.readFileSync(w.db, 'utf8'), antes);
  assert.match(w.run(['config', 'mac', 'on'], undefined, { TROCAR_MAC: '' }).stdout, /mac = true/);
  assert.equal(w.run(['trocar', '--dry'], undefined, { TROCAR_MAC: '' }).status, 0, 'depois de ligar funciona');
});

test('sem item no Keychain o Claude cai pro arquivo: o store tambem', (t) => {
  const w = criarMundo({ extraEnv: { TROCAR_STORE: 'keychain', TROCAR_MAC: '1', TROCAR_SECURITY_BIN: require('./helpers').FAKE_SECURITY, FAKE_SECURITY_DB: 'vazio.json' } });
  t.after(w.limpar);
  w.logar('a@x.com', 'A'); // grava no arquivo (mundo nao-keychain)
  const r = w.run(['salvar'], undefined, { FAKE_SECURITY_DB: require('path').join(w.dir, 'vazio.json') });
  assert.match(r.stdout, /guardada: a@x\.com/, r.stderr);
});

test('nome do servico do Keychain acompanha CLAUDE_CONFIG_DIR como no Claude Code', () => {
  assert.equal(servicoKeychain({}, '/h/.claude'), 'Claude Code-credentials');
  const s = servicoKeychain({ CLAUDE_CONFIG_DIR: '/tmp/cfg' }, '/tmp/cfg');
  assert.match(s, /^Claude Code-credentials-[0-9a-f]{8}$/);
  const esperado = require('crypto').createHash('sha256').update('/tmp/cfg').digest('hex').slice(0, 8);
  assert.equal(s, `Claude Code-credentials-${esperado}`);
  assert.equal(servicoKeychain({ CLAUDE_SECURESTORAGE_CONFIG_DIR: '' }, '/x'), 'Claude Code-credentials');
});

test('o fake-security recusa linha acima de 4000 (garante que o teste de pedacos vale)', () => {
  const { spawnSync } = require('child_process');
  const w = criarMundo({ keychain: true });
  const r = spawnSync('node', [require('./helpers').FAKE_SECURITY, '-i'], { env: { ...w.env }, input: 'add-generic-password -U -a "x" -s "y" -w "' + 'z'.repeat(4100) + '"\n', encoding: 'utf8' });
  w.limpar();
  assert.equal(r.status, 1); assert.match(r.stderr, /linha longa/);
});
