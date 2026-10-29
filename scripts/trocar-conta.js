#!/usr/bin/env node
'use strict';
// Alterna o Claude Code entre contas quando uma bate o limite de uso, e retoma a sessao sozinho.
//
// Como funciona: o login fica no .credentials.json (Windows/Linux) ou no Keychain (Mac), chave
// claudeAiOauth, e a identidade em ~/.claude.json (oauthAccount). O Claude Code relê o login quando
// ele muda, entao trocar essas duas chaves vale na sessao aberta. O resto (mcpOAuth, tokens de MCP)
// nao e tocado.
//
// Uso (veja README.md):
//   salvar                     guarda a conta logada agora
//   status                     contas guardadas, a ativa e os limites
//   trocar [email] [--dry]     troca de conta agora (manual)
//   trocar --hook              modo hook StopFailure/rate_limit (le o JSON do stdin)
//   diagnosticar               confere o ambiente, sem alterar nada
//   esquecer <email>           apaga uma conta guardada
//   config [chave valor]       mostra ou muda: esperar, maxEsperaHoras, mac

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { lerJson, gravar, hhmm, caminhos, criarLog } = require('./lib/util');
const { lerReset } = require('./lib/reset');
const { escolherStore } = require('./lib/store');
const { avisar } = require('./lib/aviso');

const P = caminhos();
const log = criarLog(P.logf);

const EXTRAS = ['trustedDeviceToken', 'trustedDeviceEnrolledAfterRefusalAtMs']; // pertencem a conta+dispositivo
const FALLBACK_LIMITE_MS = 5 * 60 * 60 * 1000; // janela de 5h, quando o aviso nao traz a hora
const ANTI_PINGPONG_MS = 60 * 1000;
const RETOMAR = 'Retome exatamente de onde parou, sem pedir confirmacao e sem repetir o que ja foi feito.';

function lerOpcional(f) { try { return lerJson(f); } catch { return {}; } }
function config() { return { esperar: true, maxEsperaHoras: 5.5, mac: false, ...lerOpcional(P.config) }; }
const CFG = config();

// Variaveis de ambiente existem pra teste (relogio acelerado); o uso normal vem do config.json.
const MAX_ESPERA_MS = Number(process.env.TROCAR_MAX_ESPERA_MS) || CFG.maxEsperaHoras * 36e5;
const MARGEM_MS = process.env.TROCAR_MARGEM_MS !== undefined ? Number(process.env.TROCAR_MARGEM_MS) : 30 * 1000;
const POLL_MS = Number(process.env.TROCAR_POLL_MS) || 30 * 1000; // poll, nao timer longo: o PC pode dormir
const ACORDAR_MS = process.env.TROCAR_ACORDAR_MS !== undefined ? Number(process.env.TROCAR_ACORDAR_MS) : 2000;

const slot = (email) => path.join(P.dir, email.toLowerCase().replace(/[^a-z0-9@._-]/g, '_') + '.json');
const estado = () => lerOpcional(P.estado);
const limitada = (st, email, agora) => !!(st[email] && st[email].limiteAte && new Date(st[email].limiteAte) > agora);
const precisaLogin = (s) => !!(s.claudeAiOauth.refreshTokenExpiresAt && s.claudeAiOauth.refreshTokenExpiresAt < Date.now());
const proximaVolta = (st, emails) => Math.min(...emails.map((e) => new Date(st[e].limiteAte).getTime()));

function atual() {
  const store = escolherStore(P, process.env, CFG);
  const cred = store.ler();
  const ident = lerJson(P.ident);
  const email = ident.oauthAccount && ident.oauthAccount.emailAddress;
  if (!cred.claudeAiOauth || !email) throw new Error('nenhuma conta logada (sem claudeAiOauth ou oauthAccount)');
  return { store, cred, ident, email, oauth: cred.claudeAiOauth, conta: ident.oauthAccount };
}

function guardar(a) {
  fs.mkdirSync(P.dir, { recursive: true });
  const extras = {};
  for (const k of EXTRAS) if (a.cred[k] !== undefined) extras[k] = a.cred[k];
  gravar(slot(a.email), { v: 2, email: a.email, salvoEm: new Date().toISOString(), claudeAiOauth: a.oauth, oauthAccount: a.conta, extras });
}

function contasGuardadas() {
  if (!fs.existsSync(P.dir)) return [];
  return fs.readdirSync(P.dir)
    .filter((f) => f.endsWith('.json') && f !== 'estado.json' && f !== 'config.json')
    .map((f) => { try { return lerJson(path.join(P.dir, f)); } catch { return null; } })
    .filter((s) => s && s.email && s.claudeAiOauth)
    .sort((x, y) => x.email.localeCompare(y.email));
}

