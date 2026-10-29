#!/usr/bin/env node
'use strict';
// E2E do aviso de inicio de sessao (hook SessionStart) num Claude Code de verdade:
//   - com so 1 conta guardada o aviso APARECE e diz o que digitar;
//   - com tudo pronto (2 contas + ensaio) NAO aparece nada.
// Uso: E2E_CLAUDE="C:/caminho/claude.exe" node tests/e2e/e2e-lembrete.js

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');

const REPO = process.env.E2E_REPO || path.resolve(__dirname, '..', '..'); // E2E_REPO=spoliagency/claude-troca-conta testa a instalacao pelo GitHub
const CLAUDE = process.env.E2E_CLAUDE || 'claude';
const SHELL = process.platform === 'win32' && !/\.exe$/i.test(CLAUDE);
const base = path.join(os.tmpdir(), `e2e lembrete ${process.pid}`);
const CFG = path.join(base, 'config dir'); const WORK = path.join(base, 'trabalho');
fs.mkdirSync(CFG, { recursive: true }); fs.mkdirSync(WORK, { recursive: true });
const env = { ...process.env, CLAUDE_CONFIG_DIR: CFG, TROCAR_SEM_AVISO: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1' };
delete env.ANTHROPIC_API_KEY; delete env.CLAUDE_CODE_OAUTH_TOKEN; delete env.ANTHROPIC_AUTH_TOKEN;
const cli = (args, extra = {}) => spawnSync(CLAUDE, args, { env: { ...env, ...extra }, cwd: WORK, encoding: 'utf8', shell: SHELL, timeout: 120000 });
const ok = (m) => console.log('  ok  ' + m);

const sse = ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'].map((e) => {
  const d = {
    message_start: { type: e, message: { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
    content_block_start: { type: e, index: 0, content_block: { type: 'text', text: '' } },
    content_block_delta: { type: e, index: 0, delta: { type: 'text_delta', text: 'OK' } },
    content_block_stop: { type: e, index: 0 },
    message_delta: { type: e, delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
    message_stop: { type: e },
  }[e];
  return `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`;
}).join('');

(async () => {
  let r = cli(['plugin', 'marketplace', 'add', REPO]); assert.equal(r.status, 0, r.stdout + r.stderr);
  r = cli(['plugin', 'install', 'troca-conta@spoli-ferramentas']); assert.equal(r.status, 0, r.stdout + r.stderr);
  const inst = JSON.parse(cli(['plugin', 'list', '--json']).stdout.replace(/^[^[]*/, '')).find((p) => /troca-conta/.test(p.id || p.name || ''));
  const SCRIPT = path.join(inst.installPath || inst.path, 'scripts', 'trocar-conta.js');
  const node = (a) => spawnSync('node', [SCRIPT, ...a], { env, encoding: 'utf8' });
  ok('plugin instalado pelo marketplace');

  const logar = (tok, email) => {
    const f = path.join(CFG, '.credentials.json');
    const c = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
    c.claudeAiOauth = { accessToken: 'acc-' + tok, refreshToken: 'r-' + tok, expiresAt: Date.now() + 8 * 36e5, refreshTokenExpiresAt: Date.now() + 25 * 864e5, scopes: ['user:inference', 'user:profile'], subscriptionType: 'pro' };
    fs.writeFileSync(f, JSON.stringify(c));
    fs.writeFileSync(path.join(CFG, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, numStartups: 9, oauthAccount: { emailAddress: email, accountUuid: 'u-' + email } }));
  };

  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.method === 'POST' && req.url.startsWith('/v1/messages') && !req.url.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'text/event-stream' }); return res.end(sse); }
      res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}');
    });
  });
  await new Promise((k) => server.listen(0, '127.0.0.1', k));
  // spawn ASSINCRONO de proposito: o servidor falso roda neste mesmo processo, e spawnSync o travaria
  const iniciar = () => new Promise((res) => {
    const p = spawn(CLAUDE, ['-p', 'oi', '--output-format', 'stream-json', '--verbose'], {
      env: { ...env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}` }, cwd: WORK, shell: SHELL, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let t = ''; p.stdout.on('data', (d) => { t += d; }); p.stderr.on('data', (d) => { t += d; });
    const corta = setTimeout(() => p.kill(), 60000);
    p.on('exit', (code, sinal) => {
      clearTimeout(corta);
      const tipos = [...t.matchAll(/"type":"(system|assistant|result)"(?:,"subtype":"([a-z_]+)")?/g)].map((m) => m[1] + (m[2] ? ':' + m[2] : ''));
      console.log(`  (claude saiu status=${code} sinal=${sinal || '-'}; eventos: ${tipos.join(', ') || 'nenhum'})`);
      res(t);
    });
  });

  try {
    logar('A', 'a@teste.com'); node(['salvar']);
    let saida = await iniciar();
    const linha = saida.split('\n').find((l) => l.includes('troca-conta:')) || '(nao apareceu)';
    console.log('  linha vista no inicio da sessao:', linha.slice(0, 400));
    assert.match(saida, /troca-conta: so 1 conta guardada/);
    assert.match(saida, /\/troca-conta:troca-conta/);
    ok('com 1 conta guardada o aviso aparece e diz o que digitar');

    logar('B', 'b@teste.com'); node(['salvar']);
    saida = await iniciar();
    assert.match(saida, /troca-conta: a troca ainda nao foi testada/);
    ok('com 2 contas mas sem ensaio o aviso muda para "troca ainda nao testada"');

    const e = node(['ensaio']); assert.equal(e.status, 0, e.stderr);
    assert.match(node(['guia']).stdout, /ESTADO: PRONTO/);
    saida = await iniciar();
    // "troca-conta:troca-conta" tambem aparece na lista de skills; o aviso e "troca-conta: <motivo>" (com espaco)
    assert.ok(!/troca-conta: /.test(saida), 'pronto: nenhum aviso. Saida: ' + (saida.match(/.{0,80}troca-conta: .{0,120}/) || [''])[0]);
    assert.ok(!/"hook_name":"SessionStart:startup"[^}]*"output":"[^"]+"/.test(saida) || !/troca-conta/.test((saida.match(/"hook_name":"SessionStart:startup"[^\n]*/) || [''])[0]), 'o hook rodou e ficou mudo');
    assert.ok(/"result":"OK"|"text":"OK"/.test(saida), 'a sessao em si funcionou normalmente. Final da saida: ' + saida.slice(-700));
    ok('com tudo pronto o inicio da sessao fica em silencio');
  } finally {
    server.close();
    try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 80, retryDelay: 500 }); } catch { console.log('  (apague na mao: ' + base + ')'); }
  }
  console.log('\nE2E lembrete OK');
  process.exit(0);
})().catch((e) => { console.error('\nE2E lembrete FALHOU:', e.message); process.exit(1); });
