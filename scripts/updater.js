// 업데이터: 프로그램을 다시 설치하지 않고 최신 버전으로 교체한다.
//
// 두 가지 방식을 지원한다.
//  1) git 방식  - 이 폴더가 git 저장소로 받은 것이면 원격 브랜치를 fetch 해서 fast-forward 로 갱신한다.
//  2) 매니페스트 방식 - UPDATE_MANIFEST_URL 의 JSON({ version, url, notes })을 읽어
//     더 높은 버전이면 url 의 tar.gz 를 받아 덮어쓴다. data/ 와 .env 는 절대 건드리지 않는다.
//
// 명령줄: node scripts/updater.js [--check]
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RESTART_EXIT_CODE = 75;

const PRESERVE = new Set(['data', '.env', 'node_modules', '.git', '.update-tmp']);

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: 5 * 60 * 1000,
    ...opts,
  });
  return { ok: result.status === 0, out: (result.stdout || '').trim(), err: (result.stderr || '').trim() || result.error?.message || '' };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function localVersion() {
  return readJson(path.join(ROOT_DIR, 'package.json')).version;
}

export function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = String(b).split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

function dependencyFingerprint() {
  const hash = crypto.createHash('sha256');
  for (const f of ['package.json', 'package-lock.json']) {
    try {
      hash.update(fs.readFileSync(path.join(ROOT_DIR, f)));
    } catch {
      /* 파일이 없을 수 있다 */
    }
  }
  return hash.digest('hex');
}

export function ensureDependencies({ force = false, log = console.log } = {}) {
  const marker = path.join(ROOT_DIR, 'node_modules', '.rrh-deps');
  const fp = dependencyFingerprint();
  let installed = '';
  try {
    installed = fs.readFileSync(marker, 'utf8');
  } catch {
    /* 아직 설치 전 */
  }
  if (!force && installed === fp) return true;
  log('필요한 구성 요소를 설치하는 중입니다... (처음 한 번 또는 업데이트 후에만)');
  const r = run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund']);
  if (!r.ok) {
    log(`구성 요소 설치 실패: ${r.err}`);
    return false;
  }
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, fp);
  return true;
}

function gitMode() {
  if (process.env.UPDATE_MODE === 'manifest') return null;
  if (!fs.existsSync(path.join(ROOT_DIR, '.git'))) return null;
  const branch = process.env.UPDATE_BRANCH || run('git', ['rev-parse', '--abbrev-ref', 'HEAD']).out;
  if (!branch || branch === 'HEAD') return null;
  return { branch, remote: process.env.UPDATE_REMOTE || 'origin' };
}

async function fetchJson(url) {
  const headers = { 'User-Agent': 'review-reply-helper-updater', Accept: 'application/json' };
  if (process.env.UPDATE_TOKEN) headers.Authorization = `token ${process.env.UPDATE_TOKEN}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`업데이트 정보를 가져오지 못했습니다 (HTTP ${res.status})`);
  return res.json();
}

/** 최신 버전 정보를 확인한다. 실패해도 예외 대신 { error } 를 돌려준다. */
export async function checkForUpdate() {
  const current = localVersion();
  try {
    const git = gitMode();
    if (git) {
      const fetched = run('git', ['fetch', '--quiet', git.remote, git.branch]);
      if (!fetched.ok) throw new Error(`git fetch 실패: ${fetched.err}`);
      const ref = `${git.remote}/${git.branch}`;
      const behind = Number.parseInt(run('git', ['rev-list', '--count', `HEAD..${ref}`]).out, 10) || 0;
      let latest = current;
      try {
        latest = JSON.parse(run('git', ['show', `${ref}:package.json`]).out).version;
      } catch {
        /* 원격 package.json 을 못 읽어도 커밋 수로 판단 */
      }
      const notes = behind ? run('git', ['log', '--format=- %s', '-n', '10', `HEAD..${ref}`]).out : '';
      return { mode: 'git', current, latest, available: behind > 0, notes };
    }
    const manifestUrl = process.env.UPDATE_MANIFEST_URL;
    if (!manifestUrl) return { mode: 'none', current, latest: current, available: false, notes: '' };
    const manifest = await fetchJson(manifestUrl);
    return {
      mode: 'manifest',
      current,
      latest: manifest.version,
      available: compareVersions(manifest.version, current) > 0,
      notes: manifest.notes || '',
      url: manifest.url,
    };
  } catch (err) {
    return { mode: 'error', current, latest: current, available: false, notes: '', error: err.message };
  }
}

function copyTree(src, dest) {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (PRESERVE.has(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(to, { recursive: true });
      copyTree(from, to);
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

async function applyManifestUpdate(url, log) {
  const tmp = path.join(ROOT_DIR, '.update-tmp');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  try {
    const headers = { 'User-Agent': 'review-reply-helper-updater' };
    if (process.env.UPDATE_TOKEN) headers.Authorization = `token ${process.env.UPDATE_TOKEN}`;
    log('새 버전을 내려받는 중...');
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error(`내려받기 실패 (HTTP ${res.status})`);
    const archive = path.join(tmp, 'update.tar.gz');
    fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
    // Windows 10 이상, macOS, Linux 모두 tar 가 기본 설치되어 있다.
    const extracted = path.join(tmp, 'x');
    fs.mkdirSync(extracted);
    const r = run('tar', ['-xzf', archive, '-C', extracted], { shell: false });
    if (!r.ok) throw new Error(`압축 해제 실패: ${r.err}`);
    // GitHub 압축본은 최상위 폴더 하나로 감싸져 있다.
    const entries = fs.readdirSync(extracted, { withFileTypes: true });
    const base = entries.length === 1 && entries[0].isDirectory() ? path.join(extracted, entries[0].name) : extracted;
    if (!fs.existsSync(path.join(base, 'package.json'))) throw new Error('압축본에서 package.json 을 찾지 못했습니다.');
    copyTree(base, ROOT_DIR);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** 업데이트가 있으면 적용한다. 반환값 updated 가 true 면 프로그램을 다시 시작해야 한다. */
export async function applyUpdate({ log = console.log } = {}) {
  const info = await checkForUpdate();
  if (info.error) return { ...info, updated: false };
  if (!info.available) return { ...info, updated: false };
  if (info.mode === 'git') {
    const git = gitMode();
    const r = run('git', ['merge', '--ff-only', `${git.remote}/${git.branch}`]);
    if (!r.ok) {
      return { ...info, updated: false, error: `자동 업데이트를 적용할 수 없습니다 (폴더 안 파일을 직접 수정했다면 되돌려 주세요): ${r.err}` };
    }
  } else if (info.mode === 'manifest') {
    try {
      await applyManifestUpdate(info.url, log);
    } catch (err) {
      return { ...info, updated: false, error: err.message };
    }
  }
  if (!ensureDependencies({ log })) {
    return { ...info, updated: true, error: '업데이트는 받았지만 구성 요소 설치에 실패했습니다. 인터넷 연결을 확인하고 다시 실행해 주세요.' };
  }
  return { ...info, updated: true, current: localVersion() };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { loadConfig } = await import('../server/config.js'); // .env 를 읽어 UPDATE_* 설정을 반영
  loadConfig();
  if (process.argv.includes('--check')) {
    const info = await checkForUpdate();
    console.log(JSON.stringify(info, null, 2));
  } else {
    const result = await applyUpdate();
    if (result.error) console.log(`업데이트 실패: ${result.error}`);
    else if (result.updated) console.log(`업데이트 완료: ${result.latest} 버전`);
    else console.log(`이미 최신 버전입니다 (${result.current}).`);
  }
}
