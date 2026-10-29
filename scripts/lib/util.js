'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const lerJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

// Escrita atomica: grava num temporario e renomeia. No Windows o rename pode falhar se o
// Claude estiver com o arquivo aberto; nesse caso cai pra escrita direta.
function gravar(f, obj) {
  const tmp = f + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  try { fs.renameSync(tmp, f); } catch (e) { fs.writeFileSync(f, fs.readFileSync(tmp)); fs.unlinkSync(tmp); }
}

// Hora no fuso da maquina (nao no de quem escreveu o script).
const hhmm = (d) => new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function caminhos(env = process.env) {
  const configDir = (env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')).normalize('NFC');
  const dir = path.join(configDir, 'contas');
  return {
    configDir,
    cred: path.join(configDir, '.credentials.json'),
    // O Claude Code guarda a identidade em <config>/.claude.json quando ha CLAUDE_CONFIG_DIR, senao em ~/.claude.json
    ident: env.CLAUDE_CONFIG_DIR ? path.join(configDir, '.claude.json') : path.join(os.homedir(), '.claude.json'),
    dir,
    estado: path.join(dir, 'estado.json'),
    config: path.join(dir, 'config.json'),
    logf: path.join(dir, 'trocas.log'),
  };
}

function criarLog(logf) {
  return (msg) => {
    try {
      fs.mkdirSync(path.dirname(logf), { recursive: true });
      fs.appendFileSync(logf, `${new Date().toISOString()} ${msg}\n`);
    } catch { /* log nao pode derrubar a troca */ }
  };
}

module.exports = { lerJson, gravar, hhmm, caminhos, criarLog };
