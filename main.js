const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 700,
    height: 580,
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

function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { shell: true }, (err, stdout, stderr) => {
      if (err) reject(stderr || err.message);
      else resolve(stdout.trim());
    });
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

// ─── PREREQ CHECKS ───────────────────────────────────────────────────────────

ipcMain.handle('check-prereq', async (e, name) => {
  try {
    let version = '';
    switch (name) {
      case 'git':    version = (await run('git --version')).split(' ')[2]; break;
      case 'node':   version = (await run('node --version')).replace('v', ''); break;
      case 'python': version = (await run('python --version')).replace('Python ', ''); break;
      case 'uv':     version = (await run('uv --version')).split(' ')[1]; break;
    }
    const ok = versionOk(version, MIN_VERSIONS[name]);
    return { found: true, ok, version, required: MIN_VERSIONS[name] };
  } catch {
    return { found: false, ok: false, version: null, required: MIN_VERSIONS[name] };
  }
});

ipcMain.handle('install-prereq', async (e, name) => {
  try {
    switch (name) {
      case 'git':
        await run('winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements');
        break;
      case 'node':
        await run('winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements');
        break;
      case 'python':
        await run('winget install --id Python.Python.3.10 -e --source winget --accept-package-agreements --accept-source-agreements');
        break;
      case 'uv':
        await run('powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"');
        break;
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.toString() };
  }
});

ipcMain.handle('update-prereq', async (e, name) => {
  try {
    switch (name) {
      case 'git':
        await run('winget upgrade --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements');
        break;
      case 'node':
        await run('winget upgrade --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements');
        break;
      case 'python':
        await run('winget upgrade --id Python.Python.3.10 -e --source winget --accept-package-agreements --accept-source-agreements');
        break;
      case 'uv':
        await run('uv self update');
        break;
    }
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
    const launcherPath = path.join(repoPath, 'launch.bat');
    const launcherContent = [
      '@echo off',
      `start "" cmd /k "cd /d "${repoPath}" && uv run python -m backend.main"`,
      'timeout /t 3 /nobreak > nul',
      `start "" cmd /k "cd /d "${repoPath}\\frontend" && npm run dev"`,
      'timeout /t 4 /nobreak > nul',
      'start "" http://localhost:5173'
    ].join('\r\n');
    fs.writeFileSync(launcherPath, launcherContent);
    send('Launcher script created ✅', 85);

    send('Creating desktop shortcut...', 90);
    const desktop = path.join(os.homedir(), 'Desktop');
    const shortcutPath = path.join(desktop, 'LLM Council Plus.lnk');
    const shortcutScript = `$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('${shortcutPath}'); $s.TargetPath = '${launcherPath}'; $s.Description = 'Launch LLM Council Plus'; $s.Save()`;
    await run(`powershell -Command "${shortcutScript}"`);
    send('Desktop shortcut created ✅', 95);

    send('All done! 🎉', 100);
    event.sender.send('done');

  } catch (err) {
    event.sender.send('error', err.toString());
  }
});