// Hook asyncRewake: exit 2 acorda a sessao e o stderr vira a mensagem pro modelo.
// A espera deixa o Claude Code notar que o login mudou antes do proximo pedido.
function acordar(texto) {
  process.stderr.write(texto);
  setTimeout(() => process.exit(2), ACORDAR_MS);
}

function aplicar(a, alvo, st, sessao) {
  guardar(a); // o token pode ter sido renovado desde o ultimo "salvar"
  const credAntes = a.store.ler();
  const cred = JSON.parse(JSON.stringify(credAntes));
  cred.claudeAiOauth = alvo.claudeAiOauth;
  if (alvo.v >= 2) { // slot antigo (v1) nao sabe os extras: deixa como esta
    for (const k of EXTRAS) { if (alvo.extras && alvo.extras[k] !== undefined) cred[k] = alvo.extras[k]; else delete cred[k]; }
  }
  try {
    a.store.gravar(cred);
  } catch (e) {
    try { a.store.gravar(credAntes); } catch { /* melhor esforco: o erro original e o que importa */ }
    throw e;
  }
  try {
    const ident = lerJson(P.ident);
    ident.oauthAccount = alvo.oauthAccount;
    gravar(P.ident, ident);
  } catch (e) {
    a.store.gravar(credAntes); // nao deixa login de uma conta com identidade de outra
    throw e;
  }
  st._ultimaTroca = Date.now();
  st._sessao = sessao;
  gravar(P.estado, st);
}

// Contas no limite: segura o hook vivo ate a primeira renovar, troca pra ela e acorda a sessao.
function aguardar(volta, sessao, inicio) {
  const t = setInterval(() => {
    try {
      if (Date.now() < volta + MARGEM_MS) return;
      clearInterval(t);
      retomar(sessao, inicio);
    } catch (e) { log(`ERRO aguardando: ${e.message}`); avisar('Claude: troca de conta falhou', e.message); process.exit(0); }
  }, POLL_MS);
}

function retomar(sessao, inicio) {
  const a = atual();
  const st = estado();
  const agora = Date.now();
  // Outro hook (outra espera, outra sessao) ja trocou/retomou depois que comecei a esperar.
  if (st._ultimaTroca && st._ultimaTroca > inicio) { log('espera encerrada: ja foi retomado por outro hook'); process.exit(0); }

  const todas = contasGuardadas().filter((s) => !precisaLogin(s) || s.email === a.email);
  const livres = todas.filter((s) => !limitada(st, s.email, agora));
  const alvo = livres.find((s) => s.email === a.email) || livres[0]; // prefere ficar: trocar custa um refresh
  if (!alvo) { // a marcacao mudou enquanto eu esperava
    const marcadas = todas.filter((s) => st[s.email] && st[s.email].limiteAte).map((s) => s.email);
    if (marcadas.length) {
      const prox = proximaVolta(st, marcadas);
      if (prox - agora <= MAX_ESPERA_MS) return aguardar(prox, sessao, inicio);
    }
    log('espera desistiu: proxima volta longe demais'); process.exit(0);
  }
  if (alvo.email !== a.email) aplicar(a, alvo, st, sessao);
  else { st._ultimaTroca = agora; st._sessao = sessao; gravar(P.estado, st); }

  log(`VOLTOU (limite renovado): ${a.email} -> ${alvo.email}`);
  avisar(`Claude voltou para ${alvo.email}`, 'Limite renovado. Retomando sozinho.');
  acordar(`[troca-conta] o limite foi renovado; a sessao esta na conta ${alvo.email}. ${RETOMAR}`);
}

function lerStdin() { try { return JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return {}; } }

