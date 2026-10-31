'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { criarMundo } = require('./helpers');

// Texto de limite com reset sempre longe (nao depende da hora em que o teste roda).
const LONGE = "You've hit your limit · resets in 3 days";
const RAPIDO = { TROCAR_POLL_MS: '100', TROCAR_MARGEM_MS: '0' };
const SEM_ESPERA = { TROCAR_MAX_ESPERA_MS: '1000' }; // forca "longe demais pra esperar"

function duasContas(opts) {
  const w = criarMundo(opts);
  w.logar('a@x.com', 'A'); w.run(['salvar']);
  w.logar('b@x.com', 'B'); w.run(['salvar']);
  return w; // ativa: B
}
const soltarTrava = (w) => w.mudarEstado((e) => { delete e._ultimaTroca; });

test('cadastro, status e dry-run nao alteram nada', (t) => {
  const w = duasContas(); t.after(w.limpar);
  const s = w.run(['status']).stdout;
  assert.match(s, /\* b@x\.com/); assert.match(s, /a@x\.com/);
  assert.match(w.run(['trocar', '--dry']).stdout, /trocaria b@x\.com -> a@x\.com/);
  assert.equal(w.quem(), 'b@x.com');
});

test('hook: troca, acorda (exit 2), preserva mcpOAuth e outras chaves', (t) => {
  const w = duasContas(); t.after(w.limpar);
  const r = w.hook(LONGE, 's1');
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /b@x\.com bateu o limite.*conta a@x\.com.*Retome/s);
  assert.equal(w.quem(), 'a@x.com'); assert.equal(w.tok(), 'acc-A');
  assert.equal(w.lerCred().mcpOAuth.servidorX, 'TOKEN-MCP-INTACTO');
  assert.equal(JSON.parse(fs.readFileSync(w.ident, 'utf8')).outraChave, 42);
});

test('erro que nao e rate_limit e ignorado', (t) => {
  const w = duasContas(); t.after(w.limpar);
  const r = w.run(['trocar', '--hook'], w.hookIn('x', 's1', 'authentication_failed'));
  assert.equal(r.status, 0); assert.equal(w.quem(), 'b@x.com');
});

test('sessao vizinha que falhou na conta antiga so e acordada, a conta nova nao e marcada', (t) => {
  const w = duasContas(); t.after(w.limpar);
  w.hook(LONGE, 's1');
  const r = w.hook(LONGE, 's2');
  assert.equal(r.status, 2); assert.match(r.stderr, /ja foi trocada para a@x\.com/);
  assert.equal(w.quem(), 'a@x.com'); assert.ok(!w.estado()['a@x.com']);
});

test('mesma sessao falhando de novo = conta nova tambem no limite: marca e nao entra em loop', (t) => {
  const w = duasContas(); t.after(w.limpar);
  w.hook(LONGE, 's1');
  const r = w.hook(LONGE, 's1', SEM_ESPERA);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(w.estado()['a@x.com'] && w.estado()['b@x.com']);
});

test('as duas no limite: espera a primeira renovar, troca, acorda e guarda o token renovado', (t) => {
  const w = duasContas(); t.after(w.limpar);
  w.hook(LONGE, 's1'); // B -> A, B marcada
  soltarTrava(w);
  w.mudarEstado((e) => { e['b@x.com'] = { limiteAte: new Date(Date.now() + 2500).toISOString() }; });
  const c = w.lerCred(); c.claudeAiOauth.accessToken = 'acc-A-RENOVADO'; w.gravarCred(c);
  const t0 = Date.now();
  const r = w.hook(LONGE, 's1', RAPIDO); // A bate o limite tambem; B volta em 2,5s
  assert.equal(r.status, 2, r.stderr);
  assert.ok(Date.now() - t0 >= 2000, 'tem que ter esperado a conta renovar');
  assert.match(r.stderr, /limite foi renovado.*b@x\.com/s);
  assert.equal(w.quem(), 'b@x.com');
  assert.equal(w.slot('a@x.com').claudeAiOauth.accessToken, 'acc-A-RENOVADO');
});

test('as duas no limite: ja ESPERA na conta que volta primeiro e acorda nela', async (t) => {
  const w = duasContas(); t.after(w.limpar);
  w.hook(LONGE, 's1'); // B -> A, B marcada
  soltarTrava(w);
  w.mudarEstado((e) => { e['b@x.com'] = { limiteAte: new Date(Date.now() + 2500).toISOString() }; });
  const p = w.hookAsync(LONGE, 's1', RAPIDO); // A bate o limite tambem; B volta em 2,5s
  await new Promise((ok) => setTimeout(ok, 1000));
  assert.equal(w.quem(), 'b@x.com', 'a sessao tem que estar na conta que volta primeiro ENQUANTO espera');
  const r = await p;
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /limite foi renovado.*b@x\.com/s);
  assert.equal(w.quem(), 'b@x.com');
  assert.match(w.log(), /TROCOU \(volta-primeiro\): a@x\.com -> b@x\.com/);
});

