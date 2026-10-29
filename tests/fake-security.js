#!/usr/bin/env node
'use strict';
// Imita o `security` do macOS o bastante para testar o store do Keychain num PC qualquer.
// Banco: arquivo JSON em FAKE_SECURITY_DB, chave "servico\0conta". Imita tambem o limite de
// tamanho de linha do `security -i` (4000), que e o motivo do Claude Code dividir credenciais grandes.
const fs = require('fs');

const DB = process.env.FAKE_SECURITY_DB;
const LIMITE_LINHA = 4000;
const lerDb = () => (fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB, 'utf8')) : {});
const gravarDb = (db) => fs.writeFileSync(DB, JSON.stringify(db));

function tokenizar(linha) {
  const out = []; let cur = ''; let aspas = false; let tem = false;
  for (let i = 0; i < linha.length; i++) {
    const c = linha[i];
    if (aspas) {
      if (c === '\\') { cur += linha[++i]; } else if (c === '"') { aspas = false; } else cur += c;
    } else if (c === '"') { aspas = true; tem = true; } else if (/\s/.test(c)) { if (cur || tem) out.push(cur); cur = ''; tem = false; } else cur += c;
  }
  if (cur || tem) out.push(cur);
  return out;
}

function opts(args) {
  const o = { w: false };
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '-a') o.a = args[++i];
    else if (a === '-s') o.s = args[++i];
    else if (a === '-X') o.X = args[++i];
    else if (a === '-U') o.U = true;
    else if (a === '-w') { if (args[i + 1] !== undefined && !String(args[i + 1]).startsWith('-')) o.wval = args[++i]; else o.w = true; }
  }
  return o;
}

function executar(args) {
  const cmd = args[0]; const o = opts(args); const db = lerDb(); const chave = `${o.s}\u0000${o.a}`;
  if (cmd === 'find-generic-password') {
    if (!(chave in db)) { process.stderr.write('security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n'); process.exit(44); }
    process.stdout.write(o.w ? db[chave] + '\n' : `keychain: "login.keychain-db"\n    "acct"<blob>="${o.a}"\n`);
    return;
  }
  if (cmd === 'add-generic-password') {
    const valor = o.X !== undefined ? Buffer.from(o.X, 'hex').toString('utf8') : o.wval;
    if (valor === undefined) { process.stderr.write('security: faltou -w ou -X\n'); process.exit(1); }
    if (chave in db && !o.U) { process.stderr.write('security: item ja existe\n'); process.exit(45); }
    // FAKE_SECURITY_CORRUPT_ONCE=<arquivo>: a primeira gravacao sai truncada (e o `security` diz que deu certo)
    // FAKE_SECURITY_WRONG_ONCE=<arquivo>: a primeira gravacao sai como JSON valido, mas com outro conteudo
    const errado = process.env.FAKE_SECURITY_WRONG_ONCE;
    if (errado && !fs.existsSync(errado)) { fs.writeFileSync(errado, '1'); db[chave] = '{"outro":"conteudo"}'; gravarDb(db); return; }
    const flag = process.env.FAKE_SECURITY_CORRUPT_ONCE;
    if (flag && !fs.existsSync(flag)) { fs.writeFileSync(flag, '1'); db[chave] = valor.slice(0, -5); gravarDb(db); return; }
    db[chave] = valor; gravarDb(db); return;
  }
  if (cmd === 'delete-generic-password') {
    if (!(chave in db)) { process.stderr.write('security: item nao encontrado\n'); process.exit(44); }
    delete db[chave]; gravarDb(db); return;
  }
  process.stderr.write('security: comando desconhecido ' + cmd + '\n'); process.exit(1);
}

const args = process.argv.slice(2);
if (args[0] === '-i') {
  const linhas = fs.readFileSync(0, 'utf8').split('\n').filter(Boolean);
  for (const l of linhas) {
    if (l.length > LIMITE_LINHA) { process.stderr.write(`security: linha longa demais (${l.length})\n`); process.exit(1); }
    executar(tokenizar(l));
  }
} else executar(args);
