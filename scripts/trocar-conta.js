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
//   guia                       onde voce esta no cadastro e qual o proximo passo (lido do estado real)
//   salvar                     guarda a conta logada agora
//   ensaio                     troca para cada outra conta e volta, conferindo (prova que funciona)
//   status                     contas guardadas, a ativa e os limites
//   lembrete                   aviso de inicio de sessao (hook SessionStart), mudo quando esta tudo certo
//   trocar [email] [--dry]     troca de conta agora (manual)
//   trocar --hook              modo hook StopFailure/rate_limit (le o JSON do stdin)
//   parou                      modo hook Stop: o limite foi AVISADO antes de estourar (le o transcript)
//   diagnosticar               confere o ambiente, sem alterar nada
//   esquecer <email>           apaga uma conta guardada
//   config [chave valor]       mostra ou muda: esperar, maxEsperaHoras, mac, lembrete, antecipar

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
function config() { return { esperar: true, maxEsperaHoras: 5.5, mac: false, lembrete: true, antecipar: true, ...lerOpcional(P.config) }; }
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

function aplicar(a, alvo, st, sessao, motivo = 'manual') {
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
  st._ultima = { de: a.email, para: alvo.email, em: new Date().toISOString(), motivo };
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

// Trava de arquivo: duas esperas que acordam no mesmo instante leem o estado antes de qualquer uma gravar,
// e as duas trocariam e acordariam a sessao. Criar o arquivo com "wx" e atomico: so uma passa.
const TRAVA = path.join(P.dir, 'retomada.lock');
const TRAVA_TROCA = path.join(P.dir, 'troca.lock');
function pegarTrava(f = TRAVA) {
  try {
    fs.mkdirSync(P.dir, { recursive: true });
    const fd = fs.openSync(f, 'wx');
    fs.closeSync(fd);
    return true;
  } catch {
    try { if (Date.now() - fs.statSync(f).mtimeMs > 60000) { fs.unlinkSync(f); return pegarTrava(f); } } catch { /* sumiu: tenta de novo na proxima volta */ }
    return false;
  }
}
const soltarTrava = (f = TRAVA) => { try { fs.unlinkSync(f); } catch { /* ja solta */ } };

// Decide e executa a troca da retomada com a trava na mao. Devolve o que fazer depois de soltar a trava.
function decidirRetomada(sessao, inicio) {
  const a = atual();
  const st = estado();
  const agora = Date.now();
  // Outro hook (outra espera, outra sessao) ja trocou/retomou depois que comecei a esperar.
  if (st._ultimaTroca && st._ultimaTroca > inicio) return { sair: 'espera encerrada: ja foi retomado por outro hook' };

  const todas = contasGuardadas().filter((s) => !precisaLogin(s) || s.email === a.email);
  const livres = todas.filter((s) => !limitada(st, s.email, agora));
  const alvo = livres.find((s) => s.email === a.email) || livres[0]; // prefere ficar: trocar custa um refresh
  if (!alvo) { // a marcacao mudou enquanto eu esperava
    const marcadas = todas.filter((s) => st[s.email] && st[s.email].limiteAte).map((s) => s.email);
    if (marcadas.length) {
      const prox = proximaVolta(st, marcadas);
      if (prox - agora <= MAX_ESPERA_MS) return { esperar: prox };
    }
    return { sair: 'espera desistiu: proxima volta longe demais' };
  }
  if (alvo.email !== a.email) aplicar(a, alvo, st, sessao, 'renovado');
  else { st._ultimaTroca = agora; st._sessao = sessao; gravar(P.estado, st); }
  return { de: a.email, para: alvo.email };
}

function retomar(sessao, inicio) {
  if (!pegarTrava()) { log('espera encerrada: outra espera esta retomando agora'); process.exit(0); }
  let r;
  try { r = decidirRetomada(sessao, inicio); } finally { soltarTrava(); }
  if (r.sair) { log(r.sair); process.exit(0); }
  if (r.esperar) return aguardar(r.esperar, sessao, inicio);

  log(`VOLTOU (limite renovado): ${r.de} -> ${r.para}`);
  avisar(`Claude voltou para ${r.para}`, 'Limite renovado. Retomando sozinho.');
  acordar(`[troca-conta] o limite foi renovado; a sessao esta na conta ${r.para}. ${RETOMAR}`);
}

function lerStdin() { try { return JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return {}; } }

// Dois hooks juntos (sessoes vizinhas no mesmo limite) leem login e estado e depois gravam: o 2o pode ler o
// login ja trocado pelo 1o antes de o estado dele existir, e marcar a conta nova no limite por engano.
// A leitura-decisao-troca entra numa trava; a espera e o acordar ficam de fora (so agendam timers).
function trocar(opcoes) {
  const hook = opcoes.hook;
  const entrada = hook ? (opcoes.entradaPronta || lerStdin()) : {};
  const fim = Date.now() + 5000;
  let pegou = false;
  while (hook && !(pegou = pegarTrava(TRAVA_TROCA)) && Date.now() < fim) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  try { trocarSemTrava({ ...opcoes, entradaPronta: entrada }); } finally { if (pegou) soltarTrava(TRAVA_TROCA); }
}

function trocarSemTrava({ hook, dry, para, entradaPronta }) {
  const entrada = hook ? (entradaPronta || lerStdin()) : {};
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

  // Depois de "volta-primeiro" a conta nova JA esta marcada (de proposito), entao o teste acima nao distingue:
  // outra sessao que falhou na conta antiga nao pode remarcar a nova com a hora do aviso da antiga. So junta-se a espera.
  const naEspera = hook && recente && st._sessao !== entrada.session_id && st._ultima && st._ultima.motivo === 'volta-primeiro' && st._ultima.para === a.email;

  // Marca a conta que bateu no limite. Manual (sem --hook) nao marca: foi escolha dela.
  if (hook && !naEspera) {
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
    // Todas no limite: a sessao fica na conta que renova PRIMEIRA (empate = a atual, trocar custa um refresh).
    // Assim a espera termina na conta certa, e o proprio Claude Code retoma ali se este hook morrer.
    const hora = (e) => new Date(st[e].limiteAte).getTime();
    const primeira = outras.reduce((m, s) => (hora(s.email) < hora(m) ? s.email : m), a.email);
    const volta = hora(primeira);
    const msg = `todas as contas no limite; a primeira volta ${hhmm(volta)} (${primeira})`;
    log(msg);
    if (!hook) { if (!dry) gravar(P.estado, st); console.log(msg); return; }
    if (dry) { console.log(`[dry] ${msg}${primeira !== a.email ? `; passaria ${a.email} -> ${primeira}` : '; ficaria em ' + a.email}`); return; }

    let inicio = agora;
    if (primeira !== a.email) {
      try {
        aplicar(a, outras.find((s) => s.email === primeira), st, entrada.session_id, 'volta-primeiro');
        log(`TROCOU (volta-primeiro): ${a.email} -> ${primeira}`);
        inicio = st._ultimaTroca; // a espera nao pode se confundir com a propria troca ("ja foi retomado")
      } catch (e) { // sem a troca a espera ainda funciona: troca ao renovar
        log(`ERRO trocando pra conta que volta primeiro: ${e.message}`);
        gravar(P.estado, st);
      }
    } else gravar(P.estado, st);

    if (!CFG.esperar || volta - agora > MAX_ESPERA_MS) {
      avisar('Claude: todas as contas no limite', `A primeira (${primeira}) volta ${hhmm(volta)}${CFG.esperar ? ', longe demais pra esperar' : ''}.`);
      return;
    }
    avisar('Claude: todas as contas no limite', `Na conta ${primeira}, que volta primeiro. Volto sozinho por volta de ${hhmm(volta)}.`);
    aguardar(volta, entrada.session_id, inicio);
    return;
  }

  if (dry) { console.log(`[dry] trocaria ${a.email} -> ${alvo.email}`); return; }

  const motivo = entrada.antecipado ? 'aviso' : hook ? 'limite' : 'manual';
  aplicar(a, alvo, st, entrada.session_id, motivo);
  log(`TROCOU (${motivo}): ${a.email} -> ${alvo.email}`);
  if (hook) {
    avisar(`Claude trocou para ${alvo.email}`, `${a.email} bateu o limite. Retomando sozinho.`);
    acordar(`[troca-conta] ${a.email} bateu o limite de uso; a sessao ja esta na conta ${alvo.email}. ${entrada.antecipado ? PENDENTE : ''}${RETOMAR}`);
  } else console.log(`${a.email} -> ${alvo.email}`);
}

// --- limite avisado ANTES de estourar ---------------------------------------------------------
// Perto do limite o Claude Code injeta na conversa uma nota ("Usage limit reached; a short grace
// allowance remains...", marcada usageLimitNote:"wrap_up") e o modelo encerra o turno por conta propria.
// Isso e um fim de turno NORMAL: o StopFailure/rate_limit nao dispara, a conta so trocava quando a pessoa
// digitava de novo e batia no limite de verdade. Este caminho le a nota no transcript, no hook Stop.
const PENDENTE = 'Sua ultima resposta parou cedo por causa do aviso de limite (a conta ja foi trocada): continue o que ficou pendente nela. ';
const NOTA_RE = /"usageLimitNote":"(wrap_up|release)"/;
const NOTA_RECENTE_MS = 15 * 60 * 1000;
const TAIL_BYTES = 512 * 1024;
const ESPERA_AVISO_MS = process.env.TROCAR_ESPERA_AVISO_MS !== undefined ? Number(process.env.TROCAR_ESPERA_AVISO_MS) : 3000;

function lerFimDoArquivo(f) {
  const fd = fs.openSync(f, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    const ini = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - ini);
    fs.readSync(fd, buf, 0, buf.length, ini);
    const linhas = buf.toString('utf8').split('\n');
    if (ini > 0) linhas.shift(); // primeira linha pode ter sido cortada no meio
    return linhas;
  } finally { fs.closeSync(fd); }
}