test('as duas no limite, volta longe demais: nao espera, mas fica na que volta primeiro', (t) => {
  const w = duasContas(); t.after(w.limpar);
  w.hook(LONGE, 's1'); soltarTrava(w); // B -> A
  w.mudarEstado((e) => { e['b@x.com'] = { limiteAte: new Date(Date.now() + 3600e3).toISOString() }; });
  const r = w.hook(LONGE, 's1', SEM_ESPERA); // A volta em 3 dias, B em 1h
  assert.equal(r.status, 0, r.stderr);
  assert.equal(w.quem(), 'b@x.com');
});

test('as duas no limite e a atual volta primeiro: fica nela, sem trocar', (t) => {
  const w = duasContas(); t.after(w.limpar);
  w.hook(LONGE, 's1'); soltarTrava(w); // B -> A, B marcada ate 3 dias
  const r = w.hook("You've hit your limit · resets in 2h", 's1', SEM_ESPERA); // A volta em 2h
  assert.equal(r.status, 0, r.stderr);
  assert.equal(w.quem(), 'a@x.com');
  assert.doesNotMatch(w.log(), /volta-primeiro/);
});

test('duas esperas ao mesmo tempo (usuaria digitou de novo): so uma acorda', async (t) => {
  const w = duasContas(); t.after(w.limpar);
  w.hook(LONGE, 's1'); // B -> A
  soltarTrava(w);
  w.mudarEstado((e) => { e['b@x.com'] = { limiteAte: new Date(Date.now() + 2500).toISOString() }; });
  const p1 = w.hookAsync(LONGE, 's1', RAPIDO);
  await new Promise((ok) => setTimeout(ok, 300));
  const p2 = w.hookAsync(LONGE, 's2', RAPIDO); // sessao vizinha
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.deepEqual([r1.status, r2.status].sort(), [0, 2], `exatamente um acorda: ${r1.status}/${r2.status}`);
  assert.equal(w.quem(), 'b@x.com');
});

test('quatro esperas acordando NO MESMO INSTANTE (5 rodadas): exatamente uma acorda, sempre', async (t) => {
  for (let rodada = 1; rodada <= 5; rodada++) {
    const w = duasContas(); t.after(w.limpar);
    w.hook(LONGE, 's1'); // B -> A
    soltarTrava(w);
    w.mudarEstado((e) => { e['b@x.com'] = { limiteAte: new Date(Date.now() + 1800).toISOString() }; });
    const rs = await Promise.all([1, 2, 3, 4].map((i) => w.hookAsync(LONGE, 's' + i, RAPIDO)));
    const acordaram = rs.filter((r) => r.status === 2).length;
    assert.equal(acordaram, 1, `rodada ${rodada}: ${rs.map((r) => r.status).join('/')} (so uma pode acordar a sessao)`);
    assert.equal(w.quem(), 'b@x.com');
    assert.equal((w.log().match(/VOLTOU/g) || []).length, 1, 'uma unica retomada no log');
  }
});

test('tres contas: pula a que esta no limite e escolhe a livre', (t) => {
  const w = criarMundo(); t.after(w.limpar);
  for (const [e, k] of [['a@x.com', 'A'], ['b@x.com', 'B'], ['c@x.com', 'C']]) { w.logar(e, k); w.run(['salvar']); } // ativa: C
  w.hook(LONGE, 's1'); // C marcada -> A (1a livre por ordem)
  assert.equal(w.quem(), 'a@x.com');
  soltarTrava(w);
  w.hook(LONGE, 's1'); // A marcada; C ainda marcada -> B
  assert.equal(w.quem(), 'b@x.com');
});

test('tres contas todas no limite: espera a que renova primeiro entre as tres', (t) => {
  const w = criarMundo(); t.after(w.limpar);
  for (const [e, k] of [['a@x.com', 'A'], ['b@x.com', 'B'], ['c@x.com', 'C']]) { w.logar(e, k); w.run(['salvar']); }
  w.hook(LONGE, 's1'); soltarTrava(w); // C -> A
  w.hook(LONGE, 's1'); soltarTrava(w); // A -> B
  w.mudarEstado((e) => { e['c@x.com'].limiteAte = new Date(Date.now() + 2000).toISOString(); });
  const r = w.hook(LONGE, 's1', RAPIDO); // B tambem bate; A e C marcadas; C volta em 2s
  assert.equal(r.status, 2, r.stderr);
  assert.equal(w.quem(), 'c@x.com');
});

test('config esperar=off: todas no limite nao segura o hook', (t) => {
  const w = duasContas(); t.after(w.limpar);
  w.hook(LONGE, 's1'); soltarTrava(w);
  w.mudarEstado((e) => { e['b@x.com'].limiteAte = new Date(Date.now() + 60e3).toISOString(); });
  assert.match(w.run(['config', 'esperar', 'off']).stdout, /esperar = false/);
  const t0 = Date.now();
  const r = w.hook(LONGE, 's1', RAPIDO);
  assert.equal(r.status, 0); assert.ok(Date.now() - t0 < 5000, 'nao pode ter esperado o minuto');
});

