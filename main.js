const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

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
app.on('window-all-closed', () => { if (!isMac) app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

function run(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    exec(cmd, { shell: true, ...opts }, (err, stdout, stderr) => {
      if (err) reject(stderr || err.message);
      else resolve(stdout.trim());
    });
  });
}

function runStreaming(cmd, event, logChannel) {
  return new Promise((resolve, reject) => {
    const child = isWin
      ? spawn('cmd.exe', ['/c', cmd], { shell: false })
      : spawn('/bin/bash', ['-c', cmd], { shell: false });
    child.stdout.on('data', (d) =>
      d.toString().split(/\r?\n/).filter(l => l.trim())
        .forEach(line => event.sender.send(logChannel, line)));
    child.stderr.on('data', (d) =>
      d.toString().split(/\r?\n/).filter(l => l.trim())
        .forEach(line => event.sender.send(logChannel, line)));
    child.on('close', (code) => code === 0 ? resolve() : reject(`Exit code ${code}`));
    child.on('error', reject);
  });
}

function runStreamingPowerShell(psScript, event, logChannel) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'ByPass', '-Command', psScript],
      { shell: false });
    child.stdout.on('data', (d) =>
      d.toString().split(/\r?\n/).filter(l => l.trim())
        .forEach(line => event.sender.send(logChannel, line)));
    child.stderr.on('data', (d) =>
      d.toString().split(/\r?\n/).filter(l => l.trim())
        .forEach(line => event.sender.send(logChannel, line)));
    child.on('close', (code) => code === 0 ? resolve() : reject(`PS exit ${code}`));
    child.on('error', reject);
  });
}

async function refreshPath() {
  if (isWin) {
    try {
      const u = await run('powershell -NoProfile -Command "[System.Environment]::GetEnvironmentVariable(\'Path\',\'User\')"');
      const m = await run('powershell -NoProfile -Command "[System.Environment]::GetEnvironmentVariable(\'Path\',\'Machine\')"');
      process.env.PATH = [m, u, process.env.PATH].filter(Boolean).join(';');
    } catch (_) {}
    for (const dir of [
      path.join(os.homedir(), '.local', 'bin'),
      path.join(os.homedir(), '.cargo', 'bin'),
      path.join(os.homedir(), 'AppData', 'Local', 'uv', 'bin'),
      path.join(os.homedir(), 'AppData', 'Roaming', 'uv', 'bin'),
    ]) { if (!process.env.PATH.includes(dir)) process.env.PATH = dir + ';' + process.env.PATH; }
  } else {
    // Always prepend known Mac locations — covers both Intel and Apple Silicon
    for (const dir of [
      '/usr/local/bin',
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      '/opt/homebrew/opt/node@18/bin',
      '/opt/homebrew/opt/python@3.10/bin',
      '/usr/local/opt/node@18/bin',
      '/usr/local/opt/python@3.10/bin',
      '/usr/bin',
      '/bin',
      path.join(os.homedir(), '.local', 'bin'),
      path.join(os.homedir(), '.cargo', 'bin'),
    ]) { if (!process.env.PATH.includes(dir)) process.env.PATH = dir + ':' + process.env.PATH; }

    // Also source brew shellenv if brew exists — sets HOMEBREW_PREFIX etc.
    try {
      const brewPath = fs.existsSync('/opt/homebrew/bin/brew')
        ? '/opt/homebrew/bin/brew'
        : '/usr/local/bin/brew';
      if (fs.existsSync(brewPath)) {
        const brewEnv = await run(`"${brewPath}" shellenv`);
        // Parse export statements and apply to process.env
        brewEnv.split('\n').forEach(line => {
          const m = line.match(/^export\s+(\w+)="?([^"]*)"?/);
          if (m) process.env[m[1]] = m[2];
        });
      }
    } catch (_) {}
  }
}

