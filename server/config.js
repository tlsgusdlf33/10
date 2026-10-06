// 설정 로더: 프로젝트 루트의 .env 파일과 환경변수를 읽어 하나의 설정 객체로 만든다.
// 외부 라이브러리 없이 동작하도록 단순한 KEY=VALUE 파서를 사용한다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadDotEnv(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // 실제 환경변수가 우선한다 (클라우드 배포 시 대시보드에서 설정한 값).
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv(path.join(ROOT_DIR, '.env'));

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));

function list(value) {
  return (value || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function int(value, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(overrides = {}) {
  const env = process.env;
  return {
    appName: pkg.productName || pkg.name,
    version: pkg.version,
    host: env.HOST || '0.0.0.0',
    port: int(env.PORT, 8787),
    dataDir: path.resolve(ROOT_DIR, env.DATA_DIR || 'data'),
    publicDir: path.join(ROOT_DIR, 'public'),
    // AI 설정: 키가 없으면 내장 문장 엔진으로 동작한다 (무료 체험/오프라인용).
    anthropicApiKey: env.ANTHROPIC_API_KEY || '',
    anthropicModel: env.ANTHROPIC_MODEL || 'claude-opus-5-5',
    anthropicEffort: env.ANTHROPIC_EFFORT ?? 'low',
    // 관리자 이메일 (쉼표 구분): 요금제 변경 등 관리자 화면 접근 권한.
    adminEmails: list(env.ADMIN_EMAILS),
    // 요금제
    trialDays: int(env.TRIAL_DAYS, 14),
    freeMonthlyLimit: int(env.FREE_MONTHLY_LIMIT, 10),
    proMonthlyLimit: int(env.PRO_MONTHLY_LIMIT, 2000),
    priceText: env.PRICE_TEXT || '월 9,900원',
    paymentUrl: env.PAYMENT_URL || '',
    // 업데이트 설정 (scripts/updater.js 와 공유)
    updateManifestUrl: env.UPDATE_MANIFEST_URL || '',
    // 다른 출처(예: 모바일 앱 번들)에서 API 를 부를 때 허용할 Origin 목록
    allowedOrigins: (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    // 프록시(Render, Fly.io 등) 뒤에서 실제 클라이언트 IP 를 쓰기 위한 설정
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
    // 슈퍼바이저 아래에서 실행 중이면 앱 안에서 업데이트 후 자동 재시작이 가능하다.
    supervised: env.RRH_SUPERVISED === '1',
    ...overrides,
  };
}
