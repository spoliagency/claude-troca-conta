'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { lerReset } = require('../scripts/lib/reset');

const iso = (d) => (d ? d.toISOString() : null);
// 29/10/2026 14:00 em Sao Paulo (UTC-3) = 17:00Z
const AGORA = new Date('2026-10-29T17:00:00Z');

test('texto REAL capturado do Claude Code 2.1.303 (E2E): "session limit · resets 6:27pm (America/Sao_Paulo)"', () => {
  const real = "You've hit your session limit · resets 6:27pm (America/Sao_Paulo)";
  assert.equal(iso(lerReset(real, new Date('2026-10-29T18:00:00Z'))), '2026-10-29T21:27:00.000Z'); // 18:27 em SP
  assert.equal(iso(lerReset(real, new Date('2026-10-29T22:00:00Z'))), '2026-10-30T21:27:00.000Z'); // ja passou: amanha
});

test('hora absoluta com fuso: hoje, se ainda nao passou', () => {
  assert.equal(iso(lerReset("You've hit your limit · resets 3pm (America/Sao_Paulo)", AGORA)), '2026-10-29T18:00:00.000Z');
});

test('hora absoluta que ja passou vira amanha', () => {
  const tarde = new Date('2026-10-29T20:00:00Z'); // 17:00 em SP
  assert.equal(iso(lerReset('resets 3pm (America/Sao_Paulo)', tarde)), '2026-10-30T18:00:00.000Z');
});

test('minutos e 12am/12pm', () => {
  assert.equal(iso(lerReset('resets 3:30pm (America/Sao_Paulo)', AGORA)), '2026-10-29T18:30:00.000Z');
  assert.equal(iso(lerReset('resets 12am (America/Sao_Paulo)', AGORA)), '2026-10-30T03:00:00.000Z'); // meia-noite de 30/10 em SP
  assert.equal(iso(lerReset('resets 12pm (America/Sao_Paulo)', new Date('2026-10-29T10:00:00Z'))), '2026-10-29T15:00:00.000Z');
});

test('fuso do aviso diferente do da maquina', () => {
  // New York em 29/10 esta em horario de verao (UTC-4): 15h = 19:00Z
  assert.equal(iso(lerReset('resets 3pm (America/New_York)', AGORA)), '2026-10-29T19:00:00.000Z');
});

test('data com mes: "Nov 2, 9am" e "Nov 2 at 9am"', () => {
  assert.equal(iso(lerReset('resets Nov 2, 9am (America/Sao_Paulo)', AGORA)), '2026-11-02T12:00:00.000Z');
  assert.equal(iso(lerReset('resets Nov 2 at 9am (America/Sao_Paulo)', AGORA)), '2026-11-02T12:00:00.000Z');
});

test('data depois da virada do horario de verao usa o deslocamento novo', () => {
  // 1/11/2026 acaba o horario de verao nos EUA: em 2/11 New York e UTC-5, 9h = 14:00Z
  assert.equal(iso(lerReset('resets Nov 2, 9am (America/New_York)', AGORA)), '2026-11-02T14:00:00.000Z');
});

test('virada de ano', () => {
  const fim = new Date('2026-12-30T15:00:00Z');
  assert.equal(iso(lerReset('resets Jan 2, 9am (America/Sao_Paulo)', fim)), '2027-01-02T12:00:00.000Z');
});

test('relativo: horas e minutos, minutos, dias', () => {
  assert.equal(iso(lerReset('resets in 2h 15m', AGORA)), '2026-10-29T19:15:00.000Z');
  assert.equal(iso(lerReset('resets in 45m', AGORA)), '2026-10-29T17:45:00.000Z');
  assert.equal(iso(lerReset('Usage limit reached, resets in 3 days', AGORA)), '2026-11-01T17:00:00.000Z');
});

test('sem fuso usa o relogio da maquina', () => {
  const local = new Date(AGORA); local.setHours(23, 0, 0, 0);
  const esperado = local > AGORA ? local : new Date(local.getTime() + 864e5);
  const lido = lerReset('resets 11pm', AGORA);
  assert.equal(lido.getHours(), 23);
  assert.ok(Math.abs(lido - esperado) <= 3600e3, 'tolerancia de 1h por causa de horario de verao local');
});

test('fuso invalido nao quebra: cai no relogio local', () => {
  assert.ok(lerReset('resets 3pm (Mars/Olympus)', AGORA) instanceof Date);
});

test('texto sem horario, vazio ou nulo devolve null', () => {
  assert.equal(lerReset("You've hit your limit", AGORA), null);
  assert.equal(lerReset('', AGORA), null);
  assert.equal(lerReset(null, AGORA), null);
  assert.equal(lerReset(undefined, AGORA), null);
});

test('mes desconhecido devolve null em vez de data errada', () => {
  assert.equal(lerReset('resets Foo 2, 9am', AGORA), null);
});
