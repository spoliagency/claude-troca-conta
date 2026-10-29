'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { criarMundo } = require('./helpers');

const LONGE = "You've hit your limit · resets in 3 days";
const passo = (w) => /ESTADO: (PASSO \d|PRONTO)/.exec(w.run(['guia']).stdout)[1];
const prontoCom = (w) => { w.logar('a@x.com', 'A'); w.run(['salvar']); w.logar('b@x.com', 'B'); w.run(['salvar']); assert.equal(w.run(['ensaio']).status, 0); };

test('guia: acompanha o estado REAL passo a passo, ate PRONTO', (t) => {
  const w = criarMundo(); t.after(w.limpar);
  assert.equal(passo(w), 'PASSO 1', 'sem login nenhum');
  w.logar('a@x.com', 'A');
  assert.equal(passo(w), 'PASSO 2', 'logada, nada guardado');
  assert.match(w.run(['guia']).stdout, /AGORA: Rode: salvar +\(guarda a@x\.com\)/);
  w.run(['salvar']);
  let s = w.run(['guia']).stdout;
  assert.equal(passo(w), 'PASSO 3');
  assert.match(s, /So ha 1 conta guardada \(a@x\.com\).*\/login.*OUTRA.*nunca \/logout.*NAO consegue/s);
  w.logar('b@x.com', 'B'); // a pessoa fez /login na outra conta
  s = w.run(['guia']).stdout;
  assert.equal(passo(w), 'PASSO 3');
  assert.match(s, /conta ativa \(b@x\.com\) ainda nao esta guardada\. Rode: salvar/);
  w.run(['salvar']);
  s = w.run(['guia']).stdout;
  assert.equal(passo(w), 'PASSO 4'); assert.match(s, /\[ok\] +3\. Segunda conta/); assert.match(s, /rode: ensaio/);
  const e = w.run(['ensaio']);
  assert.equal(e.status, 0, e.stderr);
  assert.match(e.stdout, /b@x\.com -> a@x\.com: ok.*\n.*a@x\.com -> b@x\.com: ok.*voltou ao original/s);
  s = w.run(['guia']).stdout;
  assert.equal(passo(w), 'PRONTO');
  assert.match(s, /CONTAS: a@x\.com \(pro\), b@x\.com \(pro\)/); assert.match(s, /ENSAIO: .*trocou entre a@x\.com e b@x\.com e voltou/);
  assert.match(s, /ULTIMA TROCA REAL: ainda nao houve/);
});

test('guia: uma terceira conta nova invalida o ensaio anterior (precisa testar de novo)', (t) => {
  const w = criarMundo(); t.after(w.limpar);
  prontoCom(w);
  w.logar('c@x.com', 'C'); w.run(['salvar']);
  assert.equal(passo(w), 'PASSO 4');
  assert.equal(w.run(['ensaio']).status, 0);
  assert.equal(passo(w), 'PRONTO');
});

test('guia: login vencido numa conta guardada volta pro passo 3 com a instrucao certa', (t) => {
  const w = criarMundo(); t.after(w.limpar);
  prontoCom(w);
  w.mudarSlot('a@x.com', (s) => { s.claudeAiOauth.refreshTokenExpiresAt = Date.now() - 1000; });
  const s = w.run(['guia']).stdout;
  assert.equal(passo(w), 'PASSO 3'); assert.match(s, /a@x\.com precisa de \/login de novo/);
});

test('guia: depois de uma troca real mostra a ultima troca como prova de que funcionou', (t) => {
  const w = criarMundo(); t.after(w.limpar);
  prontoCom(w); // ativa: b
  w.hook(LONGE, 's1'); // b bate o limite -> a
  const s = w.run(['guia']);
  assert.match(s.stdout, /ESTADO: PRONTO/); assert.match(s.stdout, /ULTIMA TROCA REAL: .* b@x\.com -> a@x\.com \(limite\)/);
  assert.match(w.run(['status']).stdout, /ultima troca: .*b@x\.com -> a@x\.com +\(limite\)/);
});

