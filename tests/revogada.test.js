'use strict';
// Login revogado: o token de renovacao so vale uma vez, entao um slot velho reusado derruba a conta inteira.
// Cobre (1) o slot acompanhar o login renovado, (2) a sessao seguir em outra conta quando o login morre,
// (3) a marca de revogada sumir sozinha com o /login novo.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { criarMundo } = require('./helpers');

const LONGE = 'You\'ve hit your session limit · resets 11:59pm (America/Sao_Paulo)';
const falhaLogin = (w, sessao = 's1') => w.run(['trocar', '--hook'], w.hookIn('Please run /login', sessao, 'authentication_failed'));

// Simula o Claude Code renovando o token da conta ativa (gera token novo e expiracao mais tarde).
function renovar(w, tok, horas = 8) {
  const c = w.lerCred();
  c.claudeAiOauth.accessToken = 'acc-' + tok;
  c.claudeAiOauth.refreshToken = 'ref-' + tok;
  c.claudeAiOauth.expiresAt = Date.now() + horas * 3600e3;
  w.gravarCred(c);
}

function duasContas() {
  const w = criarMundo();
  w.logar('a@x.com', 'A'); w.run(['salvar']);
  w.logar('b@x.com', 'B'); w.run(['salvar']);
  return w; // ativa: B
}

// ---------- 1. slot acompanha o login ----------

