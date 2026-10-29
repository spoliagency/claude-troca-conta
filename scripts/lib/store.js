'use strict';
// Onde o Claude Code guarda o login (.credentials.json ou Keychain do Mac) e como ler/gravar la.
// Contrato de cada store: { tipo, ler() -> objeto, gravar(objeto) }. Falha com excecao, nunca em silencio.

const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { lerJson, gravar } = require('./util');

const CHUNK = 2400;          // mesmo tamanho de pedaco que o Claude Code usa no Keychain
const MAX_PEDACOS = 256;
const LIMITE_UNICO = 1800;   // bytes de JSON que cabem numa linha do `security -i` (hex dobra o tamanho)

// ---------- Windows / Linux: arquivo ----------
function storeArquivo(p) {
  return {
    tipo: 'arquivo',
    local: p.cred,
    ler: () => lerJson(p.cred),
    gravar: (obj) => gravar(p.cred, obj),
  };
}

// ---------- Mac: Keychain ----------
// Nome do servico igual ao do Claude Code: "Claude Code-credentials" e, com CLAUDE_CONFIG_DIR,
// "-<8 primeiros hex do sha256 do caminho>".
function servicoKeychain(env, configDir) {
  if (env.TROCAR_KEYCHAIN_SERVICE) return env.TROCAR_KEYCHAIN_SERVICE;
  const sec = env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const semHash = sec !== undefined ? !sec : !env.CLAUDE_CONFIG_DIR;
  const base = sec !== undefined ? sec.normalize('NFC') : configDir;
  const hash = semHash ? '' : '-' + crypto.createHash('sha256').update(base).digest('hex').slice(0, 8);
  return `Claude Code-credentials${hash}`;
}

function decodificar(v) {
  const t = v.trim();
  if (t.startsWith('{')) return t;
  if (/^[0-9a-f]+$/i.test(t) && t.length % 2 === 0) return Buffer.from(t, 'hex').toString('utf8'); // `security -w` imprime hex quando o dado nao e texto simples
  return t;
}

function storeKeychain(env, configDir) {
  const bin = env.TROCAR_SECURITY_BIN || 'security';
  const servico = servicoKeychain(env, configDir);
  const contas = env.TROCAR_KEYCHAIN_ACCOUNT
    ? [env.TROCAR_KEYCHAIN_ACCOUNT]
    : [...new Set(['claude-code-user', os.userInfo().username])];

  const sec = (args, input) => {
    const [cmd, pre] = /\.js$/.test(bin) ? [process.execPath, [bin]] : [bin, []];
    return execFileSync(cmd, [...pre, ...args], { encoding: 'utf8', input, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] });
  };
  const get = (acct) => {
    try { return sec(['find-generic-password', '-a', acct, '-w', '-s', servico]).replace(/\r?\n$/, '') || null; } catch { return null; }
  };
  const aspas = (s) => '"' + String(s).replace(/(["\\])/g, '\\$1') + '"';
  const cmds = (linhas) => sec(['-i'], linhas.join('\n') + '\n');
  const addHex = (acct, texto) => `add-generic-password -U -a ${aspas(acct)} -s ${aspas(servico)} -X ${aspas(Buffer.from(texto, 'utf8').toString('hex'))}`;
  const addTxt = (acct, texto) => `add-generic-password -U -a ${aspas(acct)} -s ${aspas(servico)} -w ${aspas(texto)}`;

  // Conta do Keychain onde o item foi achado na ultima leitura boa. Guardada pra que o restauro depois de
  // uma gravacao ruim nao dependa de reler um estado que pode estar quebrado.
  let lembrada = null;

  // Devolve { acct, formato, texto } ou null se nao ha item. Lanca se o item existe mas esta incoerente.
  function lerBruto() {
    for (const acct of contas) {
      const unico = get(acct);
      if (unico) { lembrada = acct; return { acct, formato: 'unico', texto: decodificar(unico) }; }
      const m = get(acct + '#m');
      if (!m) continue;
      let man;
      try { man = JSON.parse(m); } catch { throw new Error('Keychain: manifest ilegivel'); }
      if (!(Number.isInteger(man.n) && Number.isInteger(man.l) && man.n > 0 && man.n <= MAX_PEDACOS && man.l > 0 && man.l <= man.n * CHUNK)) {
        throw new Error('Keychain: manifest com formato desconhecido');
      }
      const partes = [];
      for (let i = 0; i < man.n; i++) {
        const p = get(`${acct}#${i}`);
        if (p == null) throw new Error(`Keychain: falta o pedaco ${i} de ${man.n}`);
        partes.push(p);
      }
      const b64 = partes.join('');
      if (b64.length !== man.l) throw new Error('Keychain: tamanho dos pedacos nao confere com o manifest');
      lembrada = acct;
      return { acct, formato: 'pedacos', texto: Buffer.from(b64, 'base64').toString('utf8') };
    }
    return null;
  }

  const st = {
    tipo: 'keychain',
    local: `${servico}`,
    existe: () => { try { return lerBruto() !== null; } catch { return true; } },
    descrever: () => { const b = lerBruto(); return b ? { formato: b.formato, bytes: Buffer.byteLength(b.texto) } : null; },
    ler() {
      const b = lerBruto();
      if (!b) throw new Error('Keychain: item de login nao encontrado');
      let obj;
      try { obj = JSON.parse(b.texto); } catch { throw new Error('Keychain: conteudo nao e JSON'); }
      return obj;
    },
    gravar(obj) {
      const acct = lembrada || (lerBruto() || {}).acct;
      if (!acct) throw new Error('Keychain: item de login nao encontrado (nada a atualizar)');
      const texto = JSON.stringify(obj);
      if (Buffer.byteLength(texto) <= LIMITE_UNICO) {
        cmds([addHex(acct, texto)]);
      } else {
        const b64 = Buffer.from(texto, 'utf8').toString('base64');
        const pedacos = [];
        for (let i = 0; i < b64.length; i += CHUNK) pedacos.push(b64.slice(i, i + CHUNK));
        if (pedacos.length > MAX_PEDACOS) throw new Error('Keychain: credencial grande demais');
        const linhas = pedacos.map((p, i) => addTxt(`${acct}#${i}`, p));
        linhas.push(addHex(acct + '#m', JSON.stringify({ n: pedacos.length, l: b64.length })));
        cmds(linhas);
        // o Claude le o item unico primeiro; se sobrar um antigo ele mascara os pedacos novos
        try { cmds([`delete-generic-password -a ${aspas(acct)} -s ${aspas(servico)}`]); } catch { /* ja nao existia */ }
      }
      const depois = JSON.stringify(st.ler());
      if (depois !== texto) throw new Error('Keychain: a leitura de volta nao confere com o que foi gravado');
    },
  };
  return st;
}

// Escolhe o store. No Mac so mexe no Keychain com a opcao ligada (experimental, sem teste em Mac real).
function escolherStore(p, env, cfg) {
  const forcado = env.TROCAR_STORE;
  const mac = process.platform === 'darwin';
  if (forcado === 'arquivo' || (!mac && forcado !== 'keychain')) return storeArquivo(p);
  const kc = storeKeychain(env, p.configDir);
  if (!kc.existe()) return storeArquivo(p); // sem item no Keychain o Claude Code cai pro arquivo
  if (!(cfg.mac || env.TROCAR_MAC === '1')) {
    throw new Error('Mac: o login esta no Keychain e o suporte a Mac e experimental. Rode "diagnosticar"; se estiver ok, "ativar-mac".');
  }
  return kc;
}

module.exports = { escolherStore, storeArquivo, storeKeychain, servicoKeychain };