test('ensaio: volta pra conta original e nao deixa rastro de troca recente nem de ultima troca', (t) => {
  const w = criarMundo(); t.after(w.limpar);
  prontoCom(w); // ativa: b
  const antes = w.lerCred();
  const st = w.estado();
  assert.equal(st._ultimaTroca, undefined); assert.equal(st._ultima, undefined);
  assert.equal(w.quem(), 'b@x.com'); assert.equal(w.tok(), 'acc-B');
  assert.deepEqual(w.lerCred(), antes);
  // se o ensaio deixasse _ultimaTroca recente, o proximo limite real seria tratado como "outra sessao"
  const r = w.hook(LONGE, 's1');
  assert.equal(r.status, 2); assert.match(r.stderr, /b@x\.com bateu o limite.*conta a@x\.com/s); assert.equal(w.quem(), 'a@x.com');
});

test('ensaio: com 3 contas testa ida e volta de cada uma', (t) => {
  const w = criarMundo(); t.after(w.limpar);
  for (const [e, k] of [['a@x.com', 'A'], ['b@x.com', 'B'], ['c@x.com', 'C']]) { w.logar(e, k); w.run(['salvar']); } // ativa: c
  const r = w.run(['ensaio']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal((r.stdout.match(/: ok/g) || []).length, 4, r.stdout);
  assert.equal(w.quem(), 'c@x.com'); assert.equal(w.tok(), 'acc-C');
});

test('ensaio: recusa com mensagem clara quando nao da pra testar', (t) => {
  const w = criarMundo(); t.after(w.limpar);
  w.logar('a@x.com', 'A'); w.run(['salvar']);
  let r = w.run(['ensaio']); assert.equal(r.status, 1); assert.match(r.stderr, /precisa de uma segunda/);
  w.logar('b@x.com', 'B'); // ativa b, nao guardada
  r = w.run(['ensaio']); assert.equal(r.status, 1); assert.match(r.stderr, /ainda nao esta guardada/);
  assert.equal(w.quem(), 'b@x.com', 'nada mudou');
});

test('ensaio com falha no meio: restaura o login, registra a falha e o guia manda diagnosticar', (t) => {
  const w = criarMundo({ keychain: true }); t.after(w.limpar);
  w.gravarCred({ mcpOAuth: { s: 'pequeno' } });
  w.logar('a@x.com', 'A'); w.run(['salvar']); w.logar('b@x.com', 'B'); w.run(['salvar']);
  const antes = w.lerCred();
  const r = w.run(['ensaio'], undefined, { FAKE_SECURITY_CORRUPT_ONCE: path.join(w.dir, 'c.flag') });
  assert.equal(r.status, 1); assert.match(r.stderr, /ensaio falhou.*login original foi restaurado/);
  assert.deepEqual(w.lerCred(), antes); assert.equal(w.quem(), 'b@x.com');
  const g = w.run(['guia']).stdout;
  assert.match(g, /ESTADO: PASSO 4/); assert.match(g, /ultimo ensaio falhou.*diagnosticar/);
});

test('ensaio no Keychain (Mac, formato em pedacos) ida e volta', (t) => {
  const w = criarMundo({ keychain: true }); t.after(w.limpar);
  w.gravarCred({ mcpOAuth: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`s${i}`, { a: 'x'.repeat(120), b: 'y'.repeat(120) }])) });
  w.logar('a@x.com', 'A'); w.run(['salvar']); w.logar('b@x.com', 'B'); w.run(['salvar']);
  const r = w.run(['ensaio']); assert.equal(r.status, 0, r.stderr + w.log());
  assert.equal(w.tok(), 'acc-B'); assert.equal(Object.keys(w.lerCred().mcpOAuth).length, 40);
  assert.match(w.run(['guia']).stdout, /ESTADO: PRONTO/);
});