test('sincronizar guarda o token renovado da conta ativa', (t) => {
  const w = duasContas(); t.after(w.limpar);
  renovar(w, 'B2');
  assert.equal(w.slot('b@x.com').claudeAiOauth.refreshToken, 'ref-B');
  const r = w.run(['sincronizar']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(w.slot('b@x.com').claudeAiOauth.refreshToken, 'ref-B2');
  assert.match(w.log(), /SYNC: login de b@x\.com guardado/);
});

test('o hook Stop tambem sincroniza, mesmo sem nota de limite', (t) => {
  const w = duasContas(); t.after(w.limpar);
  renovar(w, 'B2');
  const transcript = path.join(w.dir, 's.jsonl'); fs.writeFileSync(transcript, '');
  const r = w.run(['parou', '--hook'], JSON.stringify({ hook_event_name: 'Stop', session_id: 's1', transcript_path: transcript }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(w.slot('b@x.com').claudeAiOauth.refreshToken, 'ref-B2');
});

test('o aviso de inicio de sessao tambem sincroniza', (t) => {
  const w = duasContas(); t.after(w.limpar);
  w.run(['ensaio']);
  renovar(w, 'B2');
  w.run(['lembrete']);
  assert.equal(w.slot('b@x.com').claudeAiOauth.refreshToken, 'ref-B2');
});

test('sincronizar nao cria slot de conta que ela nao cadastrou', (t) => {
  const w = duasContas(); t.after(w.limpar);
  w.logar('c@x.com', 'C');
  w.run(['sincronizar']);
  assert.equal(fs.existsSync(path.join(w.contas, 'c@x.com.json')), false);
});

test('sincronizar nao grava por cima do slot um login mais velho (sessao antiga regravou o arquivo)', (t) => {
  const w = duasContas(); t.after(w.limpar);
  w.mudarSlot('b@x.com', (s) => { s.claudeAiOauth.refreshToken = 'ref-B-novo'; s.claudeAiOauth.expiresAt = Date.now() + 9 * 3600e3; });
  // o arquivo ficou com o token antigo (expira antes do slot)
  w.run(['sincronizar']);
  assert.equal(w.slot('b@x.com').claudeAiOauth.refreshToken, 'ref-B-novo');
  assert.match(w.log(), /SYNC pulado.*mais velho/);
});

test('sincronizar nao grava o login de OUTRA conta guardada no slot desta (arquivo lido no meio de uma troca)', (t) => {
  const w = duasContas(); t.after(w.limpar);
  // identidade diz B, mas o arquivo tem o token da A
  const a = w.slot('a@x.com').claudeAiOauth;
  const c = w.lerCred(); c.claudeAiOauth = { ...a, expiresAt: Date.now() + 10 * 3600e3 }; w.gravarCred(c);
  w.run(['sincronizar']);
  assert.equal(w.slot('b@x.com').claudeAiOauth.refreshToken, 'ref-B', 'slot da B intacto');
  assert.match(w.log(), /SYNC pulado.*a@x\.com/);
});

test('o aviso de sync pulado vai pro log uma vez so, nao a cada turno', (t) => {
  const w = duasContas(); t.after(w.limpar);
  w.mudarSlot('b@x.com', (s) => { s.claudeAiOauth.refreshToken = 'ref-B-novo'; s.claudeAiOauth.expiresAt = Date.now() + 9 * 3600e3; });
  w.run(['sincronizar']); w.run(['sincronizar']); w.run(['sincronizar']);
  assert.equal((w.log().match(/SYNC pulado/g) || []).length, 1);
});

// ---------- 2. login revogado ----------

test('login revogado: a sessao troca pra outra conta livre, acorda e marca a morta', (t) => {
  const w = duasContas(); t.after(w.limpar);
  const r = falhaLogin(w);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /login de b@x\.com foi revogado.*conta a@x\.com.*Retome.*\/login em b@x\.com/s);
  assert.equal(w.quem(), 'a@x.com'); assert.equal(w.tok(), 'acc-A');
  assert.equal(w.estado()._ultima.motivo, 'revogada');
  assert.equal(w.estado()['b@x.com'], undefined, 'revogada nao e limite: nao marca limiteAte');
  assert.match(w.run(['status']).stdout, /b@x\.com.*PRECISA DE \/login \(revogada\)/);
});

test('conta revogada nao e escolhida de novo em uma troca por limite', (t) => {
  const w = duasContas(); t.after(w.limpar);
  falhaLogin(w); // B morta, ativa A
  const r = w.hook(LONGE, 's1'); // A bate o limite, na mesma sessao (outra dentro de 60 s cai no anti-pingpong)
  assert.equal(r.status, 1, 'sem conta valida pra trocar: avisa e nao acorda (nao e 2)');
  assert.equal(w.quem(), 'a@x.com');
  assert.match(w.log(), /FALHOU.*b@x\.com.*precisa/);
});

test('o slot velho da mesma conta tambem entra na marca (e da mesma familia de tokens)', (t) => {
  const w = duasContas(); t.after(w.limpar);
  renovar(w, 'B2'); // o arquivo esta adiante do slot, que e o caso real depois de dias sem salvar
  falhaLogin(w);
  const marcadas = w.estado()._revogadas['b@x.com'];
  assert.equal(marcadas.length, 2);
});

test('so ha uma conta com login valido e ela revoga: avisa, nao troca e nao acorda', (t) => {
  const w = criarMundo(); t.after(w.limpar);
  w.logar('a@x.com', 'A'); w.run(['salvar']);
  const r = falhaLogin(w);
  assert.equal(r.status, 1);
  assert.equal(w.quem(), 'a@x.com');
  assert.match(w.log(), /FALHOU.*a@x\.com precisa de \/login/);
});

test('as outras contas estao no limite: fica na que renova primeiro e espera', async (t) => {
  const w = duasContas(); t.after(w.limpar);
  w.logar('c@x.com', 'C'); w.run(['salvar']);
  fs.writeFileSync(path.join(w.contas, 'estado.json'), JSON.stringify({
    'a@x.com': { limiteAte: new Date(Date.now() + 3600e3).toISOString(), horaExata: true },
    'b@x.com': { limiteAte: new Date(Date.now() + 2 * 3600e3).toISOString(), horaExata: true },
  }));
  // ativa: C; C revoga; A e B estao no limite, A volta primeiro
  const r = await new Promise((res) => {
    const { spawn } = require('child_process');
    const p = spawn('node', [require('./helpers').SCRIPT, 'trocar', '--hook'], { env: { ...w.env, TROCAR_POLL_MS: '50' } });
    setTimeout(() => { p.kill(); res({ status: 'vivo' }); }, 1000);
    p.on('close', (status) => res({ status }));
    p.stdin.end(w.hookIn('Please run /login', 's1', 'authentication_failed'));
  });
  assert.equal(r.status, 'vivo', 'o hook fica vivo esperando (como no caso de todas no limite)');
  assert.equal(w.quem(), 'a@x.com', 'a sessao ficou na conta que renova primeiro');
  assert.match(w.run(['status']).stdout, /c@x\.com.*revogada/);
});

test('sessao vizinha que falhou na conta antiga so e acordada, a conta nova nao e marcada', (t) => {
  const w = duasContas(); t.after(w.limpar);
  falhaLogin(w, 's1'); // B morta, trocou pra A
  const r = falhaLogin(w, 's2');
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /ja foi trocada para a@x\.com/);
  assert.equal(w.estado()._revogadas['a@x.com'], undefined, 'a conta nova NAO foi marcada');
});

test('troca manual pra um e-mail ignora a marca de revogada (decisao dela)', (t) => {
  const w = duasContas(); t.after(w.limpar);
  falhaLogin(w); // ativa A, B marcada
  const r = w.run(['trocar', 'b@x.com']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(w.quem(), 'b@x.com');
});

// O Claude Code zera o refreshToken do arquivo quando a renovacao falha (visto no E2E com o cliente real).
const zerarRefresh = (w) => { const c = w.lerCred(); c.claudeAiOauth.refreshToken = ''; w.gravarCred(c); };

test('o Claude Code zerou o refreshToken: a marca vale pro slot e o slot nao e sobrescrito pelo login zerado', (t) => {
  const w = duasContas(); t.after(w.limpar);
  zerarRefresh(w);
  const r = falhaLogin(w);
  assert.equal(r.status, 2, r.stderr);
  assert.equal(w.slot('b@x.com').claudeAiOauth.refreshToken, 'ref-B', 'slot continua com o token que foi marcado');
  assert.match(w.run(['status']).stdout, /b@x\.com.*PRECISA DE \/login \(revogada\)/);
});

test('sincronizar nunca grava um login sem refreshToken por cima do slot', (t) => {
  const w = duasContas(); t.after(w.limpar);
  zerarRefresh(w);
  w.run(['sincronizar']);
  assert.equal(w.slot('b@x.com').claudeAiOauth.refreshToken, 'ref-B');
});

test('a troca por limite tambem nao guarda um login sem refreshToken', (t) => {
  const w = duasContas(); t.after(w.limpar);
  zerarRefresh(w);
  w.hook(LONGE, 's1');
  assert.equal(w.quem(), 'a@x.com');
  assert.equal(w.slot('b@x.com').claudeAiOauth.refreshToken, 'ref-B');
});

test('authentication_failed sem sinal de login revogado (falha passageira): nao marca nem troca', (t) => {
  const w = duasContas(); t.after(w.limpar);
  const r = w.run(['trocar', '--hook'], w.hookIn('API Error: connection reset', 's1', 'authentication_failed'));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(w.quem(), 'b@x.com');
  assert.equal(fs.existsSync(path.join(w.contas, 'estado.json')), false, 'nao gravou marca nenhuma');
  assert.match(w.log(), /sem sinal de login revogado/);
});

test('sessao vizinha cujo login ATIVO esta zerado falhou na conta nova: marca a nova em vez de acordar em loop', (t) => {
  const w = criarMundo(); t.after(w.limpar);
  for (const [e, k] of [['a@x.com', 'A'], ['b@x.com', 'B'], ['c@x.com', 'C']]) { w.logar(e, k); w.run(['salvar']); }
  falhaLogin(w, 's1'); // C morre, a sessao vai pra A (primeira livre)
  assert.equal(w.quem(), 'a@x.com');
  zerarRefresh(w); // agora e a A que falha, em outra sessao, dentro dos 60 s
  const r = falhaLogin(w, 's2');
  assert.equal(r.status, 2, r.stderr);
  assert.equal(w.quem(), 'b@x.com', 'seguiu pra B em vez de so acordar na A morta');
  assert.ok(w.estado()._revogadas['a@x.com'], 'A marcada');
});

test('o aviso de sync pulado nao toca no estado.json (o sync roda sem a trava de troca)', (t) => {
  const w = duasContas(); t.after(w.limpar);
  w.mudarSlot('b@x.com', (s) => { s.claudeAiOauth.refreshToken = 'ref-B-novo'; s.claudeAiOauth.expiresAt = Date.now() + 9 * 3600e3; });
  w.run(['sincronizar']);
  assert.equal(fs.existsSync(path.join(w.contas, 'estado.json')), false);
  assert.equal(fs.existsSync(path.join(w.contas, 'sync.json')), true);
});

test('o hook de inicio de sessao tambem roda no resume', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks', 'hooks.json'), 'utf8'));
  const m = hooks.hooks.SessionStart[0].matcher;
  assert.ok(new RegExp(`^(${m})$`).test('resume') && new RegExp(`^(${m})$`).test('startup'), m);
});

// ---------- 3. recuperacao ----------

test('/login novo na conta revogada: o sync guarda o token e a marca some sozinha', (t) => {
  const w = duasContas(); t.after(w.limpar);
  falhaLogin(w); // ativa A, B morta
  // ela faz /login em B: o Claude Code grava login e identidade novos
  w.logar('b@x.com', 'B-NOVO');
  // sem esperar o proximo turno: quem le o estado (status/guia/ensaio) sincroniza antes
  const depois = w.run(['status']).stdout;
  assert.doesNotMatch(depois, /PRECISA DE/);
  assert.equal(w.slot('b@x.com').claudeAiOauth.refreshToken, 'ref-B-NOVO');
  // ela esta logada na B: a A (livre) volta a ser alvo quando a B bater o limite
  const r = w.hook(LONGE, 's1');
  assert.equal(r.status, 2, r.stderr);
  assert.equal(w.quem(), 'a@x.com');
});

test('reproduz o caso real: slot velho, conta renovou, saiu sem salvar, token reusado', (t) => {
  const w = duasContas(); t.after(w.limpar);
  // B fica ativa e o Claude Code renova o token varias vezes
  renovar(w, 'B2'); renovar(w, 'B3');
  w.run(['sincronizar']); // fim do turno: o slot acompanha (sem isso ficava em ref-B, de dias atras)
  // uma sessao antiga regrava o login da A sem passar pelo plugin: a B sai de cena sem "guardar" na saida
  w.logar('a@x.com', 'A');
  // a A bate o limite e a troca volta pra B: tem de usar o token MAIS RECENTE da B
  const r = w.hook(LONGE, 's1');
  assert.equal(r.status, 2, r.stderr);
  assert.equal(w.quem(), 'b@x.com');
  assert.equal(w.tok(), 'acc-B3');
  assert.equal(w.lerCred().claudeAiOauth.refreshToken, 'ref-B3');
});