function trocar({ hook, dry, para }) {
  const entrada = hook ? lerStdin() : {};
  if (hook && entrada.error && entrada.error !== 'rate_limit') return;

  const a = atual();
  const st = estado();
  const agora = Date.now();

  // Outra sessao que falhou na conta antiga logo apos uma troca: o login ja mudou, so falta acordar.
  // Falha da MESMA sessao que acabamos de acordar e outra coisa: a conta nova tambem esta no limite.
  const recente = st._ultimaTroca && agora - st._ultimaTroca < ANTI_PINGPONG_MS;
  if (hook && recente && st._sessao !== entrada.session_id && !limitada(st, a.email, agora)) {
    log(`outra sessao (${entrada.session_id}) falhou na conta antiga; ja esta em ${a.email}`);
    acordar(`[troca-conta] a conta desta sessao ja foi trocada para ${a.email}. ${RETOMAR}`);
    return;
  }

  // Marca a conta que bateu no limite. Manual (sem --hook) nao marca: foi escolha dela.
  if (hook) {
    const reset = lerReset(`${entrada.last_assistant_message || ''} ${entrada.error_details || ''}`);
    st[a.email] = { limiteAte: (reset || new Date(agora + FALLBACK_LIMITE_MS)).toISOString(), horaExata: !!reset };
  }

  const guardadas = contasGuardadas();
  let outras = guardadas.filter((s) => s.email !== a.email);
  if (para) outras = outras.filter((s) => s.email.toLowerCase() === para.toLowerCase());
  const vencidas = outras.filter(precisaLogin);
  outras = outras.filter((s) => !precisaLogin(s));

  if (!outras.length) {
    const msg = vencidas.length
      ? `a(s) conta(s) ${vencidas.map((s) => s.email).join(', ')} precisa(m) de /login de novo (o token de renovacao venceu)`
      : `so ha uma conta guardada (${a.email}); logue na outra e rode "salvar"`;
    log(`FALHOU: ${msg}`);
    if (hook) avisar('Claude: limite atingido, sem conta pra trocar', msg); else console.error(msg);
    process.exitCode = 1;
    return;
  }

  const alvo = outras.find((s) => !limitada(st, s.email, agora));

  if (!alvo) {
    const volta = proximaVolta(st, outras.map((s) => s.email).concat(a.email));
    const msg = `todas as contas no limite; a primeira volta ${hhmm(volta)}`;
    log(msg);
    if (!dry) gravar(P.estado, st);
    if (!hook) { console.log(msg); return; }
    if (!CFG.esperar || volta - agora > MAX_ESPERA_MS) {
      avisar('Claude: todas as contas no limite', `A primeira volta ${hhmm(volta)}${CFG.esperar ? ', longe demais pra esperar' : ''}.`);
      return;
    }
    avisar('Claude: todas as contas no limite', `Volto sozinho por volta de ${hhmm(volta)}.`);
    aguardar(volta, entrada.session_id, agora);
    return;
  }

  if (dry) { console.log(`[dry] trocaria ${a.email} -> ${alvo.email}`); return; }

  aplicar(a, alvo, st, entrada.session_id);
  log(`TROCOU (${hook ? 'limite' : 'manual'}): ${a.email} -> ${alvo.email}`);
  if (hook) {
    avisar(`Claude trocou para ${alvo.email}`, `${a.email} bateu o limite. Retomando sozinho.`);
    acordar(`[troca-conta] ${a.email} bateu o limite de uso; a sessao ja esta na conta ${alvo.email}. ${RETOMAR}`);
  } else console.log(`${a.email} -> ${alvo.email}`);
}

function dias(ms) { return Math.floor((ms - Date.now()) / 864e5); }

function status() {
  let ativa = null;
  try { ativa = atual().email; } catch (e) { console.log('logada agora: ninguem (' + e.message + ')'); }
  const st = estado();
  const lista = contasGuardadas();
  if (!lista.length) console.log('nenhuma conta guardada. Rode "salvar".');
  for (const s of lista) {
    const lim = limitada(st, s.email, Date.now()) ? `no limite ate ${hhmm(st[s.email].limiteAte)}` : 'livre';
    const r = s.claudeAiOauth.refreshTokenExpiresAt;
    const login = r ? (precisaLogin(s) ? 'PRECISA DE /login' : `login vale +${dias(r)}d`) : '';
    console.log(`${s.email === ativa ? '*' : ' '} ${s.email}  ${s.claudeAiOauth.subscriptionType || '?'}  ${lim}  ${login}`);
  }
  console.log(`(* = logada agora) · guardadas em ${P.dir}`);
}

