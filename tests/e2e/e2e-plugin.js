#!/usr/bin/env node
'use strict';
// E2E de verdade, sem gastar conta nenhuma. Para cada cenario:
//   1. instala o plugin pelo marketplace num CLAUDE_CONFIG_DIR isolado (caminho COM ESPACOS);
//   2. sobe um servidor falso da API que devolve 429 (limite) como o servidor real;
//   3. roda `claude -p` numa sessao longa (stream-json) logada na conta A com tokens falsos;
//   4. confere o que a sessao ABERTA fez: hook disparou, login trocou, pedido seguinte saiu com o token
//      certo e o modelo foi acordado sozinho (sem ninguem digitar nada).
//
// Cenarios:  troca  = so a A esta no limite -> troca pra B e retoma
//            ambas  = A e B no limite ate um horario -> espera renovar, retoma (leva ~2 min)
//            aviso  = o Claude Code AVISA o limite antes de estourar (nota wrap_up no transcript, turno termina normal,
//                     sem 429): o hook Stop tem que trocar e acordar a sessao
//
// Uso: E2E_CLAUDE="C:/caminho/claude.exe" node tests/e2e/e2e-plugin.js [troca|ambas]   (padrao: os dois)
// Precisa do Claude Code instalado. Nao usa a sua conta nem o seu ~/.claude.

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');

const REPO = process.env.E2E_REPO || path.resolve(__dirname, '..', '..'); // E2E_REPO=spoliagency/claude-troca-conta testa a instalacao pelo GitHub
const CLAUDE = process.env.E2E_CLAUDE || 'claude';
const SHELL = process.platform === 'win32' && !/\.exe$/i.test(CLAUDE);
const TMP = os.tmpdir(); // as pastas do teste ("e2e troca conta", "config dir") ja levam espaco, como num usuario "Nome Sobrenome"
const dorme = (ms) => new Promise((k) => setTimeout(k, ms));
const ok = (m) => console.log('  ok  ' + m);

const futuro = Date.now() + 25 * 864e5;
const cred = (tok) => ({ accessToken: 'acc-' + tok, refreshToken: 'ref-' + tok, expiresAt: Date.now() + 8 * 36e5, refreshTokenExpiresAt: futuro, scopes: ['user:inference', 'user:profile'], subscriptionType: 'pro' });
const ident = (email) => ({ hasCompletedOnboarding: true, numStartups: 9, oauthAccount: { emailAddress: email, accountUuid: 'uuid-' + email, displayName: email } });

const sse = (texto) => [
  ['message_start', { type: 'message_start', message: { id: 'msg_e2e', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: texto } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }],
  ['message_stop', { type: 'message_stop' }],
].map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');

