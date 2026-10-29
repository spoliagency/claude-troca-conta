'use strict';
// Notificacao do sistema. O hook de StopFailure roda mudo: sem aviso, "trocou" e "quebrou" parecem igual.
// Melhor esforco: se nao houver como avisar, so o log fica.

const { spawn, spawnSync } = require('child_process');

function temComando(cmd) {
  try { return spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' }).status === 0; } catch { return false; }
}

function avisar(titulo, texto, env = process.env) {
  if (env.TROCAR_SEM_AVISO === '1') return;
  const solto = (cmd, args, extraEnv) => {
    try { spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true, env: { ...env, ...extraEnv } }).unref(); } catch { /* sem aviso */ }
  };
  if (process.platform === 'win32') {
    const ps = 'Add-Type -AssemblyName System.Windows.Forms,System.Drawing;' +
      '$n=New-Object System.Windows.Forms.NotifyIcon;$n.Icon=[System.Drawing.SystemIcons]::Information;$n.Visible=$true;' +
      '$n.ShowBalloonTip(10000,$env:T_TIT,$env:T_TXT,[System.Windows.Forms.ToolTipIcon]::Info);Start-Sleep 11;$n.Dispose()';
    solto('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], { T_TIT: titulo, T_TXT: texto });
  } else if (process.platform === 'darwin') {
    // texto vai por variavel de ambiente: nada do aviso e interpretado como AppleScript
    solto('osascript', ['-e', 'display notification (system attribute "T_TXT") with title (system attribute "T_TIT")'], { T_TIT: titulo, T_TXT: texto });
  } else if (temComando('notify-send')) {
    solto('notify-send', [titulo, texto]);
  }
}

module.exports = { avisar };
