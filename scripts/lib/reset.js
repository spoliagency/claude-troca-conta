'use strict';
// Le a hora em que o limite renova a partir do texto do aviso do Claude Code.
// Formatos tratados (todos em ingles, que e como o cliente escreve):
//   "resets 3pm"  "resets 3:30pm (America/Sao_Paulo)"  "resets Nov 2, 9am"  "resets Nov 2 at 9am"
//   "resets in 2h 15m"  "resets in 45m"  "resets in 3 days"
// Devolve um Date, ou null quando nao reconhece (quem chama usa uma estimativa).

const MESES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// Partes de data/hora de um instante num fuso IANA.
function partesNoFuso(instante, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  });
  const p = Object.fromEntries(f.formatToParts(instante).map((x) => [x.type, Number(x.value)]));
  return p;
}

// Instante (Date) em que o relogio de parede de `tz` marca a-m-d h:min.
function instanteNoFuso(ano, mes0, dia, h, min, tz) {
  if (!tz) return new Date(ano, mes0, dia, h, min, 0, 0);
  const alvoUtc = Date.UTC(ano, mes0, dia, h, min, 0);
  let chute = alvoUtc;
  for (let i = 0; i < 2; i++) { // corrige o deslocamento do fuso (2 passadas cobrem a virada de horario de verao)
    const p = partesNoFuso(new Date(chute), tz);
    const visto = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
    chute += alvoUtc - visto;
  }
  return new Date(chute);
}

function fusoValido(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

function lerReset(texto, agora = new Date()) {
  const t = String(texto || '');

  // relativo: "resets in 2h 15m" / "in 3 days"
  const rel = /resets?\s+in\s+((?:\d+\s*(?:d|days?|h|hrs?|hours?|m|mins?|minutes?)\s*)+)/i.exec(t);
  if (rel) {
    let ms = 0;
    for (const m of rel[1].matchAll(/(\d+)\s*(d|days?|h|hrs?|hours?|m|mins?|minutes?)/gi)) {
      const n = Number(m[1]); const u = m[2][0].toLowerCase();
      ms += n * (u === 'd' ? 864e5 : u === 'h' ? 36e5 : 6e4);
    }
    return ms > 0 ? new Date(agora.getTime() + ms) : null;
  }

  // absoluto: [Mon DD[,] [at]] H[:MM]am|pm [(Fuso/IANA)]
  const m = /resets?\s+(?:(?:on\s+)?([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s*\(([A-Za-z_]+(?:\/[A-Za-z_+\-0-9]+)*)\))?/i.exec(t);
  if (!m) return null;
  let h = Number(m[3]) % 12; if (/pm/i.test(m[5])) h += 12;
  const min = Number(m[4] || 0);
  const tz = m[6] && fusoValido(m[6]) ? m[6] : undefined;

  // "hoje" no fuso do aviso
  const ref = tz ? partesNoFuso(agora, tz) : { year: agora.getFullYear(), month: agora.getMonth() + 1, day: agora.getDate() };
  if (m[1]) {
    const mes0 = MESES.indexOf(m[1].toLowerCase());
    if (mes0 < 0) return null;
    let d = instanteNoFuso(ref.year, mes0, Number(m[2]), h, min, tz);
    if (d <= agora) d = instanteNoFuso(ref.year + 1, mes0, Number(m[2]), h, min, tz);
    return d;
  }
  let d = instanteNoFuso(ref.year, ref.month - 1, ref.day, h, min, tz);
  if (d <= agora) d = instanteNoFuso(ref.year, ref.month - 1, ref.day + 1, h, min, tz);
  return d;
}

module.exports = { lerReset };
