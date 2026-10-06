// 슈퍼바이저: 서버를 백그라운드에서 띄우고, 앱 안에서 업데이트하면(종료 코드 75) 새 코드로 다시 띄운다.
// 예기치 않게 꺼지면 잠시 뒤 자동으로 다시 시작한다.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import '../server/config.js'; // .env 를 읽어 DATA_DIR 등 설정을 반영한다
import { RESTART_EXIT_CODE, ROOT_DIR } from './updater.js';

const dataDir = path.resolve(ROOT_DIR, process.env.DATA_DIR || 'data');
fs.mkdirSync(dataDir, { recursive: true });
const logFile = path.join(dataDir, 'server.log');
const pidFile = path.join(dataDir, 'supervisor.pid');

// 로그가 너무 커지지 않도록 1MB 를 넘으면 새로 시작한다.
try {
  if (fs.statSync(logFile).size > 1024 * 1024) fs.renameSync(logFile, `${logFile}.old`);
} catch {
  /* 로그 파일이 아직 없다 */
}

fs.writeFileSync(pidFile, String(process.pid));
const crashes = [];
let child = null;
let stopping = false;

function start() {
  const log = fs.openSync(logFile, 'a');
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT_DIR, 'server', 'index.js')], {
    cwd: ROOT_DIR,
    env: { ...process.env, RRH_SUPERVISED: '1' },
    stdio: ['ignore', log, log],
    windowsHide: true,
  });
  fs.closeSync(log);
  child.on('exit', (code) => {
    child = null;
    if (stopping) return finish();
    if (code === RESTART_EXIT_CODE) return start(); // 업데이트 적용 후 재시작
    if (code === 0) return finish();
    const t = Date.now();
    crashes.push(t);
    while (crashes.length && t - crashes[0] > 60000) crashes.shift();
    if (crashes.length > 5) {
      fs.appendFileSync(logFile, `[supervisor] 1분 안에 서버가 여러 번 종료되어 재시작을 멈춥니다.\n`);
      return finish();
    }
    setTimeout(start, 2000);
  });
}

function finish() {
  try {
    if (fs.readFileSync(pidFile, 'utf8') === String(process.pid)) fs.unlinkSync(pidFile);
  } catch {
    /* 이미 지워졌다 */
  }
  process.exit(0);
}

function stop() {
  stopping = true;
  if (child) child.kill('SIGTERM');
  else finish();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

start();