test('lembrete: fala so quando o cadastro esta incompleto, e diz o que fazer', (t) => {
  const w = criarMundo(); t.after(w.limpar);
  const msg = () => { const o = w.run(['lembrete']); assert.equal(o.status, 0); return o.stdout ? JSON.parse(o.stdout).systemMessage : ''; };
  assert.equal(msg(), '', 'sem login legivel: calado (quem usa chave de API nao deve ser incomodado)');
  w.logar('a@x.com', 'A');
  assert.match(msg(), /nenhuma conta guardada ainda.*\/troca-conta:troca-conta/);
  w.run(['salvar']); assert.match(msg(), /so 1 conta guardada/);
  w.logar('b@x.com', 'B'); w.run(['salvar']); assert.match(msg(), /troca ainda nao foi testada/);
  w.run(['ensaio']); assert.equal(msg(), '', 'pronto: totalmente calado');
  w.mudarSlot('a@x.com', (s) => { s.claudeAiOauth.refreshTokenExpiresAt = Date.now() - 1; });
  assert.match(msg(), /a@x\.com precisa de \/login de novo/);
});

test('lembrete: config lembrete off cala, e erro interno nunca estoura a abertura da sessao', (t) => {
  const w = criarMundo(); t.after(w.limpar);
  w.logar('a@x.com', 'A');
  assert.ok(w.run(['lembrete']).stdout.length > 0);
  w.run(['config', 'lembrete', 'off']);
  assert.equal(w.run(['lembrete']).stdout, '');
  w.run(['config', 'lembrete', 'on']);
  fs.writeFileSync(path.join(w.contas, 'estado.json'), '{ quebrado');
  fs.writeFileSync(w.cred, '{ quebrado');
  const o = w.run(['lembrete']); assert.equal(o.status, 0); assert.equal(o.stdout, '');
});

test('hooks.json: JSON valido, StopFailure acorda a sessao e todo script citado existe', () => {
  const raiz = path.join(__dirname, '..');
  const h = JSON.parse(fs.readFileSync(path.join(raiz, 'hooks', 'hooks.json'), 'utf8')).hooks;
  assert.equal(h.StopFailure[0].matcher, 'rate_limit'); assert.equal(h.StopFailure[0].hooks[0].asyncRewake, true);
  assert.ok(h.StopFailure[0].hooks[0].timeout > 5.5 * 3600, 'timeout maior que a espera maxima');
  assert.equal(h.SessionStart[0].matcher, 'startup');
  const cmds = Object.values(h).flat().flatMap((g) => g.hooks.map((x) => x.command));
  for (const c of cmds) {
    const rel = /\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)"/.exec(c)[1];
    assert.ok(fs.existsSync(path.join(raiz, rel)), `${rel} existe`);
  }
});

test('SKILL.md so cita comandos que o script realmente tem (evita documentacao que mente)', () => {
  const raiz = path.join(__dirname, '..');
  const skill = fs.readFileSync(path.join(raiz, 'skills', 'troca-conta', 'SKILL.md'), 'utf8');
  const uso = require('child_process').spawnSync('node', [path.join(raiz, 'scripts', 'trocar-conta.js')], { encoding: 'utf8' }).stdout;
  const citados = new Set([...skill.matchAll(/trocar-conta\.js"?\s+([a-z]+)/g)].map((m) => m[1]));
  for (const m of skill.matchAll(/^\| `([a-z]+)/gm)) citados.add(m[1]);
  assert.ok(citados.size >= 6, 'achou os comandos citados: ' + [...citados]);
  for (const c of citados) assert.ok(new RegExp(`\\b${c}\\b`).test(uso), `a skill cita "${c}" mas o script nao tem`);
  for (const obrigatorio of ['guia', 'ensaio', 'salvar']) assert.ok(skill.includes('`' + obrigatorio + '`'), `a skill precisa usar "${obrigatorio}"`);
});