test('token de renovacao vencido na outra conta: nao troca e avisa que precisa de /login', (t) => {
  const w = duasContas(); t.after(w.limpar);
  w.mudarSlot('a@x.com', (s) => { s.claudeAiOauth.refreshTokenExpiresAt = Date.now() - 1000; });
  const r = w.hook(LONGE, 's1');
  assert.equal(r.status, 1); assert.equal(w.quem(), 'b@x.com');
  assert.match(w.log(), /precisa\(m\) de \/login/);
  assert.match(w.run(['status']).stdout, /PRECISA DE \/login/);
  assert.match(w.run(['diagnosticar']).stdout, /FALHA a@x\.com: token de renovacao VENCIDO/);
});

test('extras do dispositivo (trustedDeviceToken) acompanham a conta', (t) => {
  const w = criarMundo(); t.after(w.limpar);
  w.logar('a@x.com', 'A', { trustedDeviceToken: 'dispositivo-da-A' }); w.run(['salvar']);
  w.logar('b@x.com', 'B'); w.run(['salvar']); // B nao tem token de dispositivo
  assert.equal(w.lerCred().trustedDeviceToken, undefined);
  w.hook(LONGE, 's1'); // B -> A
  assert.equal(w.lerCred().trustedDeviceToken, 'dispositivo-da-A');
  soltarTrava(w); w.mudarEstado((e) => { delete e['b@x.com']; });
  w.hook(LONGE, 's1'); // A -> B: o token da A nao pode vazar pra B
  assert.equal(w.quem(), 'b@x.com'); assert.equal(w.lerCred().trustedDeviceToken, undefined);
});

test('slot em formato antigo (v1) nao apaga extras existentes', (t) => {
  const w = duasContas(); t.after(w.limpar);
  w.mudarSlot('a@x.com', (s) => { delete s.v; delete s.extras; });
  const c = w.lerCred(); c.trustedDeviceToken = 'do-pc'; w.gravarCred(c);
  w.hook(LONGE, 's1');
  assert.equal(w.quem(), 'a@x.com'); assert.equal(w.lerCred().trustedDeviceToken, 'do-pc');
  assert.match(w.run(['diagnosticar']).stdout, /formato antigo/);
});

test('so uma conta guardada: avisa e sai com 1, sem mexer em nada', (t) => {
  const w = criarMundo(); t.after(w.limpar);
  w.logar('a@x.com', 'A'); w.run(['salvar']);
  const r = w.hook(LONGE, 's1');
  assert.equal(r.status, 1); assert.equal(w.quem(), 'a@x.com'); assert.match(w.log(), /so ha uma conta guardada/);
});

test('trocar manual para uma conta especifica, e esquecer', (t) => {
  const w = criarMundo(); t.after(w.limpar);
  for (const [e, k] of [['a@x.com', 'A'], ['b@x.com', 'B'], ['c@x.com', 'C']]) { w.logar(e, k); w.run(['salvar']); }
  assert.match(w.run(['trocar', 'b@x.com']).stdout, /c@x\.com -> b@x\.com/);
  assert.equal(w.quem(), 'b@x.com');
  assert.match(w.run(['esquecer', 'a@x.com']).stdout, /esquecida/);
  assert.ok(!fs.existsSync(path.join(w.contas, 'a@x.com.json')));
  assert.equal(w.run(['esquecer', 'nao@existe.com']).status, 1);
});

test('credencial corrompida: hook sai com 1 e deixa o erro no log (nao fica mudo)', (t) => {
  const w = duasContas(); t.after(w.limpar);
  fs.writeFileSync(w.cred, '{ nao e json');
  const r = w.hook(LONGE, 's1');
  assert.equal(r.status, 1); assert.match(w.log(), /ERRO trocar/);
});

test('rollback: se a identidade nao puder ser gravada, o login volta ao que era', { skip: process.platform !== 'win32' && 'so Windows consegue travar a escrita sem travar o resto' }, (t) => {
  const w = duasContas();
  t.after(() => { fs.chmodSync(w.ident, 0o666); w.limpar(); });
  fs.chmodSync(w.ident, 0o444); // legivel, mas nao gravavel: atual() passa e gravar(ident) falha
  const r = w.run(['trocar']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(w.tok(), 'acc-B', 'o login nao pode ter ficado de outra conta');
  assert.equal(w.quem(), 'b@x.com');
});

test('diagnosticar: ambiente saudavel sai com 0 e lista as contas', (t) => {
  const w = duasContas(); t.after(w.limpar);
  const r = w.run(['diagnosticar']);
  assert.equal(r.status, 0, r.stdout); assert.match(r.stdout, /2 contas guardadas/); assert.match(r.stdout, /Tudo certo/);
});

test('o script respeita CLAUDE_CONFIG_DIR (nao encosta no ~/.claude real)', (t) => {
  const w = duasContas(); t.after(w.limpar);
  assert.ok(fs.existsSync(path.join(w.dir, 'contas', 'a@x.com.json')));
  assert.ok(w.run(['status']).stdout.includes(w.contas));
});
