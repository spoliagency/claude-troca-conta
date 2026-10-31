'use strict';
// Limite avisado ANTES de estourar: o Claude Code injeta a nota "wrap_up", o modelo encerra o turno normalmente
// (Stop, nao StopFailure) e o hook Stop precisa trocar a conta e acordar a sessao.
// As linhas do transcript abaixo tem o formato real, copiado de uma sessao de 30/10/2026.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { criarMundo, SCRIPT } = require('./helpers');

const NOTA = 'Usage limit reached; a short grace allowance remains, then this turn is cut off without warning.';
const linha = (o) => JSON.stringify(o);
const humano = (ts, texto = 'faz isso') => linha({ type: 'user', message: { role: 'user', content: texto }, origin: { kind: 'human' }, timestamp: ts });
const nota = (ts, uuid = 'nota-1', tipo = 'wrap_up') => linha({ type: 'user', message: { role: 'user', content: tipo === 'wrap_up' ? `[${NOTA}]` : '[Earlier usage-limit notes no longer apply.]' }, isMeta: true, turnCompanion: true, usageLimitNote: tipo, uuid, timestamp: ts });
const resposta = (ts) => linha({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Parei: atingi o limite.' }] }, timestamp: ts });
const info = (ts, hora = '1:40am') => linha({ type: 'system', subtype: 'informational', content: `Usage limit reached · continuing automatically at ${hora} · esc to cancel`, timestamp: ts });

const ha = (ms) => new Date(Date.now() - ms).toISOString();
const SEM_ESPERA = { TROCAR_ESPERA_AVISO_MS: '0' };

function mundo() {
  const w = criarMundo();
  w.logar('a@x.com', 'A'); w.run(['salvar']);
  w.logar('b@x.com', 'B'); w.run(['salvar']);
  w.transcript = path.join(w.dir, 'sessao.jsonl');
  w.escrever = (linhas) => fs.writeFileSync(w.transcript, linhas.join('\n') + '\n');
  w.parou = (env = SEM_ESPERA, sessao = 's1') => w.run(['parou', '--hook'], JSON.stringify({ hook_event_name: 'Stop', session_id: sessao, transcript_path: w.transcript }), env);
  return w; // ativa: B
}

test('nota de limite no turno que acabou: troca a conta e acorda (exit 2) com o aviso de pendencia', (t) => {
  const w = mundo(); t.after(w.limpar);
  w.escrever([humano(ha(60000)), nota(ha(30000)), resposta(ha(20000)), info(ha(19000))]);
  const r = w.parou();
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /b@x\.com bateu o limite.*conta a@x\.com.*continue o que ficou pendente.*Retome/s);
  assert.equal(w.quem(), 'a@x.com'); assert.equal(w.tok(), 'acc-A');
  assert.equal(w.estado()._ultima.motivo, 'aviso');
  assert.ok(w.estado()['b@x.com'].limiteAte, 'a conta que avisou fica marcada');
});

test('a hora do reset sai da linha "continuing automatically at"', (t) => {
  const w = mundo(); t.after(w.limpar);
  w.escrever([humano(ha(60000)), nota(ha(30000)), resposta(ha(20000)), info(ha(19000), '11:59pm')]);
  w.parou();
  const m = w.estado()['b@x.com'];
  assert.equal(m.horaExata, true);
  const volta = new Date(m.limiteAte);
  assert.equal(volta.getHours(), 23); assert.equal(volta.getMinutes(), 59);
});

test('sem a linha de reset, usa a estimativa de 5h e segue trocando', (t) => {
  const w = mundo(); t.after(w.limpar);
  w.escrever([humano(ha(60000)), nota(ha(30000)), resposta(ha(20000))]);
  const r = w.parou();
  assert.equal(r.status, 2, r.stderr);
  assert.equal(w.estado()['b@x.com'].horaExata, false);
});

test('espera a linha de reset aparecer logo apos o Stop', async (t) => {
  const w = mundo(); t.after(w.limpar);
  w.escrever([humano(ha(60000)), nota(ha(30000)), resposta(ha(20000))]);
  const r = await new Promise((res) => {
    const p = spawn('node', [SCRIPT, 'parou', '--hook'], { env: { ...w.env, TROCAR_ESPERA_AVISO_MS: '4000' } });
    let err = ''; p.stderr.on('data', (d) => { err += d; });
    p.on('close', (status) => res({ status, stderr: err }));
    p.stdin.end(JSON.stringify({ session_id: 's1', transcript_path: w.transcript }));
    setTimeout(() => fs.appendFileSync(w.transcript, info(new Date().toISOString(), '11:59pm') + '\n'), 700);
  });
  assert.equal(r.status, 2, r.stderr);
  assert.equal(w.estado()['b@x.com'].horaExata, true);
});

test('turno comum, sem nota, nao mexe em nada', (t) => {
  const w = mundo(); t.after(w.limpar);
  w.escrever([humano(ha(60000)), resposta(ha(20000))]);
  const r = w.parou();
  assert.equal(r.status, 0); assert.equal(w.quem(), 'b@x.com'); assert.equal(r.stderr, '');
});

test('nota de um turno antigo (ha uma pergunta da pessoa depois dela) e ignorada', (t) => {
  const w = mundo(); t.after(w.limpar);
  w.escrever([humano(ha(90000)), nota(ha(80000)), resposta(ha(70000)), humano(ha(60000), 'continua'), resposta(ha(20000))]);
  assert.equal(w.parou().status, 0); assert.equal(w.quem(), 'b@x.com');
});

test('nota liberada ("release") depois dela: ignora', (t) => {
  const w = mundo(); t.after(w.limpar);
  w.escrever([humano(ha(90000)), nota(ha(80000)), resposta(ha(70000)), nota(ha(60000), 'lib-1', 'release'), resposta(ha(20000))]);
  assert.equal(w.parou().status, 0); assert.equal(w.quem(), 'b@x.com');
});

test('nota velha (mais de 15 min): ignora', (t) => {
  const w = mundo(); t.after(w.limpar);
  w.escrever([humano(ha(3600e3)), nota(ha(3590e3)), resposta(ha(3580e3))]);
  assert.equal(w.parou().status, 0); assert.equal(w.quem(), 'b@x.com');
});

test('a mesma nota nao troca duas vezes (turnos seguintes releem o transcript)', (t) => {
  const w = mundo(); t.after(w.limpar);
  w.escrever([humano(ha(60000)), nota(ha(30000)), resposta(ha(20000)), info(ha(19000))]);
  assert.equal(w.parou().status, 2); assert.equal(w.quem(), 'a@x.com');
  assert.equal(w.parou().status, 0); assert.equal(w.quem(), 'a@x.com');
});

test('nota anterior a uma troca ja feita: ignora (a conta mudou depois dela)', (t) => {
  const w = mundo(); t.after(w.limpar);
  w.escrever([humano(ha(60000)), nota(ha(30000), 'nota-x'), resposta(ha(20000)), info(ha(19000))]);
  w.run(['trocar']); // troca manual depois da nota
  w.mudarEstado((e) => { e._ultimaTroca = Date.now(); });
  assert.equal(w.parou().status, 0);
});

test('antecipar desligado no config: nao faz nada', (t) => {
  const w = mundo(); t.after(w.limpar);
  w.run(['config', 'antecipar', 'off']);
  w.escrever([humano(ha(60000)), nota(ha(30000)), resposta(ha(20000)), info(ha(19000))]);
  assert.equal(w.parou().status, 0); assert.equal(w.quem(), 'b@x.com');
});

test('transcript sumido ou stdin vazio: silencioso, sem erro', (t) => {
  const w = mundo(); t.after(w.limpar);
  assert.equal(w.parou().status, 0);
  assert.equal(w.run(['parou', '--hook'], '').status, 0);
  assert.equal(w.quem(), 'b@x.com');
});

test('transcript grande: acha a nota lendo so o fim do arquivo', (t) => {
  const w = mundo(); t.after(w.limpar);
  const enchimento = Array.from({ length: 4000 }, (_, i) => linha({ type: 'user', message: { role: 'user', content: 'x'.repeat(300) }, i }));
  w.escrever([humano(ha(900000)), ...enchimento, humano(ha(60000)), nota(ha(30000)), resposta(ha(20000)), info(ha(19000))]);
  assert.ok(fs.statSync(w.transcript).size > 1024 * 1024, 'precisa passar da janela de leitura');
  assert.equal(w.parou().status, 2); assert.equal(w.quem(), 'a@x.com');
});

test('sem conta pra trocar: avisa uma vez so, nao repete a cada turno', (t) => {
  const w = criarMundo(); t.after(w.limpar);
  w.logar('a@x.com', 'A'); w.run(['salvar']); // so uma conta guardada
  w.transcript = path.join(w.dir, 'sessao.jsonl');
  fs.writeFileSync(w.transcript, [humano(ha(60000)), nota(ha(30000)), resposta(ha(20000)), info(ha(19000))].join('\n') + '\n');
  const entrada = JSON.stringify({ session_id: 's1', transcript_path: w.transcript });
  assert.equal(w.run(['parou', '--hook'], entrada, SEM_ESPERA).status, 1);
  assert.equal(w.run(['parou', '--hook'], entrada, SEM_ESPERA).status, 0);
  assert.equal((w.log().match(/FALHOU/g) || []).length, 1);
});