function diagnosticar() {
  const linhas = []; let problemas = 0;
  const ok = (m) => linhas.push('  ok   ' + m);
  const aviso = (m) => linhas.push('  aviso ' + m);
  const ruim = (m) => { problemas++; linhas.push('  FALHA ' + m); };

  ok(`${process.platform} · node ${process.version} · config ${P.configDir}`);
  try {
    const v = execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 8000, shell: process.platform === 'win32' }).trim();
    ok(`claude ${v}`);
  } catch { aviso('nao consegui rodar "claude --version" (o hook nao precisa disso)'); }

  let store = null;
  try {
    store = escolherStore(P, process.env, CFG);
    ok(`login guardado em: ${store.tipo} (${store.local})`);
    if (store.descrever) { const d = store.descrever(); if (d) ok(`Keychain: formato ${d.formato}, ${d.bytes} bytes`); }
  } catch (e) { ruim(e.message); }

  if (store) {
    try {
      const cred = store.ler();
      ok(`credencial legivel; chaves: ${Object.keys(cred).join(', ')}`);
      if (!cred.claudeAiOauth) ruim('sem claudeAiOauth (login por chave de API nao e suportado)');
      else {
        const r = cred.claudeAiOauth.refreshTokenExpiresAt;
        if (r) (precisaLogin({ claudeAiOauth: cred.claudeAiOauth }) ? ruim : ok)(`token de renovacao da conta ativa vale +${dias(r)} dias`);
      }
    } catch (e) { ruim('nao consegui ler a credencial: ' + e.message); }
  }
  try { const i = lerJson(P.ident); i.oauthAccount && i.oauthAccount.emailAddress ? ok(`conta ativa: ${i.oauthAccount.emailAddress}`) : ruim('sem oauthAccount em ' + P.ident); }
  catch (e) { ruim('nao consegui ler ' + P.ident + ': ' + e.message); }

  const lista = contasGuardadas();
  if (lista.length < 2) aviso(`so ${lista.length} conta(s) guardada(s); a troca precisa de pelo menos 2 (logue na outra com /login e rode "salvar")`);
  else ok(`${lista.length} contas guardadas`);
  for (const s of lista) {
    const r = s.claudeAiOauth.refreshTokenExpiresAt;
    if (precisaLogin(s)) ruim(`${s.email}: token de renovacao VENCIDO, faca /login nela e "salvar"`);
    else if (r && dias(r) < 7) aviso(`${s.email}: token de renovacao vence em ${dias(r)} dias`);
    if (s.v !== 2) aviso(`${s.email}: guardada em formato antigo; rode "salvar" logado nela para atualizar`);
  }
  if (fs.existsSync(path.join(P.configDir, '.device-keys.json'))) aviso('existe .device-keys.json: o Claude pode pedir pra registrar o dispositivo de novo na 1a troca');
  if (process.platform === 'darwin' && !CFG.mac && !process.env.TROCAR_MAC) aviso('Mac: suporte experimental desligado (config mac)');

  console.log('Diagnostico:'); console.log(linhas.join('\n'));
  console.log(problemas ? `\n${problemas} problema(s).` : '\nTudo certo.');
  if (problemas) process.exitCode = 1;
}

function configCmd(chave, valor) {
  const atualCfg = lerOpcional(P.config);
  if (!chave) { console.log(JSON.stringify({ ...config() }, null, 2)); return; }
  if (!['esperar', 'maxEsperaHoras', 'mac'].includes(chave)) throw new Error('chaves: esperar, maxEsperaHoras, mac');
  const v = chave === 'maxEsperaHoras' ? Number(valor) : /^(on|true|1|sim)$/i.test(valor);
  if (chave === 'maxEsperaHoras' && !(v > 0)) throw new Error('maxEsperaHoras precisa ser um numero > 0');
  fs.mkdirSync(P.dir, { recursive: true });
  gravar(P.config, { ...atualCfg, [chave]: v });
  console.log(`${chave} = ${v}`);
}

function esquecer(email) {
  if (!email) throw new Error('uso: esquecer <email>');
  const f = slot(email);
  if (!fs.existsSync(f)) throw new Error('nao ha conta guardada com esse e-mail');
  fs.unlinkSync(f);
  const st = estado(); delete st[email]; gravar(P.estado, st);
  console.log('esquecida: ' + email);
}

const [cmd, ...resto] = process.argv.slice(2);
const flags = resto.filter((x) => x.startsWith('--'));
const args = resto.filter((x) => !x.startsWith('--'));
try {
  if (cmd === 'salvar') { const a = atual(); guardar(a); console.log('guardada: ' + a.email); }
  else if (cmd === 'status') status();
  else if (cmd === 'trocar') trocar({ hook: flags.includes('--hook'), dry: flags.includes('--dry'), para: args.find((x) => x.includes('@')) });
  else if (cmd === 'diagnosticar') diagnosticar();
  else if (cmd === 'config') configCmd(args[0], args[1]);
  else if (cmd === 'esquecer') esquecer(args[0]);
  else console.log('uso: salvar | status | trocar [email] [--dry] | trocar --hook | diagnosticar | esquecer <email> | config [chave valor]');
} catch (e) {
  log(`ERRO ${cmd}: ${e.message}`);
  console.error('erro: ' + e.message);
  // No hook ninguem esta olhando o terminal: sem aviso, "quebrou" parece "nao fez nada".
  if (flags.includes('--hook')) avisar('Claude: troca de conta falhou', e.message);
  process.exitCode = 1;
}
