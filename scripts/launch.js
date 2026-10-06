// 런처: 바탕화면 아이콘을 두 번 클릭하면 실행되는 진입점.
//
//   node scripts/launch.js            업데이트 확인 → 서버 실행(이미 실행 중이면 생략) → 앱 창 열기
//   node scripts/launch.js --install  구성 요소 설치 + 바탕화면/시작 메뉴 아이콘 만들기
//   node scripts/launch.js --stop     백그라운드 서버 끄기
//
// .env 에 APP_URL(클라우드 주소)을 적어 두면 서버를 띄우지 않고 그 주소를 앱 창으로 연다.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../server/config.js';
import { ROOT_DIR, applyUpdate, ensureDependencies, localVersion } from './updater.js';

const APP_NAME = '리뷰답글 도우미';
const config = loadConfig();
const localUrl = `http://localhost:${config.port}`;
const args = new Set(process.argv.slice(2));

function log(msg) {
  console.log(msg);
}

async function isServerUp(base) {
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

function exists(p) {
  try {
    return Boolean(p) && fs.existsSync(p);
  } catch {
    return false;
  }
}

function detachedSpawn(cmd, argv, opts = {}) {
  const child = spawn(cmd, argv, { detached: true, stdio: 'ignore', windowsHide: true, ...opts });
  child.on('error', () => {});
  child.unref();
}

/** 크롬/엣지가 있으면 주소창 없는 "앱 창"으로, 없으면 기본 브라우저로 연다. */
function openAppWindow(url) {
  const appArg = `--app=${url}`;
  if (process.platform === 'win32') {
    const candidates = [
      path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
      path.join(process.env.ProgramFiles || '', 'Microsoft/Edge/Application/msedge.exe'),
      path.join(process.env.ProgramFiles || '', 'Google/Chrome/Application/chrome.exe'),
      path.join(process.env['ProgramFiles(x86)'] || '', 'Google/Chrome/Application/chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    ];
    const browser = candidates.find(exists);
    if (browser) return detachedSpawn(browser, [appArg]);
    return detachedSpawn('cmd', ['/c', `start "" "${url}"`], { windowsVerbatimArguments: true });
  }
  if (process.platform === 'darwin') {
    for (const app of ['Google Chrome', 'Microsoft Edge']) {
      if (exists(`/Applications/${app}.app`)) return detachedSpawn('open', ['-na', app, '--args', appArg]);
    }
    return detachedSpawn('open', [url]);
  }
  for (const bin of ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge']) {
    if (spawnSync('which', [bin]).status === 0) return detachedSpawn(bin, [appArg]);
  }
  return detachedSpawn('xdg-open', [url]);
}

async function waitForServer(base, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await isServerUp(base)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

function readPid(name) {
  try {
    return Number.parseInt(fs.readFileSync(path.join(config.dataDir, name), 'utf8'), 10) || null;
  } catch {
    return null;
  }
}

function stopServer() {
  // 슈퍼바이저를 먼저 끄고(재시작 방지) 서버를 끈다.
  let stopped = false;
  for (const name of ['supervisor.pid', 'server.pid']) {
    const pid = readPid(name);
    if (!pid) continue;
    try {
      process.kill(pid);
      stopped = true;
    } catch {
      /* 이미 꺼져 있다 */
    }
    fs.rmSync(path.join(config.dataDir, name), { force: true });
  }
  log(stopped ? `${APP_NAME}를 종료했습니다.` : '실행 중인 서버가 없습니다.');
}

// ───────────── 바로가기(아이콘) 만들기 ─────────────
function installWindowsShortcut() {
  const target = path.join(ROOT_DIR, 'launcher', 'start-windows.bat');
  const icon = path.join(ROOT_DIR, 'public', 'icons', 'app.ico');
  const ps = `
$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject WScript.Shell
$name = '${APP_NAME}.lnk'
$places = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))
foreach ($dir in $places) {
  $lnk = $shell.CreateShortcut((Join-Path $dir $name))
  $lnk.TargetPath = '${target.replaceAll("'", "''")}'
  $lnk.WorkingDirectory = '${ROOT_DIR.replaceAll("'", "''")}'
  $lnk.IconLocation = '${icon.replaceAll("'", "''")},0'
  $lnk.WindowStyle = 7
  $lnk.Description = '${APP_NAME} 실행'
  $lnk.Save()
}
`;
  // 한글 경로가 깨지지 않도록 UTF-16LE Base64 로 넘긴다.
  const encoded = Buffer.from(ps, 'utf16le').toString('base64');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || '바로가기를 만들지 못했습니다.');
  return '바탕화면과 시작 메뉴';
}

function installMacApp() {
  const desktop = path.join(os.homedir(), 'Desktop');
  const appDir = path.join(desktop, `${APP_NAME}.app`);
  const macos = path.join(appDir, 'Contents', 'MacOS');
  const resources = path.join(appDir, 'Contents', 'Resources');
  fs.mkdirSync(macos, { recursive: true });
  fs.mkdirSync(resources, { recursive: true });
  const runner = path.join(macos, 'run');
  // 더블클릭으로 실행되는 앱은 셸 PATH 를 모르므로 node 의 절대 경로를 적어 둔다.
  fs.writeFileSync(
    runner,
    `#!/bin/sh\ncd "${ROOT_DIR}"\nexec "${process.execPath}" --disable-warning=ExperimentalWarning scripts/launch.js >> data/launcher.log 2>&1\n`,
  );
  fs.chmodSync(runner, 0o755);
  fs.writeFileSync(
    path.join(appDir, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key><string>kr.reviewreply.helper</string>
  <key>CFBundleVersion</key><string>${localVersion()}</string>
  <key>CFBundleExecutable</key><string>run</string>
  <key>CFBundleIconFile</key><string>app</string>
  <key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`,
  );
  // macOS 기본 도구(sips, iconutil)로 아이콘을 만든다. 실패해도 실행에는 지장 없다.
  const iconset = path.join(os.tmpdir(), 'rrh.iconset');
  fs.rmSync(iconset, { recursive: true, force: true });
  fs.mkdirSync(iconset);
  const src = path.join(ROOT_DIR, 'public', 'icons', 'icon-512.png');
  for (const size of [16, 32, 128, 256, 512]) {
    spawnSync('sips', ['-z', String(size), String(size), src, '--out', path.join(iconset, `icon_${size}x${size}.png`)]);
  }
  spawnSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(resources, 'app.icns')]);
  fs.rmSync(iconset, { recursive: true, force: true });
  return '바탕화면';
}

function installLinuxDesktopEntry() {
  const entry = `[Desktop Entry]
Type=Application
Name=${APP_NAME}
Comment=리뷰 답글 초안 자동 생성
Exec="${process.execPath}" --disable-warning=ExperimentalWarning "${path.join(ROOT_DIR, 'scripts', 'launch.js')}"
Path=${ROOT_DIR}
Icon=${path.join(ROOT_DIR, 'public', 'icons', 'icon-512.png')}
Terminal=false
Categories=Office;
`;
  const places = [path.join(os.homedir(), '.local', 'share', 'applications'), path.join(os.homedir(), 'Desktop')];
  for (const dir of places) {
    if (!exists(dir) && dir.endsWith('Desktop')) continue;
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'review-reply-helper.desktop');
    fs.writeFileSync(file, entry);
    fs.chmodSync(file, 0o755);
    spawnSync('gio', ['set', file, 'metadata::trusted', 'true']);
  }
  return '앱 메뉴와 바탕화면';
}

async function install() {
  log(`${APP_NAME} 설치를 시작합니다.`);
  if (!ensureDependencies({ log })) process.exit(1);
  fs.mkdirSync(config.dataDir, { recursive: true });
  const envFile = path.join(ROOT_DIR, '.env');
  if (!exists(envFile)) fs.copyFileSync(path.join(ROOT_DIR, '.env.example'), envFile);
  let where;
  if (process.platform === 'win32') where = installWindowsShortcut();
  else if (process.platform === 'darwin') where = installMacApp();
  else where = installLinuxDesktopEntry();
  log(`완료! ${where}에 "${APP_NAME}" 아이콘을 만들었습니다. 이제 아이콘을 두 번 클릭해 실행하세요.`);
  log('AI 답글을 쓰려면 .env 파일의 ANTHROPIC_API_KEY 에 API 키를 넣어 주세요. (없어도 기본 문장 엔진으로 동작합니다)');
}

async function launch() {
  const appUrl = (process.env.APP_URL || '').trim();
  if (appUrl) {
    // 클라우드 모드: 서버는 이미 인터넷에 있으므로 앱 창만 연다. 업데이트도 서버 쪽에서 자동 반영된다.
    openAppWindow(appUrl);
    return;
  }
  if (await isServerUp(localUrl)) {
    openAppWindow(localUrl);
    return;
  }
  if (process.env.UPDATE_ON_LAUNCH !== '0') {
    log('새 버전이 있는지 확인하는 중...');
    const result = await applyUpdate({ log });
    if (result.error) log(`(업데이트 확인 건너뜀: ${result.error})`);
    else if (result.updated) log(`새 버전 ${result.latest} 으로 업데이트했습니다.`);
  }
  if (!ensureDependencies({ log })) process.exit(1);
  log(`${APP_NAME}를 시작하는 중...`);
  detachedSpawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT_DIR, 'scripts', 'supervisor.js')], {
    cwd: ROOT_DIR,
  });
  if (!(await waitForServer(localUrl, 30000))) {
    log(`서버가 시작되지 않았습니다. ${path.join(config.dataDir, 'server.log')} 파일을 확인해 주세요.`);
    process.exit(1);
  }
  openAppWindow(localUrl);
}

try {
  if (args.has('--install')) await install();
  else if (args.has('--stop')) stopServer();
  else await launch();
} catch (err) {
  console.error(`오류: ${err.message}`);
  process.exit(1);
}