// Procura, de tras pra frente, a nota "wrap_up" do turno que acabou de terminar.
// Devolve { uuid, ts, reset } ou null. `reset` vem da linha "continuing automatically at 1:40am" que o
// cliente escreve logo depois do Stop (pode ainda nao estar la).
function acharNotaDeLimite(transcript) {
  const linhas = lerFimDoArquivo(transcript);
  let reset = null;
  for (let i = linhas.length - 1; i >= 0; i--) {
    const l = linhas[i];
    if (!l) continue;
    if (!NOTA_RE.test(l)) {
      if (reset === null && /continuing automatically at/.test(l)) {
        try { const m = /continuing automatically at ([^·"]+)/.exec(JSON.parse(l).content || ''); if (m) reset = m[1].trim(); } catch { /* linha ilegivel: ignora */ }
      }
      if (/"origin":\{"kind":"human"\}/.test(l)) return null; // chegou na pergunta da pessoa sem achar nota: nao e deste turno
      continue;
    }
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (o.usageLimitNote !== 'wrap_up') return null; // "release": o limite foi liberado depois
    return { uuid: o.uuid, ts: new Date(o.timestamp).getTime(), reset };
  }
  return null;
}

function parou() {
  const entrada = lerStdin();
  if (CFG.antecipar === false || !entrada.transcript_path) return;
  let nota;
  try { nota = acharNotaDeLimite(entrada.transcript_path); } catch { return; } // transcript ilegivel: nao e problema de conta
  if (!nota) return;
  const st = estado();
  if (st._graceUuid === nota.uuid) return; // ja tratada
  if (st._ultimaTroca && st._ultimaTroca > nota.ts) return; // a conta mudou depois da nota: a nota e da conta antiga
  if (Date.now() - nota.ts > NOTA_RECENTE_MS) return;

  // A hora do reset aparece logo apos o Stop; espera um pouco por ela em vez de chutar 5h.
  const fim = Date.now() + ESPERA_AVISO_MS;
  while (!nota.reset && Date.now() < fim) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    nota = acharNotaDeLimite(entrada.transcript_path) || nota;
  }

  st._graceUuid = nota.uuid;
  gravar(P.estado, st);
  log(`AVISO de limite antes de estourar (sessao ${entrada.session_id}); reset ${nota.reset || 'desconhecido, uso 5h'}`);
  trocar({
    hook: true,
    entradaPronta: { error: 'rate_limit', session_id: entrada.session_id, antecipado: true, last_assistant_message: nota.reset ? `resets ${nota.reset}` : '' },
  });
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
  const u = st._ultima;
  if (u && u.motivo !== 'ensaio') console.log(`ultima troca: ${hhmm(u.em)}  ${u.de} -> ${u.para}  (${u.motivo})`);
  if (st._ensaio) console.log(`ensaio: ${st._ensaio.ok ? 'ok em ' + hhmm(st._ensaio.em) : 'FALHOU: ' + st._ensaio.erro}`);
  console.log(`(* = logada agora) · guardadas em ${P.dir}`);
}

// Onde a pessoa esta no cadastro, lido do estado REAL (login, contas guardadas, ensaio), nunca da conversa.
// n = 1..4 e o passo que falta; n = 5 quer dizer pronto.
function progresso() {
  let a = null; let erro = null;
  try { a = atual(); } catch (e) { erro = e.message; }
  const lista = contasGuardadas();
  const st = estado();
  const emails = lista.map((s) => s.email).sort();
  const vencidas = lista.filter(precisaLogin);
  const ativaGuardada = !!a && lista.some((s) => s.email === a.email);
  const ens = st._ensaio;
  const ensaioOk = !!(ens && ens.ok && JSON.stringify(ens.contas) === JSON.stringify(emails));
  const ok = [!!a, lista.length >= 1, lista.length >= 2 && !vencidas.length, false];
  ok[3] = ok[2] && ensaioOk && ativaGuardada;
  const n = ok.findIndex((x) => !x) + 1 || 5;
  return { a, erro, lista, st, emails, vencidas, ativaGuardada, ens, ok, n };
}

function guia() {
  const g = progresso();
  const marca = (v, depende) => (v ? '[ok]   ' : depende ? '[falta]' : '[     ]');
  const nomes = [
    `1. Login do Claude Code lido${g.a ? ': ' + g.a.email : ''}`,
    '2. Primeira conta guardada',
    '3. Segunda conta guardada e com login valido',
    '4. Troca testada (ensaio)',
  ];
  console.log('Passo a passo da troca de conta');
  nomes.forEach((t, i) => console.log(`${marca(g.ok[i], g.n === i + 1)} ${t}`));

  if (g.n === 5) {
    const u = g.st._ultima;
    console.log('ESTADO: PRONTO');
    console.log('CONTAS: ' + g.lista.map((s) => `${s.email} (${s.claudeAiOauth.subscriptionType || '?'})`).join(', '));
    console.log(`ENSAIO: ${hhmm(g.ens.em)}, trocou entre ${g.emails.join(' e ')} e voltou, login e identidade conferidos nos dois sentidos`);
    console.log(u && u.motivo !== 'ensaio'
      ? `ULTIMA TROCA REAL: ${hhmm(u.em)} ${u.de} -> ${u.para} (${u.motivo})`
      : 'ULTIMA TROCA REAL: ainda nao houve (so acontece quando uma conta bater o limite)');
    console.log('AGORA: nada a fazer. Quando uma conta bater o limite a sessao troca e continua sozinha; um aviso do sistema aparece a cada troca.');
    return;
  }

  let agora;
  if (g.n === 1) {
    agora = /^Mac:/.test(g.erro || '')
      ? g.erro
      : `Peca a pessoa para digitar /login e entrar numa conta Claude (login so por chave de API nao serve). Detalhe tecnico: ${g.erro}`;
  } else if (g.n === 2) {
    agora = `Rode: salvar   (guarda ${g.a.email}). Depois rode guia de novo.`;
  } else if (g.n === 3) {
    if (g.vencidas.length) agora = `${g.vencidas.map((s) => s.email).join(', ')} precisa de /login de novo (o token de renovacao venceu). Peca /login nessa conta e rode: salvar`;
    else if (!g.ativaGuardada) agora = `A conta ativa (${g.a.email}) ainda nao esta guardada. Rode: salvar   Depois rode guia de novo.`;
    else agora = `So ha 1 conta guardada (${g.a.email}). Peca a pessoa para digitar /login e entrar na OUTRA conta (nunca /logout). Voce NAO consegue fazer o login por ela. Quando ela avisar que terminou, rode guia de novo.`;
  } else if (!g.ativaGuardada) {
    agora = `A conta ativa (${g.a.email}) nao esta entre as guardadas. Rode: salvar   Depois rode guia de novo.`;
  } else if (g.ens && g.ens.ok === false) {
    agora = `O ultimo ensaio falhou: ${g.ens.erro}. Rode diagnosticar, resolva o que aparecer como FALHA e rode ensaio de novo.`;
  } else {
    agora = 'Explique que o ensaio troca de conta por cerca de 1 segundo e volta (ninguem perde nada), peca um ok e rode: ensaio';
  }
  console.log(`ESTADO: PASSO ${g.n} de 4`);
  console.log('AGORA: ' + agora);
}

// Prova que a troca funciona NESTA maquina sem esperar um limite de verdade: vai para cada outra conta
// guardada e volta, conferindo login e identidade lidos de volta nos dois sentidos.
function ensaio() {
  const a = atual();
  const guardadas = contasGuardadas();
  if (!guardadas.some((s) => s.email === a.email)) throw new Error(`a conta ativa (${a.email}) ainda nao esta guardada; rode "salvar" antes`);
  const vencidas = guardadas.filter(precisaLogin);
  if (vencidas.length) throw new Error(`${vencidas.map((s) => s.email).join(', ')} precisa(m) de /login de novo; faca o login nela e rode "salvar"`);
  const outras = guardadas.filter((s) => s.email !== a.email);
  if (!outras.length) throw new Error('so ha uma conta guardada; o ensaio precisa de uma segunda');

  const stAntes = estado();
  const st = JSON.parse(JSON.stringify(stAntes));
  const credAntes = a.store.ler();
  const identAntes = lerJson(P.ident);
  const conferir = (esperada) => {
    const c = a.store.ler(); const i = lerJson(P.ident);
    if (!c.claudeAiOauth || c.claudeAiOauth.accessToken !== esperada.claudeAiOauth.accessToken) throw new Error('o login lido de volta nao e o da conta esperada');
    if (!i.oauthAccount || i.oauthAccount.emailAddress !== esperada.email) throw new Error('a identidade lida de volta nao e a da conta esperada');
  };
  const relatorio = [];
  try {
    for (const alvo of outras) {
      aplicar(a, alvo, st, 'ensaio', 'ensaio'); conferir(alvo);
      relatorio.push(`${a.email} -> ${alvo.email}: ok (login e identidade conferidos)`);
      const original = lerJson(slot(a.email)); // o aplicar acabou de guardar a conta original, ja com o token mais novo
      aplicar(atual(), original, st, 'ensaio', 'ensaio'); conferir(original);
      relatorio.push(`${alvo.email} -> ${a.email}: ok (voltou ao original)`);
    }
  } catch (e) {
    try { a.store.gravar(credAntes); gravar(P.ident, identAntes); } catch (e2) { log(`ERRO ensaio ao restaurar: ${e2.message}`); }
    stAntes._ensaio = { ok: false, em: new Date().toISOString(), erro: e.message };
    gravar(P.estado, stAntes);
    throw new Error(`ensaio falhou: ${e.message} (o login original foi restaurado)`);
  }
  // o ensaio nao pode deixar rastro de "troca recente" nem de "ultima troca": volta ao estado de antes
  stAntes._ensaio = { ok: true, em: new Date().toISOString(), contas: guardadas.map((s) => s.email).sort() };
  gravar(P.estado, stAntes);
  log(`ENSAIO ok: ${a.email} <-> ${outras.map((s) => s.email).join(', ')}`);
  console.log(relatorio.join('\n'));
  console.log(`Conta ativa de novo: ${a.email}`);
}

// Aviso curto no inicio da sessao enquanto o cadastro nao estiver completo. Silencioso quando esta tudo certo
// e quando algo falha (um lembrete nunca pode atrapalhar a abertura da sessao).
function lembrete() {
  try {
    if (CFG.lembrete === false) return;
    const g = progresso();
    if (g.n === 5 || g.n === 1) return; // pronto, ou sem login legivel (quem usa chave de API nao deve ser incomodado)
    const o = {
      2: 'nenhuma conta guardada ainda',
      3: g.vencidas.length ? `${g.vencidas[0].email} precisa de /login de novo` : 'so 1 conta guardada',
      4: 'a troca ainda nao foi testada',
    }[g.n];
    process.stdout.write(JSON.stringify({ systemMessage: `troca-conta: ${o}. Digite /troca-conta:troca-conta para o passo a passo (cerca de 2 minutos).` }));
  } catch { /* silencioso de proposito */ }
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
  if (!['esperar', 'maxEsperaHoras', 'mac', 'lembrete', 'antecipar'].includes(chave)) throw new Error('chaves: esperar, maxEsperaHoras, mac, lembrete, antecipar');
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
  else if (cmd === 'parou') parou();
  else if (cmd === 'diagnosticar') diagnosticar();
  else if (cmd === 'guia') guia();
  else if (cmd === 'ensaio') ensaio();
  else if (cmd === 'lembrete') lembrete();
  else if (cmd === 'config') configCmd(args[0], args[1]);
  else if (cmd === 'esquecer') esquecer(args[0]);
  else console.log('uso: guia | salvar | status | trocar [email] [--dry] | trocar --hook | parou | ensaio | diagnosticar | esquecer <email> | config [chave valor] | lembrete');
} catch (e) {
  log(`ERRO ${cmd}: ${e.message}`);
  console.error('erro: ' + e.message);
  // No hook ninguem esta olhando o terminal: sem aviso, "quebrou" parece "nao fez nada".
  if (flags.includes('--hook')) avisar('Claude: troca de conta falhou', e.message);
  process.exitCode = 1;
}