async function cenario(nome) {
  console.log(`\n=== cenario "${nome}" ===`);
  const base = path.join(TMP, `e2e troca conta ${nome} ${process.pid}`);
  const CFG = path.join(base, 'config dir');
  const WORK = path.join(base, 'trabalho');
  fs.mkdirSync(CFG, { recursive: true }); fs.mkdirSync(WORK, { recursive: true });
  const envBase = { ...process.env, CLAUDE_CONFIG_DIR: CFG, TROCAR_SEM_AVISO: '1', TROCAR_ACORDAR_MS: '500', TROCAR_MARGEM_MS: '0', TROCAR_POLL_MS: '500', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1' };
  delete envBase.ANTHROPIC_API_KEY; delete envBase.CLAUDE_CODE_OAUTH_TOKEN; delete envBase.ANTHROPIC_AUTH_TOKEN;
  const claude = (args) => {
    const argv = SHELL ? args.map((x) => (/\s/.test(x) ? `"${x}"` : x)) : args; // com shell no Windows, caminho com espaco precisa de aspas
    const r = spawnSync(CLAUDE, argv, { env: envBase, encoding: 'utf8', shell: SHELL, timeout: 120000 });
    return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
  };

  // 1) instalacao pelo marketplace
  let r = claude(['plugin', 'marketplace', 'add', REPO]); assert.equal(r.status, 0, 'marketplace add: ' + r.out);
  r = claude(['plugin', 'install', 'troca-conta@spoli-ferramentas']); assert.equal(r.status, 0, 'plugin install: ' + r.out);
  r = claude(['plugin', 'list', '--json']);
  const inst = JSON.parse(r.out.slice(r.out.indexOf('['))).find((p) => /troca-conta/.test(p.id || p.name || ''));
  assert.ok(inst, 'plugin aparece instalado: ' + r.out.slice(0, 300));
  const instalado = inst.installPath || inst.path;
  const SCRIPT = path.join(instalado, 'scripts', 'trocar-conta.js');
  assert.ok(fs.existsSync(SCRIPT), 'script no cache do plugin');
  ok(`plugin instalado pelo marketplace: ${instalado}`);
  const node = (args) => spawnSync('node', [SCRIPT, ...args], { env: envBase, encoding: 'utf8' });

  // 2) contas falsas: A (logada, bate o limite) e B
  const escrever = (tok, email) => {
    const f = path.join(CFG, '.credentials.json');
    const atual = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { mcpOAuth: { servidorX: { accessToken: 'MCP-INTACTO' } } };
    atual.claudeAiOauth = cred(tok);
    fs.writeFileSync(f, JSON.stringify(atual));
    fs.writeFileSync(path.join(CFG, '.claude.json'), JSON.stringify(ident(email)));
  };
  escrever('B', 'b@teste.com'); assert.match(node(['salvar']).stdout, /guardada: b@teste.com/);
  escrever('A', 'a@teste.com'); assert.match(node(['salvar']).stdout, /guardada: a@teste.com/);
  ok('duas contas falsas guardadas; ativa: A');

  // 3) servidor falso da API
  const reqs = [];
  // "ambas": o limite acaba num minuto cheio ~1-2 min a frente (o aviso so tem precisao de minuto)
  const agoraS = Math.floor(Date.now() / 1000);
  const resetEpoch = nome === 'ambas' ? (Math.floor(agoraS / 60) + 2) * 60 : agoraS + 3 * 3600;
  const livre = (auth) => (nome === 'aviso' ? true : nome === 'troca' ? auth.endsWith('acc-B') : Date.now() >= resetEpoch * 1000);
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const auth = req.headers.authorization || '';
      reqs.push({ m: req.method, url: req.url, auth, at: Date.now() });
      if (req.method === 'POST' && req.url.startsWith('/v1/messages') && !req.url.includes('count_tokens')) {
        if (!livre(auth)) {
          res.writeHead(429, {
            'content-type': 'application/json', 'retry-after': String(resetEpoch - Math.floor(Date.now() / 1000)), 'x-should-retry': 'false',
            'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-representative-claim': 'five_hour',
            'anthropic-ratelimit-unified-reset': String(resetEpoch), 'anthropic-ratelimit-unified-5h-status': 'rejected',
            'anthropic-ratelimit-unified-5h-reset': String(resetEpoch), 'anthropic-ratelimit-unified-5h-utilization': '1',
          });
          return res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Number of requests has exceeded your rate limit.' } }));
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        if (nome !== 'aviso' || auth.endsWith('acc-B')) return res.end(sse('RETOMADO-SOZINHO'));
        // aviso: a A responde devagar, pra dar tempo do injetor gravar a nota no transcript antes do fim do turno
        const corte = 'event: content_block_stop';
        const [ini, ...resto] = sse('RESPOSTA-DA-A').split(corte);
        res.write(ini);
        return setTimeout(() => res.end(corte + resto.join(corte)), 3000);
      }
      res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}');
    });
  });
  await new Promise((k) => server.listen(0, '127.0.0.1', k));
  const porta = server.address().port;

  // 4) hook extra so pra capturar o texto REAL que o Claude Code entrega no StopFailure
  const dump = path.join(base, 'entrada-hook.jsonl');
  const dumpHook = path.join(base, 'dump-hook.js');
  fs.writeFileSync(dumpHook, `require('fs').appendFileSync(${JSON.stringify(dump)}, require('fs').readFileSync(0,'utf8').replace(/\\s+/g,' ') + '\\n')`);
  const settingsExtra = path.join(base, 'settings-extra.json');
  const hooksExtra = { StopFailure: [{ matcher: 'rate_limit', hooks: [{ type: 'command', command: `node "${dumpHook}"` }] }] };
  if (nome === 'aviso') {
    // Imita o cliente: 1 s apos o pedido (resposta ainda em andamento) grava a nota "wrap_up" e a linha de reset no
    // transcript. Formato copiado de uma sessao real. So na 1a vez, senao a retomada ganharia outra nota.
    const injetor = path.join(base, 'injetor.js');
    fs.writeFileSync(injetor, [
      "const fs = require('fs');",
      'const transcript = process.argv[2];',
      'setTimeout(() => {',
      '  const ts = new Date().toISOString();',
      "  const grava = (o) => fs.appendFileSync(transcript, JSON.stringify(o) + String.fromCharCode(10));",
      "  grava({ type: 'user', message: { role: 'user', content: '[Usage limit reached; a short grace allowance remains.]' }, isMeta: true, turnCompanion: true, usageLimitNote: 'wrap_up', uuid: 'e2e-nota-1', timestamp: ts });",
      "  grava({ type: 'system', subtype: 'informational', content: 'Usage limit reached \\u00b7 continuing automatically at 11:59pm \\u00b7 esc to cancel', timestamp: ts });",
      '}, 1000);',
    ].join('\n'));
    const lancador = path.join(base, 'lancador.js');
    const marca = path.join(base, 'injetado');
    fs.writeFileSync(lancador, [
      "const fs = require('fs'); const { spawn } = require('child_process');",
      "const entrada = JSON.parse(fs.readFileSync(0, 'utf8'));",
      `if (!fs.existsSync(${JSON.stringify(marca)})) {`,
      `  fs.writeFileSync(${JSON.stringify(marca)}, '1');`,
      `  spawn(process.execPath, [${JSON.stringify(injetor)}, entrada.transcript_path], { detached: true, stdio: 'ignore' }).unref();`,
      '}',
    ].join('\n'));
    hooksExtra.UserPromptSubmit = [{ hooks: [{ type: 'command', command: `node "${lancador}"` }] }];
  }
  fs.writeFileSync(settingsExtra, JSON.stringify({ hooks: hooksExtra }));

  // 5) sessao longa do Claude Code
  const p = spawn(CLAUDE, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--settings', SHELL ? `"${settingsExtra}"` : settingsExtra],
    { cwd: WORK, env: { ...envBase, ANTHROPIC_BASE_URL: `http://127.0.0.1:${porta}` }, stdio: ['pipe', 'pipe', 'pipe'], shell: SHELL });
  let saida = '';
  p.stdout.on('data', (d) => { saida += d; });
  p.stderr.on('data', (d) => { saida += '[stderr] ' + d; });
  p.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: 'diga oi' } }) + '\n');

  const prazo = Date.now() + (nome === 'ambas' ? 240000 : 100000);
  while (Date.now() < prazo && !saida.includes('RETOMADO-SOZINHO')) await dorme(500);
  await dorme(1500);
  await new Promise((k) => { p.once('exit', k); p.kill(); setTimeout(k, 4000); });
  server.close();

  // 6) conferencias
  const msgs = reqs.filter((x) => x.m === 'POST' && x.url.startsWith('/v1/messages'));
  const seq = msgs.map((x) => x.auth.replace('Bearer acc-', ''));
  const entradas = fs.existsSync(dump) ? fs.readFileSync(dump, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  const log = fs.existsSync(path.join(CFG, 'contas', 'trocas.log')) ? fs.readFileSync(path.join(CFG, 'contas', 'trocas.log'), 'utf8') : '';
  console.log('  pedidos a /v1/messages (conta):', seq.join(' -> ') || '(nenhum)');
  console.log('  texto do StopFailure:', entradas.map((e) => e.last_assistant_message).join(' || ') || '(nao disparou)');
  console.log('  trocas.log:\n    ' + log.trim().split('\n').join('\n    '));

  try {
    if (nome === 'aviso') assert.equal(entradas.length, 0, 'nao houve 429: o StopFailure nao pode ter disparado');
    else {
      assert.ok(entradas.length >= 1 && entradas.every((e) => e.error === 'rate_limit'), 'o Claude Code classificou o 429 como rate_limit e chamou o hook');
      ok('o 429 virou StopFailure/rate_limit e o hook do plugin foi chamado');
    }
    assert.ok(saida.includes('RETOMADO-SOZINHO'), 'o modelo foi acordado e respondeu sem ninguem digitar');
    ok('a sessao foi acordada sozinha e respondeu (ninguem digitou "continua")');
    const credFinal = JSON.parse(fs.readFileSync(path.join(CFG, '.credentials.json'), 'utf8'));
    assert.equal(credFinal.mcpOAuth.servidorX.accessToken, 'MCP-INTACTO');
    ok('tokens de MCP intactos; caminho com espacos funcionou');

    if (nome === 'troca' || nome === 'aviso') {
      assert.deepEqual([seq[0], seq[seq.length - 1]], ['A', 'B'], 'primeiro pedido na A, ultimo na B');
      ok('a sessao ABERTA passou a usar o token da conta B apos a troca');
      if (nome === 'aviso') assert.match(log, /AVISO de limite antes de estourar[^\n]*\n[^\n]*TROCOU \(aviso\): a@teste\.com -> b@teste\.com/);
      else assert.match(log, /TROCOU \(limite\): a@teste\.com -> b@teste\.com/);
      assert.equal(credFinal.claudeAiOauth.accessToken, 'acc-B');
      assert.equal(JSON.parse(fs.readFileSync(path.join(CFG, '.claude.json'), 'utf8')).oauthAccount.emailAddress, 'b@teste.com');
      ok('login e identidade ficaram na B');
    } else {
      assert.deepEqual(seq.slice(0, 2), ['A', 'B'], 'A falha, troca pra B, B tambem falha');
      assert.match(log, /todas as contas no limite/);
      assert.match(log, /VOLTOU \(limite renovado\)/);
      const ultimo = msgs[msgs.length - 1];
      assert.ok(ultimo.at >= resetEpoch * 1000, 'o pedido que deu certo so saiu DEPOIS do reset');
      ok(`as duas no limite: esperou o reset (${Math.round((ultimo.at - msgs[1].at) / 1000)} s) e retomou sozinho`);
    }
    // o caso do hook ter acordado duas vezes (retomada duplicada) apareceria como 2 respostas
    const respostas = (saida.match(/RETOMADO-SOZINHO/g) || []).length;
    assert.ok(respostas <= 2, 'sem retomadas duplicadas (o stream repete o texto em 2 eventos)');
    ok('sem retomada duplicada');
  } finally {
    try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 80, retryDelay: 500 }); } catch { console.log('  (nao consegui apagar ' + base + ', apague na mao)'); }
  }
}

(async () => {
  const pedido = process.argv[2];
  const lista = pedido ? [pedido] : ['troca', 'aviso', 'ambas'];
  for (const n of lista) await cenario(n);
  console.log('\nE2E OK');
  process.exit(0);
})().catch((e) => { console.error('\nE2E FALHOU:', e.message); process.exit(1); });
