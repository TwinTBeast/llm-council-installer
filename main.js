const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 700,
    height: 760,
    resizable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    title: 'LLM Council Plus — Installer',
    autoHideMenuBar: true
  });
  mainWindow.loadFile('index.html');
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// Run a command and return stdout (used for quick checks)
function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { shell: true }, (err, stdout, stderr) => {
      if (err) reject(stderr || err.message);
      else resolve(stdout.trim());
    });
  });
}

// Run a command and stream each line of output back to the renderer
function runStreaming(cmd, event, logChannel) {
  return new Promise((resolve, reject) => {
    const child = spawn('cmd.exe', ['/c', cmd], { shell: false });

    child.stdout.on('data', (data) => {
      const lines = data.toString().split(/\r?\n/).filter(l => l.trim());
      lines.forEach(line => event.sender.send(logChannel, line));
    });
    child.stderr.on('data', (data) => {
      const lines = data.toString().split(/\r?\n/).filter(l => l.trim());
      lines.forEach(line => event.sender.send(logChannel, line));
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(`Process exited with code ${code}`);
    });
    child.on('error', reject);
  });
}

// After winget/installer runs, refresh PATH in the current process from the registry
// so re-checks can find the newly installed tool without restarting.
async function refreshPath() {
  try {
    const userPath = await run(
      'powershell -NoProfile -Command "[System.Environment]::GetEnvironmentVariable(\'Path\', \'User\')"'
    );
    const machinePath = await run(
      'powershell -NoProfile -Command "[System.Environment]::GetEnvironmentVariable(\'Path\', \'Machine\')"'
    );
    const combined = [machinePath, userPath, process.env.PATH]
      .filter(Boolean)
      .join(';');
    process.env.PATH = combined;
  } catch (_) { /* best-effort */ }

  // Explicitly prepend all known uv install locations so we always find it
  const uvLocations = [
    path.join(os.homedir(), '.local', 'bin'),
    path.join(os.homedir(), '.cargo', 'bin'),
    path.join(os.homedir(), 'AppData', 'Local', 'uv', 'bin'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'uv', 'bin'),
  ];
  for (const dir of uvLocations) {
    if (!process.env.PATH.includes(dir)) {
      process.env.PATH = dir + ';' + process.env.PATH;
    }
  }
}

// Try to find uv by checking known install locations directly (in case PATH isn't updated yet)
async function findUvPath() {
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'uv.exe'),
    path.join(os.homedir(), '.cargo', 'bin', 'uv.exe'),
    path.join(os.homedir(), 'AppData', 'Local', 'uv', 'bin', 'uv.exe'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'uv', 'bin', 'uv.exe'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// Run a PowerShell script block and stream output — used for uv install
function runStreamingPowerShell(psScript, event, logChannel) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'ByPass', '-Command', psScript
    ], { shell: false });

    child.stdout.on('data', (data) => {
      const lines = data.toString().split(/\r?\n/).filter(l => l.trim());
      lines.forEach(line => event.sender.send(logChannel, line));
    });
    child.stderr.on('data', (data) => {
      const lines = data.toString().split(/\r?\n/).filter(l => l.trim());
      lines.forEach(line => event.sender.send(logChannel, line));
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(`PowerShell exited with code ${code}`);
    });
    child.on('error', reject);
  });
}

// Compare version strings e.g. "3.10.1" >= "3.10.0"
function versionOk(current, required) {
  const parse = v => v.replace(/[^0-9.]/g, '').split('.').map(Number);
  const c = parse(current);
  const r = parse(required);
  for (let i = 0; i < Math.max(c.length, r.length); i++) {
    const a = c[i] || 0, b = r[i] || 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

const MIN_VERSIONS = {
  git:    '2.40',
  node:   '18.0',
  python: '3.10',
  uv:     '0.5'
};

// ─── PREREQ CHECKS ────────────────────────────────────────────────────────────

ipcMain.handle('check-prereq', async (e, name) => {
  await refreshPath();
  try {
    let version = '';
    switch (name) {
      case 'git':    version = (await run('git --version')).split(' ')[2]; break;
      case 'node':   version = (await run('node --version')).replace('v', ''); break;
      case 'python': version = (await run('python --version')).replace('Python ', ''); break;
      case 'uv': {
        // Try PATH first, then fall back to known install locations
        let uvCmd = 'uv';
        try {
          await run('uv --version');
        } catch {
          const uvPath = await findUvPath();
          if (uvPath) uvCmd = `"${uvPath}"`;
          else throw new Error('uv not found');
        }
        version = (await run(`${uvCmd} --version`)).split(' ')[1];
        break;
      }
    }
    const ok = versionOk(version, MIN_VERSIONS[name]);
    return { found: true, ok, version, required: MIN_VERSIONS[name] };
  } catch {
    return { found: false, ok: false, version: null, required: MIN_VERSIONS[name] };
  }
});

// Install a prereq — streams live output back to the renderer, then refreshes PATH
ipcMain.handle('install-prereq', async (e, name) => {
  try {
    switch (name) {
      case 'git':
        await runStreaming(
          'winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements',
          e, 'prereq-log'
        );
        break;
      case 'node':
        await runStreaming(
          'winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements',
          e, 'prereq-log'
        );
        break;
      case 'python':
        await runStreaming(
          'winget install --id Python.Python.3.10 -e --source winget --accept-package-agreements --accept-source-agreements',
          e, 'prereq-log'
        );
        break;
      case 'uv':
        // uv uses a PowerShell-native installer — must run directly in powershell.exe,
        // not via cmd.exe, otherwise irm | iex output doesn't stream and may fail
        await runStreamingPowerShell(
          'irm https://astral.sh/uv/install.ps1 | iex',
          e, 'prereq-log'
        );
        break;
    }
    await refreshPath();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.toString() };
  }
});

// Update a prereq — same streaming approach
ipcMain.handle('update-prereq', async (e, name) => {
  try {
    switch (name) {
      case 'git':
        await runStreaming(
          'winget upgrade --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements',
          e, 'prereq-log'
        );
        break;
      case 'node':
        await runStreaming(
          'winget upgrade --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements',
          e, 'prereq-log'
        );
        break;
      case 'python':
        await runStreaming(
          'winget upgrade --id Python.Python.3.10 -e --source winget --accept-package-agreements --accept-source-agreements',
          e, 'prereq-log'
        );
        break;
      case 'uv': {
        // Use absolute path if uv isn't on PATH yet
        let uvCmd = 'uv';
        const uvPath = await findUvPath();
        if (uvPath) uvCmd = `"${uvPath}"`;
        await runStreaming(`${uvCmd} self update`, e, 'prereq-log');
        break;
      }
    }
    await refreshPath();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.toString() };
  }
});