async function findUvPath() {
  const candidates = isWin ? [
    path.join(os.homedir(), '.local', 'bin', 'uv.exe'),
    path.join(os.homedir(), '.cargo', 'bin', 'uv.exe'),
    path.join(os.homedir(), 'AppData', 'Local', 'uv', 'bin', 'uv.exe'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'uv', 'bin', 'uv.exe'),
  ] : [
    path.join(os.homedir(), '.local', 'bin', 'uv'),
    path.join(os.homedir(), '.cargo', 'bin', 'uv'),
    '/usr/local/bin/uv', '/opt/homebrew/bin/uv',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

async function ensureHomebrew(event) {
  // Check both Apple Silicon (/opt/homebrew) and Intel (/usr/local) locations
  const brewLocations = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'];
  for (const b of brewLocations) {
    if (fs.existsSync(b)) {
      const brewDir = path.dirname(b);
      if (!process.env.PATH.includes(brewDir))
        process.env.PATH = brewDir + ':' + process.env.PATH;
      return b;
    }
  }
  // Homebrew not found — cannot install from GUI (requires TTY/sudo)
  // Throw a user-friendly error
  throw new Error(
    'Homebrew is required but not installed.\n\n' +
    'Please open Terminal and run:\n' +
    '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"\n\n' +
    'Then reopen this installer.'
  );
}

function versionOk(current, required) {
  const parse = v => v.replace(/[^0-9.]/g, '').split('.').map(Number);
  const c = parse(current), r = parse(required);
  for (let i = 0; i < Math.max(c.length, r.length); i++) {
    const a = c[i]||0, b = r[i]||0;
    if (a > b) return true; if (a < b) return false;
  }
  return true;
}

const MIN_VERSIONS = {
  git:      isMac ? '2.30' : '2.40',
  node:     '18.0',
  python:   '3.10',
  uv:       '0.5',
  homebrew: '3.0',  // Mac only
};

ipcMain.handle('check-prereq', async (e, name) => {
  await refreshPath();
  try {
    let version = '';
    switch (name) {
      case 'git':
        version = (await run('git --version')).split(' ')[2];
        break;
      case 'node':
        if (isMac) {
          // Try PATH first, then brew-specific locations
          try { version = (await run('node --version')).replace('v',''); }
          catch {
            for (const p of [
              '/opt/homebrew/opt/node@18/bin/node',
              '/opt/homebrew/bin/node',
              '/usr/local/opt/node@18/bin/node',
              '/usr/local/bin/node',
            ]) {
              if (fs.existsSync(p)) { version = (await run(`"${p}" --version`)).replace('v',''); break; }
            }
          }
        } else {
          version = (await run('node --version')).replace('v','');
        }
        break;
      case 'python':
        if (isMac) {
          // Try python3.10 specifically first (brew installs it as python3.10)
          // then fall back to python3/python
          try { version = (await run('python3.10 --version')).replace('Python ',''); }
          catch {
            try {
              // Check brew-installed python3.10 by absolute path
              for (const p of [
                '/opt/homebrew/opt/python@3.10/bin/python3.10',
                '/opt/homebrew/bin/python3.10',
                '/usr/local/opt/python@3.10/bin/python3.10',
                '/usr/local/bin/python3.10',
              ]) {
                if (fs.existsSync(p)) { version = (await run(`"${p}" --version`)).replace('Python ',''); break; }
              }
            } catch {}
            if (!version) {
              try { version = (await run('python3 --version')).replace('Python ',''); } catch {}
            }
          }
        } else {
          try { version = (await run('python3 --version')).replace('Python ',''); }
          catch { version = (await run('python --version')).replace('Python ',''); }
        }
        break;
      case 'uv': {
        let uvCmd = 'uv';
        try { await run('uv --version'); }
        catch { const p = await findUvPath(); if (p) uvCmd=`"${p}"`; else throw new Error('not found'); }
        version = (await run(`${uvCmd} --version`)).split(' ')[1];
        break;
      }
      case 'homebrew': {
        // Mac only
        const brewLocations = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'];
        let brewPath = null;
        for (const b of brewLocations) if (fs.existsSync(b)) { brewPath = b; break; }
        if (!brewPath) throw new Error('Homebrew not found');
        version = (await run(`"${brewPath}" --version`)).split(' ')[1].replace(',','');
        break;
      }
    }
    if (!version) throw new Error('version empty');
    const ok = versionOk(version, MIN_VERSIONS[name]);
    return { found: true, ok, version, required: MIN_VERSIONS[name] };
  } catch { return { found: false, ok: false, version: null, required: MIN_VERSIONS[name] }; }
});

ipcMain.handle('install-prereq', async (e, name) => {
  try {
    if (isWin) {
      if (name === 'git')    await runStreaming('winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements', e, 'prereq-log');
      if (name === 'node')   await runStreaming('winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements', e, 'prereq-log');
      if (name === 'python') await runStreaming('winget install --id Python.Python.3.10 -e --source winget --accept-package-agreements --accept-source-agreements', e, 'prereq-log');
      if (name === 'uv')     await runStreamingPowerShell('irm https://astral.sh/uv/install.ps1 | iex', e, 'prereq-log');
    } else {
      if (name === 'git')    { const b = await ensureHomebrew(e); await runStreaming(`"${b}" install git`, e, 'prereq-log'); }
      if (name === 'node')   { const b = await ensureHomebrew(e); await runStreaming(`"${b}" install node@18 && "${b}" link node@18 --force --overwrite`, e, 'prereq-log'); }
      if (name === 'python') { const b = await ensureHomebrew(e); await runStreaming(`"${b}" install python@3.10`, e, 'prereq-log'); }
      if (name === 'uv')     await runStreaming('curl -LsSf https://astral.sh/uv/install.sh | sh', e, 'prereq-log');
    }
    await refreshPath();
    return { ok: true };
  } catch (err) { return { ok: false, error: err.toString() }; }
});

ipcMain.handle('update-prereq', async (e, name) => {
  try {
    if (isWin) {
      if (name === 'git')    await runStreaming('winget upgrade --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements', e, 'prereq-log');
      if (name === 'node')   await runStreaming('winget upgrade --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements', e, 'prereq-log');
      if (name === 'python') await runStreaming('winget upgrade --id Python.Python.3.10 -e --source winget --accept-package-agreements --accept-source-agreements', e, 'prereq-log');
      if (name === 'uv') {
        let uvCmd = 'uv';
        const p = await findUvPath(); if (p) uvCmd = `"${p}"`;
        await runStreaming(`${uvCmd} self update`, e, 'prereq-log');
      }
    } else {
      if (name === 'git')    { const b = await ensureHomebrew(e); await runStreaming(`"${b}" upgrade git`, e, 'prereq-log'); }
      if (name === 'node')   { const b = await ensureHomebrew(e); await runStreaming(`"${b}" upgrade node@18`, e, 'prereq-log'); }
      if (name === 'python') { const b = await ensureHomebrew(e); await runStreaming(`"${b}" upgrade python@3.10`, e, 'prereq-log'); }
      if (name === 'uv')     await runStreaming('uv self update', e, 'prereq-log');
    }
    await refreshPath();
    return { ok: true };
  } catch (err) { return { ok: false, error: err.toString() }; }
});

// ─── MAIN INSTALL ─────────────────────────────────────────────────────────────

ipcMain.on('start-install', async (event, { installDir }) => {
  const send = (msg, pct) => event.sender.send('progress', { msg, pct });
  try {
    const repoPath = path.join(installDir, 'llm-council-plus');
    const uvExeResolved = await findUvPath() || 'uv';
    const frontendPath = isMac ? `${repoPath}/frontend` : `${repoPath}\\frontend`;

    send('Cloning LLM Council Plus repository...', 10);
    if (fs.existsSync(repoPath)) {
      send('Folder already exists, skipping clone ✅', 20);
    } else {
      await run(`git clone https://github.com/jacob-bd/llm-council-plus.git "${repoPath}"`);
      send('Repository cloned ✅', 20);
    }

    send('Installing backend dependencies...', 30);
    await run(`cd "${repoPath}" && "${uvExeResolved}" sync`);
    send('Backend dependencies ready ✅', 55);

    send('Installing frontend dependencies...', 60);
    await run(`cd "${frontendPath}" && npm install`);
    send('Frontend dependencies ready ✅', 75);

    send('Creating launcher...', 80);
    if (isWin) {
      await createWindowsLauncher(repoPath, uvExeResolved, send);
    } else {
      await createMacLauncher(repoPath, uvExeResolved, send);
    }

    send('All done! 🎉', 100);
    event.sender.send('done');
  } catch (err) { event.sender.send('error', err.toString()); }
});

// ─── WINDOWS LAUNCHER ─────────────────────────────────────────────────────────

async function createWindowsLauncher(repoPath, uvExeResolved, send) {
  const launcherPath = path.join(repoPath, 'launch.vbs');
  const trayPsPath   = path.join(repoPath, 'tray.ps1');
  const iconPs       = path.join(repoPath, 'icon.ico');

  const trayPsContent = `# LLM Council Plus — Tray Controller
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$userPath = [System.Environment]::GetEnvironmentVariable('PATH','User')
$sysPath  = [System.Environment]::GetEnvironmentVariable('PATH','Machine')
$extra    = "$env:USERPROFILE\\.local\\bin;$env:USERPROFILE\\.cargo\\bin"
$env:PATH = "$extra;$sysPath;$userPath;$env:PATH"
function Start-Hidden($cmd, $workDir) {
    $si = New-Object System.Diagnostics.ProcessStartInfo
    $si.FileName = 'cmd.exe'; $si.Arguments = "/c $cmd"
    $si.WorkingDirectory = $workDir
    $si.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $si.CreateNoWindow = $true; $si.UseShellExecute = $false
    return [System.Diagnostics.Process]::Start($si)
}
$backendProc  = Start-Hidden '"${uvExeResolved}" run python -m backend.main' '${repoPath}'
Start-Sleep 3
$frontendProc = Start-Hidden 'npm run dev' '${repoPath}\\frontend'
Start-Sleep 4
Start-Process 'http://localhost:5173'
$trayApp = New-Object System.Windows.Forms.ApplicationContext
$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.Text = 'LLM Council Plus'; $notifyIcon.Visible = $true
if (Test-Path '${iconPs}') { $notifyIcon.Icon = New-Object System.Drawing.Icon('${iconPs}') }
else { $notifyIcon.Icon = [System.Drawing.SystemIcons]::Application }
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = $menu.Items.Add('Open LLM Council Plus')
$sep = $menu.Items.Add('-')
$quitItem = $menu.Items.Add('Quit')
$notifyIcon.ContextMenuStrip = $menu
$notifyIcon.add_MouseDoubleClick({ Start-Process 'http://localhost:5173' })
$openItem.add_Click({ Start-Process 'http://localhost:5173' })
$quitItem.add_Click({
    @('python','uv','node','npm') | ForEach-Object { Get-Process -Name $_ -ErrorAction SilentlyContinue | Stop-Process -Force }
    $notifyIcon.Visible = $false; $notifyIcon.Dispose()
    [System.Windows.Forms.Application]::Exit()
})
$notifyIcon.BalloonTipTitle = 'LLM Council Plus'
$notifyIcon.BalloonTipText = 'Running in background. Right-click tray icon to Open or Quit.'
$notifyIcon.BalloonTipIcon = 'Info'; $notifyIcon.ShowBalloonTip(4000)
[System.Windows.Forms.Application]::Run($trayApp)`;

  fs.writeFileSync(trayPsPath, trayPsContent);
  fs.writeFileSync(launcherPath, [
    'Set WshShell = CreateObject("WScript.Shell")',
    `WshShell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""${trayPsPath}""", 0, False`,
    'Set WshShell = Nothing',
  ].join('\r\n'));
  send('Launcher script created ✅', 85);

  send('Creating desktop shortcut...', 90);
  const desktop      = path.join(os.homedir(), 'Desktop');
  const shortcutPath = path.join(desktop, 'LLM Council Plus.lnk');
  const oldBat       = path.join(repoPath, 'launch.bat');
  try { if (fs.existsSync(oldBat))       fs.unlinkSync(oldBat); }       catch (_) {}
  try { if (fs.existsSync(shortcutPath)) fs.unlinkSync(shortcutPath); } catch (_) {}

  const appIcon = path.join(repoPath, 'icon.ico');
  const iconCandidates = [
    path.join(process.resourcesPath, '..', 'icon.ico'),
    path.join(__dirname, 'icon.ico'),
    path.join(process.resourcesPath, 'icon.ico'),
    path.join(process.resourcesPath, 'app', 'icon.ico'),
  ];
  let iconCopied = false;
  for (const c of iconCandidates) {
    try { if (fs.existsSync(c)) { fs.copyFileSync(c, appIcon); iconCopied = true; break; } } catch (_) {}
  }
  if (!iconCopied) {
    try {
      const script = `Add-Type -AssemblyName System.Drawing; $ico = [System.Drawing.Icon]::ExtractAssociatedIcon('${process.execPath}'); $s = [System.IO.File]::OpenWrite('${appIcon}'); $ico.Save($s); $s.Close()`;
      await run(`powershell -NoProfile -Command "${script}"`);
    } catch (_) {}
  }

  const iconArg = fs.existsSync(appIcon) ? `$s.IconLocation = '${appIcon},0'` : '';
  const shortcutScript = [
    `$ws = New-Object -ComObject WScript.Shell`,
    `$s = $ws.CreateShortcut('${shortcutPath}')`,
    `$s.TargetPath = 'wscript.exe'`,
    `$s.Arguments = '"${launcherPath}"'`,
    `$s.WorkingDirectory = '${repoPath}'`,
    `$s.Description = 'Launch LLM Council Plus'`,
    iconArg, `$s.Save()`
  ].filter(Boolean).join('; ');
  await run(`powershell -Command "${shortcutScript}"`);
  send('Desktop shortcut created ✅', 95);
}

// ─── MAC LAUNCHER ─────────────────────────────────────────────────────────────

async function createMacLauncher(repoPath, uvExeResolved, send) {
  const launchShPath  = path.join(repoPath, 'launch.sh');
  const appBundlePath = path.join(repoPath, 'LLM Council Plus.app');
  const appMacOSDir   = path.join(appBundlePath, 'Contents', 'MacOS');
  const appResDir     = path.join(appBundlePath, 'Contents', 'Resources');
  const execPath      = path.join(appMacOSDir, 'launch');

  const extraPaths = [
    '/usr/local/bin', '/opt/homebrew/bin', '/opt/homebrew/sbin',
    path.join(os.homedir(), '.local', 'bin'),
    path.join(os.homedir(), '.cargo', 'bin'),
  ].join(':');

  // launch.sh — runs backend + frontend in background
  fs.writeFileSync(launchShPath, [
    '#!/bin/bash',
    `export PATH="${extraPaths}:$PATH"`,
    `cd "${repoPath}"`,
    `"${uvExeResolved}" run python -m backend.main &`,
    'BACKEND_PID=$!',
    'sleep 3',
    `cd "${repoPath}/frontend"`,
    'npm run dev &',
    'FRONTEND_PID=$!',
    'sleep 4',
    'open http://localhost:5173',
    'wait $BACKEND_PID $FRONTEND_PID',
  ].join('\n'));
  await run(`chmod +x "${launchShPath}"`);
  send('Launch script created ✅', 83);

  // .app bundle
  fs.mkdirSync(appMacOSDir, { recursive: true });
  fs.mkdirSync(appResDir,   { recursive: true });

  fs.writeFileSync(execPath, ['#!/bin/bash', `exec "${launchShPath}"`].join('\n'));
  await run(`chmod +x "${execPath}"`);

  fs.writeFileSync(path.join(appBundlePath, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>LLM Council Plus</string>
  <key>CFBundleDisplayName</key><string>LLM Council Plus</string>
  <key>CFBundleIdentifier</key><string>com.llmcouncil.app</string>
  <key>CFBundleVersion</key><string>1.0.0</string>
  <key>CFBundleExecutable</key><string>launch</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
</dict></plist>`);

  // Copy icon.png into bundle
  for (const c of [
    path.join(process.resourcesPath, '..', 'icon.png'),
    path.join(__dirname, 'icon.png'),
    path.join(process.resourcesPath, 'icon.png'),
  ]) {
    try { if (fs.existsSync(c)) { fs.copyFileSync(c, path.join(appResDir, 'AppIcon.png')); break; } }
    catch (_) {}
  }
  send('App bundle created ✅', 87);

  // Install to Applications + Desktop
  send('Installing to Applications folder...', 90);
  const appsTarget   = '/Applications/LLM Council Plus.app';
  const desktopTarget = path.join(os.homedir(), 'Desktop', 'LLM Council Plus.app');
  try { await run(`rm -rf "${appsTarget}"`);   } catch (_) {}
  try { await run(`rm -rf "${desktopTarget}"`); } catch (_) {}
  try { await run(`cp -r "${appBundlePath}" "${appsTarget}"`);   } catch (_) {}
  try { await run(`cp -r "${appBundlePath}" "${desktopTarget}"`); } catch (_) {}
  send('Added to Applications & Desktop ✅', 95);
}