// ─── MAIN INSTALL ─────────────────────────────────────────────────────────────

ipcMain.on('start-install', async (event, { installDir }) => {
  const send = (msg, pct) => event.sender.send('progress', { msg, pct });

  try {
    const repoPath = path.join(installDir, 'llm-council-plus');

    send('Cloning LLM Council Plus repository...', 10);
    if (fs.existsSync(repoPath)) {
      send('Folder already exists, skipping clone ✅', 20);
    } else {
      await run(`git clone https://github.com/jacob-bd/llm-council-plus.git "${repoPath}"`);
      send('Repository cloned ✅', 20);
    }

    send('Installing backend dependencies...', 30);
    await run(`cd "${repoPath}" && uv sync`);
    send('Backend dependencies ready ✅', 55);

    send('Installing frontend dependencies...', 60);
    await run(`cd "${repoPath}\\frontend" && npm install`);
    send('Frontend dependencies ready ✅', 75);

    send('Creating launcher script...', 80);
    const launcherPath  = path.join(repoPath, 'launch.vbs');
    const trayPsPath    = path.join(repoPath, 'tray.ps1');

    // Resolve uv absolute path for the launcher
    const uvExe      = (await findUvPath() || 'uv').replace(/\\/g, '\\\\');
    const repoPathEsc = repoPath.replace(/\\/g, '\\\\');
    // Single-backslash versions for PowerShell string literals
    const uvExePs    = (await findUvPath() || 'uv');
    const repoPs     = repoPath;
    const iconPs     = path.join(repoPath, 'icon.ico');

    // ── tray.ps1 ──────────────────────────────────────────────────────────────
    // Full PowerShell tray controller. Starts backend + frontend hidden,
    // shows a system tray icon with Open / Quit menu.
    const trayPsContent = `
# LLM Council Plus — Tray Controller
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# ── PATH refresh ─────────────────────────────────────────────────────────────
$userPath = [System.Environment]::GetEnvironmentVariable('PATH','User')
$sysPath  = [System.Environment]::GetEnvironmentVariable('PATH','Machine')
$extra    = "$env:USERPROFILE\\.local\\bin;$env:USERPROFILE\\.cargo\\bin"
$env:PATH = "$extra;$sysPath;$userPath;$env:PATH"

# ── Start backend & frontend hidden ──────────────────────────────────────────
function Start-Hidden($cmd, $workDir) {
    $si = New-Object System.Diagnostics.ProcessStartInfo
    $si.FileName  = 'cmd.exe'
    $si.Arguments = "/c $cmd"
    $si.WorkingDirectory    = $workDir
    $si.WindowStyle         = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $si.CreateNoWindow      = $true
    $si.UseShellExecute     = $false
    $p = [System.Diagnostics.Process]::Start($si)
    return $p
}

$backendProc  = Start-Hidden '"${uvExePs}" run python -m backend.main' '${repoPs}'
Start-Sleep 3
$frontendProc = Start-Hidden 'npm run dev' '${repoPs}\\frontend'
Start-Sleep 4
Start-Process 'http://localhost:5173'

# ── Tray icon ─────────────────────────────────────────────────────────────────
$trayApp  = New-Object System.Windows.Forms.ApplicationContext
$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.Text    = 'LLM Council Plus'
$notifyIcon.Visible = $true

# Load icon if available, else use a default
if (Test-Path '${iconPs}') {
    $notifyIcon.Icon = New-Object System.Drawing.Icon('${iconPs}')
} else {
    $notifyIcon.Icon = [System.Drawing.SystemIcons]::Application
}

# Context menu
$menu     = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = $menu.Items.Add('Open LLM Council Plus')
$sepItem  = $menu.Items.Add('-')
$quitItem = $menu.Items.Add('Quit')

$notifyIcon.ContextMenuStrip = $menu

# Double-click also opens browser
$notifyIcon.add_MouseDoubleClick({
    Start-Process 'http://localhost:5173'
})

$openItem.add_Click({
    Start-Process 'http://localhost:5173'
})

$quitItem.add_Click({
    # Kill backend (python / uv) and frontend (node / npm) processes
    @('python','uv','node','npm') | ForEach-Object {
        Get-Process -Name $_ -ErrorAction SilentlyContinue | Stop-Process -Force
    }
    $notifyIcon.Visible = $false
    $notifyIcon.Dispose()
    [System.Windows.Forms.Application]::Exit()
})

# Show balloon tip on first launch
$notifyIcon.BalloonTipTitle = 'LLM Council Plus'
$notifyIcon.BalloonTipText  = 'Running in background. Right-click tray icon to Open or Quit.'
$notifyIcon.BalloonTipIcon  = 'Info'
$notifyIcon.ShowBalloonTip(4000)

[System.Windows.Forms.Application]::Run($trayApp)
`.trimStart();

    fs.writeFileSync(trayPsPath, trayPsContent);

    // ── launch.vbs ────────────────────────────────────────────────────────────
    // Silently spawns the PowerShell tray controller — no window, no flash.
    const launcherContent = [
      'Set WshShell = CreateObject("WScript.Shell")',
      `WshShell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""${trayPsPath}""", 0, False`,
      'Set WshShell = Nothing',
    ].join('\r\n');

    fs.writeFileSync(launcherPath, launcherContent);
    send('Launcher script created ✅', 85);

    send('Creating desktop shortcut...', 90);
    const desktop = path.join(os.homedir(), 'Desktop');
    const shortcutPath = path.join(desktop, 'LLM Council Plus.lnk');

    // Clean up any leftover files from previous installs to avoid stale shortcuts
    const oldBat = path.join(repoPath, 'launch.bat');
    try { if (fs.existsSync(oldBat))      fs.unlinkSync(oldBat); }      catch (_) {}
    try { if (fs.existsSync(shortcutPath)) fs.unlinkSync(shortcutPath); } catch (_) {}

    // Copy icon.ico from the app bundle into the install folder.
    // In a packaged Electron app, icon.ico sits next to the .exe in the install dir,
    // not inside app.asar — so we check multiple candidate locations.
    const appIcon = path.join(repoPath, 'icon.ico');
    const iconCandidates = [
      path.join(process.resourcesPath, '..', 'icon.ico'),   // next to the .exe
      path.join(__dirname, 'icon.ico'),                       // dev mode (next to main.js)
      path.join(process.resourcesPath, 'icon.ico'),           // inside resources/
      path.join(process.resourcesPath, 'app', 'icon.ico'),    // inside resources/app/
    ];
    let iconCopied = false;
    for (const candidate of iconCandidates) {
      try {
        if (fs.existsSync(candidate)) {
          fs.copyFileSync(candidate, appIcon);
          iconCopied = true;
          break;
        }
      } catch (_) { /* try next */ }
    }
    // If none found in bundle, extract the icon from the running exe itself via PowerShell
    if (!iconCopied) {
      try {
        const exePath = process.execPath;
        const extractScript = `Add-Type -AssemblyName System.Drawing; $ico = [System.Drawing.Icon]::ExtractAssociatedIcon('${exePath}'); $ico.ToBitmap().Save('${appIcon}.png'); $stream = [System.IO.File]::OpenWrite('${appIcon}'); $ico.Save($stream); $stream.Close()`;
        await run(`powershell -NoProfile -Command "${extractScript}"`);
        iconCopied = fs.existsSync(appIcon);
      } catch (_) { /* best-effort */ }
    }

    // Point shortcut at wscript.exe with the .vbs as argument — fully silent, no console flash
    const iconArg = fs.existsSync(appIcon) ? `$s.IconLocation = '${appIcon},0'` : '';
    if (!fs.existsSync(appIcon)) send('⚠️ Icon not copied — shortcut will use default icon', 91);
    const shortcutScript = [
      `$ws = New-Object -ComObject WScript.Shell`,
      `$s = $ws.CreateShortcut('${shortcutPath}')`,
      `$s.TargetPath = 'wscript.exe'`,
      `$s.Arguments = '"${launcherPath}"'`,
      `$s.WorkingDirectory = '${repoPath}'`,
      `$s.Description = 'Launch LLM Council Plus'`,
      iconArg,
      `$s.Save()`
    ].filter(Boolean).join('; ');
    await run(`powershell -Command "${shortcutScript}"`);
    send('Desktop shortcut created ✅', 95);

    send('All done! 🎉', 100);
    event.sender.send('done');

  } catch (err) {
    event.sender.send('error', err.toString());
  }
});
