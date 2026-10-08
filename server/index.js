// 리뷰답글 도우미 서버: API, 실시간 동기화(SSE), 웹앱(PWA) 파일, 예약 작업(정기결제·리뷰 수집·보관 기간 정리)을
// 한 프로세스에서 제공한다. 외부 웹 프레임워크 없이 node:http 만 사용한다.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { openDatabase, now, currentMonth } from './db.js';
import {
  authenticate,
  createSession,
  deleteSession,
  hashPassword,
  normalizeEmail,
  sessionIdOf,
  validateCredentials,
  verifyPassword,
} from './auth.js';
import { createGenerator } from './ai.js';
import { PLATFORMS, platformName, reportGuide } from './platforms.js';
import { applySafety, checkReply, maskPII } from './safety.js';
import { createBilling } from './billing.js';
import { createGoogle } from './google.js';
import { MINUTES_SAVED_PER_REPLY, buildMonthlyReport, buildPilotMetrics, measureEdit } from './report.js';
import { createSealer, loadSecretKey } from './secrets.js';
import { RESTART_EXIT_CODE, applyUpdate, checkForUpdate } from '../scripts/updater.js';

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const HANDLED = Symbol('handled'); // 라우트가 응답을 직접 보냈음을 뜻한다 (리다이렉트 등)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};
const APP_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
// 카드 등록 화면에서만 토스페이먼츠 결제창 스크립트를 허용한다.
const BILLING_CSP =
  "default-src 'self'; script-src 'self' https://js.tosspayments.com; style-src 'self' 'unsafe-inline' https://*.tosspayments.com; img-src 'self' data: https:; connect-src 'self' https://*.tosspayments.com; frame-src https://*.tosspayments.com https://*.toss.im; frame-ancestors 'none'; base-uri 'none'";

const STATUSES = ['draft', 'approved', 'posted', 'skipped'];
const STORE_FIELDS = {
  name: 60,
  category: 40,
  owner_title: 20,
  signature_menus: 200,
  tone: 20,
  emoji: 10,
  greeting: 120,
  signature: 120,
  sample_replies: 2000,
  avoid_words: 300,
  notes: 500,
};
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

// ───────────────────────── 실시간 동기화 허브 ─────────────────────────
// 같은 계정으로 접속한 모든 기기(PC 브라우저, 휴대폰 앱)에 "데이터가 바뀌었다"는 신호를 보낸다.
function createSyncHub() {
  const clients = new Map(); // userId -> Set<res>
  return {
    add(userId, res) {
      if (!clients.has(userId)) clients.set(userId, new Set());
      clients.get(userId).add(res);
    },
    remove(userId, res) {
      const set = clients.get(userId);
      if (!set) return;
      set.delete(res);
      if (!set.size) clients.delete(userId);
    },
    publish(userId, payload) {
      const set = clients.get(userId);
      if (!set) return;
      const data = `event: change\ndata: ${JSON.stringify(payload)}\n\n`;
      for (const res of set) res.write(data);
    },
    count(userId) {
      return clients.get(userId)?.size || 0;
    },
    heartbeat() {
      for (const set of clients.values()) for (const res of set) res.write(': ping\n\n');
    },
    closeAll() {
      for (const set of clients.values()) for (const res of set) res.end();
      clients.clear();
    },
  };
}

function createRateLimiter(limit, windowMs) {
  const hits = new Map();
  return (key) => {
    const t = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.reset < t) {
      hits.set(key, { count: 1, reset: t + windowMs });
      if (hits.size > 10000) for (const [k, v] of hits) if (v.reset < t) hits.delete(k);
      return true;
    }
    entry.count += 1;
    return entry.count <= limit;
  };
}

function lanAddresses(port) {
  const urls = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const addr of list || []) {
      if (addr.family === 'IPv4' && !addr.internal) urls.push(`http://${addr.address}:${port}`);
    }
  }
  return urls;
}

export function createApp(overrides = {}) {
  const config = loadConfig(overrides);
  const db = openDatabase(config.dataDir);
  const generator = overrides.generator || createGenerator(config);
  const sealer = createSealer(loadSecretKey(config.dataDir, config.secretKey));
  const hub = createSyncHub();
  const authLimiter = createRateLimiter(20, 10 * 60 * 1000);
  const generateLimiter = createRateLimiter(30, 60 * 1000);
  const extractLimiter = createRateLimiter(20, 10 * 60 * 1000);
  let updateCache = null;

  // ───────────── 도우미 함수 ─────────────
  function send(res, status, body, headers = {}) {
    const json = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store', ...headers });
    res.end(json);
  }

  function redirect(res, location) {
    res.writeHead(303, { Location: location, 'Cache-Control': 'no-store' });
    res.end();
    return HANDLED;
  }

  async function readBody(req, limit = 100 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw new HttpError(413, '요청 내용이 너무 큽니다.');
      chunks.push(chunk);
    }
    if (!size) return {};
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      return parsed;
    } catch {
      throw new HttpError(400, '요청 형식이 올바르지 않습니다.');
    }
  }

  function clientIp(req) {
    if (config.trustProxy) {
      const fwd = req.headers['x-forwarded-for'];
      if (fwd) return String(fwd).split(',')[0].trim();
    }
    return req.socket.remoteAddress || '';
  }

  function originOf(req) {
    if (config.publicUrl) return config.publicUrl;
    const proto = (config.trustProxy && String(req.headers['x-forwarded-proto'] || '').split(',')[0]) || (req.socket.encrypted ? 'https' : 'http');
    return `${proto}://${req.headers.host}`;
  }

  function bearer(req) {
    const h = req.headers.authorization || '';
    return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  }

  function requireUser(req) {
    const user = authenticate(db, bearer(req));
    if (!user) throw new HttpError(401, '로그인이 필요합니다.');
    return user;
  }

  function userById(id) {
    const u = db.prepare('SELECT id, email, plan, plan_until, created_at FROM users WHERE id = ?').get(id);
    return u && { id: u.id, email: u.email, plan: u.plan, planUntil: u.plan_until, createdAt: u.created_at };
  }

  function isAdmin(user) {
    if (config.adminEmails.length) return config.adminEmails.includes(user.email);
    // 관리자 이메일을 정하지 않은 개인 설치본에서는 첫 번째로 가입한 계정이 관리자다.
    const first = db.prepare('SELECT MIN(id) AS id FROM users').get();
    return first.id === user.id;
  }

  function requireAdmin(req) {
    const user = requireUser(req);
    if (!isAdmin(user)) throw new HttpError(403, '관리자만 사용할 수 있습니다.');
    return user;
  }

  function planOf(user) {
    const t = Date.now();
    const used = db.prepare('SELECT generations FROM usage WHERE user_id = ? AND month = ?').get(user.id, currentMonth())?.generations || 0;
    let plan = 'free';
    let until = null;
    if (user.plan === 'pro' && (!user.planUntil || Date.parse(user.planUntil) > t)) {
      plan = 'pro';
      until = user.planUntil;
    } else {
      const trialEnd = Date.parse(user.createdAt) + config.trialDays * 86400000;
      if (trialEnd > t && user.plan !== 'free') {
        plan = 'trial';
        until = new Date(trialEnd).toISOString();
      }
    }
    const limit = plan === 'free' ? config.freeMonthlyLimit : config.proMonthlyLimit;
    const labels = { pro: '프로', trial: '무료 체험', free: '무료' };
    return { plan, label: labels[plan], until, limit, used, remaining: Math.max(0, limit - used) };
  }

  function getStore(userId) {
    let store = db.prepare('SELECT * FROM stores WHERE user_id = ?').get(userId);
    if (!store) {
      db.prepare('INSERT INTO stores (user_id, updated_at) VALUES (?, ?)').run(userId, now());
      store = db.prepare('SELECT * FROM stores WHERE user_id = ?').get(userId);
    }
    const { user_id: _ignored, ...rest } = store;
    return rest;
  }

  function metaOf(row) {
    try {
      return JSON.parse(row.drafts || '{}');
    } catch {
      return {};
    }
  }

  function reviewOut(row, store) {
    const meta = metaOf(row);
    return {
      id: row.id,
      platform: row.platform,
      platformName: platformName(row.platform),
      rating: row.rating,
      author: row.author,
      menu: row.menu,
      content: row.content,
      status: row.status,
      source: row.source,
      canPublish: row.source === 'google' && Boolean(row.external_id),
      publishError: row.publish_error,
      sentiment: row.sentiment,
      isMalicious: Boolean(row.is_malicious),
      maliciousReason: row.malicious_reason,
      keyPoints: meta.keyPoints || [],
      drafts: meta.drafts || [],
      calmReply: row.calm_reply,
      calmWarnings: meta.calmWarnings || [],
      guidance: row.guidance,
      finalReply: row.final_reply,
      finalWarnings: store && row.final_reply ? checkReply(row.final_reply, store).warnings : [],
      editRate: row.edit_rate,
      engine: row.engine,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      approvedAt: row.approved_at,
      postedAt: row.posted_at,
    };
  }

  function getReview(userId, id) {
    const row = db.prepare('SELECT * FROM reviews WHERE id = ? AND user_id = ?').get(id, userId);
    if (!row) throw new HttpError(404, '리뷰를 찾을 수 없습니다.');
    return row;
  }

  function str(value, max, field) {
    const s = typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
    if (s.length > max) throw new HttpError(400, `${field}은(는) ${max}자 이내로 입력해 주세요.`);
    return s;
  }

  function parseReviewInput(body) {
    const platform = PLATFORMS[body.platform] ? body.platform : null;
    if (!platform) throw new HttpError(400, '플랫폼을 선택해 주세요.');
    const rating = Number(body.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new HttpError(400, '별점은 1~5 사이로 선택해 주세요.');
    const content = str(body.content, 3000, '리뷰 내용');
    if (!content) throw new HttpError(400, '리뷰 내용을 붙여넣어 주세요.');
    return {
      platform,
      rating,
      content,
      author: str(body.author, 50, '닉네임'),
      menu: str(body.menu, 100, '메뉴'),
      source: body.source === 'image' ? 'image' : 'paste',
    };
  }

  /** 사장님이 승인한 과거 답글 중 별점이 비슷한 것을 골라 말투 예시로 쓴다. */
  function approvedExamples(userId, rating, excludeId = 0) {
    const rows = db
      .prepare(
        `SELECT rating, content, final_reply, approved_at FROM reviews
         WHERE user_id = ? AND id != ? AND status IN ('approved', 'posted') AND final_reply != '' AND is_malicious = 0
         ORDER BY approved_at DESC LIMIT 40`,
      )
      .all(userId, excludeId);
    return rows
      .map((r, i) => ({ r, score: Math.abs(r.rating - rating) * 10 + i }))
      .sort((a, b) => a.score - b.score)
      .slice(0, 4)
      .map(({ r }) => ({ rating: r.rating, content: r.content.slice(0, 400), reply: r.final_reply }));
  }

  /** 답글 초안을 만든다. soft=true 이면 사용량 초과 시 예외 대신 null 을 돌려준다(자동 수집용). */
  async function runGeneration(user, review, { soft = false, excludeId = 0 } = {}) {
    const plan = planOf(user);
    if (plan.remaining <= 0) {
      if (soft) return null;
      throw new HttpError(
        402,
        plan.plan === 'free'
          ? `이번 달 무료 사용량(${plan.limit}회)을 모두 사용했어요. 프로 요금제(${config.priceText})로 계속 이용할 수 있어요.`
          : '이번 달 사용량을 모두 사용했어요. 관리자에게 문의해 주세요.',
      );
    }
    if (!soft && !generateLimiter(`u${user.id}`)) throw new HttpError(429, '잠시 후 다시 시도해 주세요.');
    const store = getStore(user.id);
    const raw = await generator.generate(review, store, { examples: approvedExamples(user.id, review.rating, excludeId) });
    db.prepare(
      `INSERT INTO usage (user_id, month, generations) VALUES (?, ?, 1)
       ON CONFLICT(user_id, month) DO UPDATE SET generations = generations + 1`,
    ).run(user.id, currentMonth());
    const result = applySafety(raw, store);
    return { ...result, guidance: result.isMalicious ? reportGuide(review.platform) : '' };
  }

  function defaultReply(result) {
    // 악성 리뷰는 감정적이지 않은 대응 문구를, 그 외에는 첫 번째 초안을 기본 답글로 둔다.
    return (result.isMalicious && result.calmReply) || result.drafts[0]?.text || '';
  }

  function resultColumns(result) {
    return {
      sentiment: result.sentiment,
      is_malicious: result.isMalicious ? 1 : 0,
      malicious_reason: result.maliciousReason,
      drafts: JSON.stringify({
        drafts: result.drafts,
        keyPoints: result.keyPoints,
        praises: result.praises || [],
        complaints: result.complaints || [],
        calmWarnings: result.calmWarnings || [],
      }),
      calm_reply: result.calmReply,
      guidance: result.guidance,
      engine: result.engine,
    };
  }

  function insertReview(userId, input, result) {
    const cols = result
      ? resultColumns(result)
      : { sentiment: '', is_malicious: 0, malicious_reason: '', drafts: '{}', calm_reply: '', guidance: '', engine: '' };
    const ts = now();
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO reviews (user_id, platform, rating, author, menu, content, status, sentiment, is_malicious, malicious_reason,
          drafts, calm_reply, guidance, final_reply, engine, source, external_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        userId, input.platform, input.rating, input.author, input.menu, input.content,
        cols.sentiment, cols.is_malicious, cols.malicious_reason, cols.drafts, cols.calm_reply, cols.guidance,
        result ? defaultReply(result) : '', cols.engine, input.source || 'paste', input.externalId || null, ts, ts,
      );
    return Number(lastInsertRowid);
  }

  /** 공식 API 로 가져온 리뷰를 저장한다. 사용량이 남아 있으면 초안도 함께 만든다. */
  async function importReview(userId, input) {
    const user = userById(userId);
    let result = null;
    try {
      result = await runGeneration(user, input, { soft: true });
    } catch (err) {
      console.warn(`[import] 초안 생성 실패: ${err.message}`);
    }
    const id = insertReview(userId, input, result);
    hub.publish(userId, { entity: 'reviews', newReviews: 1 });
    return id;
  }

  const notifyPlan = (userId) => hub.publish(userId, { entity: 'plan' });
  const billing = overrides.billing || createBilling({ db, config, sealer, fetch: overrides.fetch, planOf, notify: notifyPlan });
  const google = overrides.google || createGoogle({ db, config, sealer, fetch: overrides.fetch, importReview });

  // ───────────── 예약 작업 ─────────────
  let lastRetentionRun = 0;
  async function runJobs({ forceRetention = false } = {}) {
    const out = {};
    try {
      out.billing = await billing.runDue();
    } catch (err) {
      console.error('[jobs] 정기결제 처리 오류', err);
    }
    try {
      out.imported = await google.runDue();
    } catch (err) {
      console.error('[jobs] 리뷰 수집 오류', err);
    }
    if (forceRetention || Date.now() - lastRetentionRun > 86400000) {
      lastRetentionRun = Date.now();
      // 개인정보 보관 기간: 기간이 지난 리뷰 원문과 답글을 삭제한다. (결제 기록은 법정 보관 의무로 유지)
      const cutoff = new Date(Date.now() - config.retentionDays * 86400000).toISOString();
      out.purged = Number(db.prepare('DELETE FROM reviews WHERE created_at < ?').run(cutoff).changes);
      db.prepare('DELETE FROM sessions WHERE last_seen < ?').run(new Date(Date.now() - 180 * 86400000).toISOString());
    }
    return out;
  }

  // ───────────── 라우트 ─────────────
  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

  route('GET', /^\/api\/health$/, () => ({ ok: true, version: config.version }));
  route('GET', /^\/api\/version$/, () => ({ version: config.version, engine: generator.engine, appName: config.appName }));

  // 로그인 전에도 보이는 정보: 요금, 체험 기간, 보관 기간, 사업자 정보 (약관·개인정보처리방침 화면용)
  route('GET', /^\/api\/public\/config$/, () => ({
    appName: config.appName,
    priceText: config.priceText,
    priceAmount: config.priceAmount,
    trialDays: config.trialDays,
    freeMonthlyLimit: config.freeMonthlyLimit,
    retentionDays: config.retentionDays,
    business: config.business,
    billingEnabled: billing.enabled,
    googleEnabled: google.enabled,
    aiEnabled: generator.engine === 'claude',
  }));

  route('POST', /^\/api\/auth\/signup$/, async (req) => {
    if (!authLimiter(`ip${clientIp(req)}`)) throw new HttpError(429, '시도 횟수가 너무 많습니다. 잠시 후 다시 시도해 주세요.');
    const body = await readBody(req);
    if (body.agree !== true) throw new HttpError(400, '이용약관과 개인정보 처리방침에 동의해 주세요.');
    const email = normalizeEmail(body.email);
    const problem = validateCredentials(email, body.password);
    if (problem) throw new HttpError(400, problem);
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, '이미 가입된 이메일입니다. 로그인해 주세요.');
    const hash = await hashPassword(body.password);
    const { lastInsertRowid } = db
      .prepare('INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)')
      .run(email, hash, now());
    const token = createSession(db, Number(lastInsertRowid), body.device);
    return { token };
  });

  route('POST', /^\/api\/auth\/login$/, async (req) => {
    if (!authLimiter(`ip${clientIp(req)}`)) throw new HttpError(429, '시도 횟수가 너무 많습니다. 잠시 후 다시 시도해 주세요.');
    const body = await readBody(req);
    const email = normalizeEmail(body.email);
    const user = db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get(email);
    if (!user || !(await verifyPassword(String(body.password || ''), user.password_hash))) {
      throw new HttpError(401, '이메일 또는 비밀번호가 올바르지 않습니다.');
    }
    return { token: createSession(db, user.id, body.device) };
  });

  route('POST', /^\/api\/auth\/logout$/, (req) => {
    const token = bearer(req);
    if (token) deleteSession(db, token);
    return { ok: true };
  });

  route('POST', /^\/api\/auth\/password$/, async (req) => {
    const user = requireUser(req);
    const body = await readBody(req);
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
    if (!(await verifyPassword(String(body.current || ''), row.password_hash))) throw new HttpError(400, '현재 비밀번호가 올바르지 않습니다.');
    const problem = validateCredentials(user.email, body.next);
    if (problem) throw new HttpError(400, problem);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(body.next), user.id);
    // 비밀번호를 바꾸면 현재 기기를 제외한 모든 기기를 로그아웃시킨다.
    const keep = sessionIdOf(user.token);
    for (const s of db.prepare('SELECT token_hash FROM sessions WHERE user_id = ?').all(user.id)) {
      if (s.token_hash.slice(0, 16) !== keep) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(s.token_hash);
    }
    return { ok: true };
  });

  route('GET', /^\/api\/me$/, (req) => {
    const user = requireUser(req);
    return {
      email: user.email,
      isAdmin: isAdmin(user),
      plan: planOf(user),
      store: getStore(user.id),
      engine: generator.engine,
      canReadImages: Boolean(generator.canReadImages),
      version: config.version,
      priceText: config.priceText,
      paymentUrl: config.paymentUrl,
      billingEnabled: billing.enabled,
      googleEnabled: google.enabled,
    };
  });

  // 회원 탈퇴: 구독 해지 후 계정과 모든 리뷰·연동 정보를 지운다 (결제 기록은 법정 보관을 위해 남기지 않고 함께 삭제되지 않도록 별도 보관하지 않는다).
  route('DELETE', /^\/api\/me$/, async (req) => {
    const user = requireUser(req);
    const body = await readBody(req);
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
    if (!(await verifyPassword(String(body.password || ''), row.password_hash))) throw new HttpError(400, '비밀번호가 올바르지 않습니다.');
    await google.disconnect(user.id).catch(() => {});
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    return { ok: true };
  });

  route('GET', /^\/api\/sessions$/, (req) => {
    const user = requireUser(req);
    const current = sessionIdOf(user.token);
    return db
      .prepare('SELECT token_hash, device, created_at, last_seen FROM sessions WHERE user_id = ? ORDER BY last_seen DESC')
      .all(user.id)
      .map((s) => ({
        id: s.token_hash.slice(0, 16),
        device: s.device || '알 수 없는 기기',
        createdAt: s.created_at,
        lastSeen: s.last_seen,
        current: s.token_hash.slice(0, 16) === current,
      }));
  });

  route('DELETE', /^\/api\/sessions\/([a-f0-9]{16})$/, (req, [id]) => {
    const user = requireUser(req);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND substr(token_hash, 1, 16) = ?').run(user.id, id);
    return { ok: true };
  });

  route('GET', /^\/api\/store$/, (req) => {
    const user = requireUser(req);
    const learned = db
      .prepare("SELECT COUNT(*) AS n FROM reviews WHERE user_id = ? AND status IN ('approved', 'posted') AND final_reply != ''")
      .get(user.id).n;
    return { ...getStore(user.id), learnedExamples: learned };
  });

  route('PUT', /^\/api\/store$/, async (req) => {
    const user = requireUser(req);
    const body = await readBody(req);
    const current = getStore(user.id);
    const next = {};
    for (const [field, max] of Object.entries(STORE_FIELDS)) {
      next[field] = field in body ? str(body[field], max, field) : current[field];
    }
    if (!['friendly', 'polite', 'cheerful'].includes(next.tone)) next.tone = 'friendly';
    if (!['none', 'some', 'many'].includes(next.emoji)) next.emoji = 'some';
    db.prepare(
      `UPDATE stores SET name=?, category=?, owner_title=?, signature_menus=?, tone=?, emoji=?, greeting=?, signature=?,
        sample_replies=?, avoid_words=?, notes=?, updated_at=? WHERE user_id=?`,
    ).run(
      next.name, next.category, next.owner_title, next.signature_menus, next.tone, next.emoji, next.greeting, next.signature,
      next.sample_replies, next.avoid_words, next.notes, now(), user.id,
    );
    hub.publish(user.id, { entity: 'store' });
    return getStore(user.id);
  });

  route('GET', /^\/api\/reviews$/, (req, _m, url) => {
    const user = requireUser(req);
    const status = url.searchParams.get('status');
    const q = (url.searchParams.get('q') || '').trim();
    const limit = Math.min(200, Number.parseInt(url.searchParams.get('limit') || '100', 10) || 100);
    let sql = 'SELECT * FROM reviews WHERE user_id = ?';
    const params = [user.id];
    if (status && STATUSES.includes(status)) {
      sql += ' AND status = ?';
      params.push(status);
    }
    if (q) {
      sql += " AND (content LIKE ? ESCAPE '\\' OR author LIKE ? ESCAPE '\\' OR menu LIKE ? ESCAPE '\\')";
      const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      params.push(like, like, like);
    }
    sql += ' ORDER BY created_at DESC, id DESC LIMIT ?';
    params.push(limit);
    return db.prepare(sql).all(...params).map((r) => reviewOut(r));
  });

  route('POST', /^\/api\/reviews$/, async (req) => {
    const user = requireUser(req);
    const input = parseReviewInput(await readBody(req));
    const result = await runGeneration(user, input);
    const id = insertReview(user.id, input, result);
    hub.publish(user.id, { entity: 'reviews' });
    return { review: reviewOut(getReview(user.id, id), getStore(user.id)), warning: result.warning || null };
  });

  // 리뷰 화면 캡처(이미지)에서 리뷰를 읽어 낸다.
  route('POST', /^\/api\/reviews\/extract$/, async (req) => {
    const user = requireUser(req);
    if (!extractLimiter(`u${user.id}`)) throw new HttpError(429, '잠시 후 다시 시도해 주세요.');
    const body = await readBody(req, 8 * 1024 * 1024);
    const m = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.image || ''));
    if (!m || !IMAGE_TYPES.includes(m[1])) throw new HttpError(400, '이미지 파일(JPG, PNG)을 올려 주세요.');
    if (!generator.canReadImages) throw new HttpError(501, '캡처 인식은 AI 키가 설정된 경우에만 쓸 수 있어요. 리뷰 글을 복사해 붙여넣어 주세요.');
    try {
      const reviews = await generator.extractFromImage(m[2], m[1]);
      return { reviews };
    } catch (err) {
      throw new HttpError(502, `캡처를 읽지 못했어요: ${err.message}`);
    }
  });

  route('GET', /^\/api\/reviews\/(\d+)$/, (req, [id]) => {
    const user = requireUser(req);
    return reviewOut(getReview(user.id, Number(id)), getStore(user.id));
  });

  route('POST', /^\/api\/reviews\/(\d+)\/regenerate$/, async (req, [id]) => {
    const user = requireUser(req);
    const row = getReview(user.id, Number(id));
    const result = await runGeneration(user, row, { excludeId: row.id });
    const cols = resultColumns(result);
    db.prepare(
      `UPDATE reviews SET sentiment=?, is_malicious=?, malicious_reason=?, drafts=?, calm_reply=?, guidance=?, engine=?,
        final_reply=?, updated_at=? WHERE id=? AND user_id=?`,
    ).run(
      cols.sentiment, cols.is_malicious, cols.malicious_reason, cols.drafts, cols.calm_reply, cols.guidance, cols.engine,
      defaultReply(result), now(), row.id, user.id,
    );
    hub.publish(user.id, { entity: 'reviews' });
    return { review: reviewOut(getReview(user.id, row.id), getStore(user.id)), warning: result.warning || null };
  });

  /** 답글 저장·상태 변경 공통 처리. 승인 시 안전 경고 확인과 수정률 측정을 한다. */
  function saveReply(user, row, { finalReply, status, confirmWarnings }) {
    const store = getStore(user.id);
    // 개인정보는 언제나 자동으로 가린다.
    const reply = maskPII(finalReply ?? row.final_reply).text;
    const approving = (status === 'approved' || status === 'posted') && row.status !== status;
    if (approving) {
      if (!reply.trim()) throw new HttpError(400, '답글 내용이 비어 있어요.');
      const warnings = checkReply(reply, store).warnings;
      if (warnings.length && !confirmWarnings) {
        throw new HttpError(409, '답글에 주의할 표현이 있어요. 확인 후 다시 승인해 주세요.', { warnings });
      }
    }
    let { approved_at: approvedAt, edit_rate: editRateValue, chosen_draft: chosen } = row;
    if (approving || ((status === 'approved' || status === 'posted') && reply !== row.final_reply)) {
      // 사장님이 초안을 얼마나 고쳤는지 기록한다 (말투 학습 효과 측정).
      const meta = metaOf(row);
      const best = measureEdit([...(meta.drafts || []).map((d) => d.text), row.calm_reply], reply);
      editRateValue = best.rate;
      chosen = best.draft;
      approvedAt = approvedAt || now();
    }
    if (status === 'draft' || status === 'skipped') approvedAt = null;
    const postedAt = status === 'posted' ? row.posted_at || now() : null;
    db.prepare(
      `UPDATE reviews SET final_reply=?, status=?, posted_at=?, approved_at=?, edit_rate=?, chosen_draft=?, publish_error='', updated_at=?
       WHERE id=? AND user_id=?`,
    ).run(reply, status, postedAt, approvedAt, editRateValue, chosen, now(), row.id, user.id);
    hub.publish(user.id, { entity: 'reviews' });
    return reviewOut(getReview(user.id, row.id), store);
  }

  route('PATCH', /^\/api\/reviews\/(\d+)$/, async (req, [id]) => {
    const user = requireUser(req);
    const row = getReview(user.id, Number(id));
    const body = await readBody(req);
    const finalReply = 'finalReply' in body ? str(body.finalReply, 2000, '답글') : undefined;
    let status = row.status;
    if ('status' in body) {
      if (!STATUSES.includes(body.status)) throw new HttpError(400, '알 수 없는 상태입니다.');
      status = body.status;
    }
    return saveReply(user, row, { finalReply, status, confirmWarnings: body.confirmWarnings === true });
  });

  // 공식 API 로 연동된 리뷰: 승인 1번으로 플랫폼에 바로 게시한다.
  route('POST', /^\/api\/reviews\/(\d+)\/publish$/, async (req, [id]) => {
    const user = requireUser(req);
    const row = getReview(user.id, Number(id));
    const body = await readBody(req);
    if (row.source !== 'google' || !row.external_id) throw new HttpError(400, '이 리뷰는 자동 게시를 지원하지 않아요. 복사해서 올려 주세요.');
    const finalReply = 'finalReply' in body ? str(body.finalReply, 2000, '답글') : row.final_reply;
    const reply = maskPII(finalReply).text;
    if (!reply.trim()) throw new HttpError(400, '답글 내용이 비어 있어요.');
    const warnings = checkReply(reply, getStore(user.id)).warnings;
    if (warnings.length && body.confirmWarnings !== true) {
      throw new HttpError(409, '답글에 주의할 표현이 있어요. 확인 후 다시 승인해 주세요.', { warnings });
    }
    try {
      await google.publishReply(user.id, row.external_id, reply);
    } catch (err) {
      db.prepare('UPDATE reviews SET final_reply = ?, publish_error = ?, updated_at = ? WHERE id = ?').run(reply, String(err.message).slice(0, 300), now(), row.id);
      hub.publish(user.id, { entity: 'reviews' });
      throw new HttpError(502, `게시하지 못했어요: ${err.message}`);
    }
    return saveReply(user, getReview(user.id, row.id), { finalReply: reply, status: 'posted', confirmWarnings: true });
  });

  route('DELETE', /^\/api\/reviews\/(\d+)$/, (req, [id]) => {
    const user = requireUser(req);
    const row = getReview(user.id, Number(id));
    db.prepare('DELETE FROM reviews WHERE id = ? AND user_id = ?').run(row.id, user.id);
    hub.publish(user.id, { entity: 'reviews' });
    return { ok: true };
  });

  route('GET', /^\/api\/stats$/, (req) => {
    const user = requireUser(req);
    const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM reviews WHERE user_id = ? GROUP BY status').all(user.id)) {
      counts[r.status] = r.n;
    }
    const monthStart = `${currentMonth()}-01`;
    const month = db
      .prepare(
        `SELECT COUNT(*) AS total, SUM(status = 'posted') AS posted, SUM(is_malicious) AS malicious, AVG(rating) AS avg
         FROM reviews WHERE user_id = ? AND created_at >= ?`,
      )
      .get(user.id, monthStart);
    return {
      counts,
      month: {
        total: month.total || 0,
        posted: month.posted || 0,
        malicious: month.malicious || 0,
        avgRating: month.avg ? Math.round(month.avg * 10) / 10 : null,
        minutesSaved: (month.total || 0) * MINUTES_SAVED_PER_REPLY,
      },
      devicesOnline: hub.count(user.id),
    };
  });

  route('GET', /^\/api\/report$/, (req, _m, url) => {
    const user = requireUser(req);
    const month = url.searchParams.get('month') || currentMonth();
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpError(400, '월 형식이 올바르지 않습니다.');
    return buildMonthlyReport(db, user.id, month);
  });

  // ───────────── 정기결제 ─────────────
  route('GET', /^\/api\/billing$/, (req) => {
    const user = requireUser(req);
    return { ...billing.status(user), plan: planOf(user), priceText: config.priceText, trialDays: config.trialDays, business: config.business };
  });

  route('POST', /^\/api\/billing\/confirm$/, async (req) => {
    const user = requireUser(req);
    const body = await readBody(req);
    try {
      return await billing.confirm(user, { authKey: String(body.authKey || ''), customerKey: String(body.customerKey || '') });
    } catch (err) {
      throw new HttpError(400, err.message);
    }
  });

  route('POST', /^\/api\/billing\/cancel$/, (req) => {
    const user = requireUser(req);
    try {
      return billing.cancel(user);
    } catch (err) {
      throw new HttpError(400, err.message);
    }
  });

  route('POST', /^\/api\/billing\/resume$/, (req) => {
    const user = requireUser(req);
    try {
      return billing.resume(user);
    } catch (err) {
      throw new HttpError(400, err.message);
    }
  });

  // ───────────── 공식 API 연동 (Google 비즈니스 프로필) ─────────────
  route('GET', /^\/api\/integrations$/, (req) => ({ google: google.status(requireUser(req).id) }));

  route('POST', /^\/api\/integrations\/google\/start$/, (req) => {
    const user = requireUser(req);
    try {
      return { url: google.startUrl(user.id, originOf(req)) };
    } catch (err) {
      throw new HttpError(400, err.message);
    }
  });

  route('GET', /^\/api\/integrations\/google\/callback$/, async (req, _m, url, res) => {
    if (url.searchParams.get('error')) return redirect(res, '/#/account?google=denied');
    try {
      const userId = await google.callback({ code: url.searchParams.get('code'), state: url.searchParams.get('state') });
      hub.publish(userId, { entity: 'integrations' });
      google.sync(userId).catch(() => {});
      return redirect(res, '/#/account?google=connected');
    } catch (err) {
      console.warn(`[google] 연결 실패: ${err.message}`);
      return redirect(res, '/#/account?google=failed');
    }
  });

  route('GET', /^\/api\/integrations\/google\/locations$/, async (req) => {
    const user = requireUser(req);
    try {
      return await google.listLocations(user.id);
    } catch (err) {
      throw new HttpError(502, err.message);
    }
  });

  route('POST', /^\/api\/integrations\/google\/location$/, async (req) => {
    const user = requireUser(req);
    const body = await readBody(req);
    try {
      const status = await google.selectLocation(user.id, { account: String(body.account || ''), location: String(body.location || '') });
      google.sync(user.id).catch(() => {});
      return status;
    } catch (err) {
      throw new HttpError(400, err.message);
    }
  });

  route('POST', /^\/api\/integrations\/google\/sync$/, async (req) => {
    const user = requireUser(req);
    try {
      return { imported: await google.sync(user.id) };
    } catch (err) {
      throw new HttpError(502, err.message);
    }
  });

  route('DELETE', /^\/api\/integrations\/google$/, async (req) => google.disconnect(requireUser(req).id));

  // ───────────── 시스템·업데이트 ─────────────
  route('GET', /^\/api\/system\/info$/, (req) => {
    requireUser(req);
    return {
      version: config.version,
      engine: generator.engine,
      model: generator.engine === 'claude' ? config.anthropicModel : null,
      lanUrls: lanAddresses(config.port),
      supervised: config.supervised,
    };
  });

  route('GET', /^\/api\/system\/update$/, async (req, _m, url) => {
    requireUser(req);
    const fresh = url.searchParams.get('refresh') === '1';
    if (fresh || !updateCache || Date.now() - updateCache.at > 10 * 60 * 1000) {
      updateCache = { at: Date.now(), info: await checkForUpdate() };
    }
    return { ...updateCache.info, canApply: config.supervised };
  });

  route('POST', /^\/api\/system\/update$/, async (req, _m, _u, res) => {
    requireAdmin(req);
    if (!config.supervised) {
      throw new HttpError(400, '이 서버는 자동 재시작 모드가 아닙니다. 클라우드 배포본은 새 버전을 배포하면 자동으로 반영됩니다.');
    }
    const result = await applyUpdate({ log: (m) => console.log(`[update] ${m}`) });
    updateCache = null;
    if (result.updated && !result.error) {
      // 응답을 보낸 뒤 종료하면 슈퍼바이저가 새 코드로 서버를 다시 띄운다.
      res.on('finish', () => setTimeout(() => process.exit(RESTART_EXIT_CODE), 300));
    }
    return result;
  });

  // ───────────── 관리자 ─────────────
  route('GET', /^\/api\/admin\/users$/, (req) => {
    requireAdmin(req);
    return db
      .prepare(
        `SELECT u.id, u.email, u.plan, u.plan_until, u.created_at, s.name AS store_name,
          (SELECT COUNT(*) FROM reviews r WHERE r.user_id = u.id) AS reviews,
          (SELECT status || CASE WHEN cancel_at_period_end THEN ':ending' ELSE '' END FROM subscriptions b WHERE b.user_id = u.id) AS sub
         FROM users u LEFT JOIN stores s ON s.user_id = u.id ORDER BY u.id DESC`,
      )
      .all()
      .map((u) => {
        const p = planOf({ id: u.id, plan: u.plan, planUntil: u.plan_until, createdAt: u.created_at });
        return { id: u.id, email: u.email, storeName: u.store_name || '', reviews: u.reviews, createdAt: u.created_at, plan: p, subscription: u.sub || '' };
      });
  });

  route('GET', /^\/api\/admin\/metrics$/, (req) => {
    requireAdmin(req);
    return buildPilotMetrics(db, { priceAmount: config.priceAmount });
  });

  route('PATCH', /^\/api\/admin\/users\/(\d+)$/, async (req, [id]) => {
    requireAdmin(req);
    const body = await readBody(req);
    if (!['trial', 'pro', 'free'].includes(body.plan)) throw new HttpError(400, '요금제를 확인해 주세요.');
    let until = null;
    if (body.plan === 'pro') {
      const months = Number(body.months ?? 1);
      if (!Number.isInteger(months) || months < 0 || months > 36) throw new HttpError(400, '개월 수를 확인해 주세요.');
      // 0개월 = 기한 없음. 기존 프로 기간이 남아 있으면 그 뒤로 연장한다.
      if (months > 0) {
        const row = db.prepare('SELECT plan, plan_until FROM users WHERE id = ?').get(Number(id));
        const base = row?.plan === 'pro' && row.plan_until && Date.parse(row.plan_until) > Date.now() ? new Date(row.plan_until) : new Date();
        base.setMonth(base.getMonth() + months);
        until = base.toISOString();
      }
    }
    const { changes } = db.prepare('UPDATE users SET plan = ?, plan_until = ? WHERE id = ?').run(body.plan, until, Number(id));
    if (!changes) throw new HttpError(404, '사용자를 찾을 수 없습니다.');
    hub.publish(Number(id), { entity: 'plan' });
    return { ok: true };
  });

  // ───────────── 실시간 이벤트 스트림 ─────────────
  function handleEvents(req, res) {
    const user = requireUser(req);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ version: config.version })}\n\n`);
    hub.add(user.id, res);
    // 다른 기기들에도 "접속 기기 수"가 바뀌었음을 알린다.
    hub.publish(user.id, { entity: 'devices' });
    req.on('close', () => {
      hub.remove(user.id, res);
      hub.publish(user.id, { entity: 'devices' });
    });
  }

  // ───────────── 정적 파일(웹앱) ─────────────
  function serveStatic(req, res, pathname) {
    if (pathname === '/sw.js') {
      // 서비스워커 파일에 버전을 새겨 넣어, 서버가 업데이트되면 모든 기기의 앱이 새 버전을 감지하게 한다.
      const src = fs.readFileSync(path.join(config.publicDir, 'sw.js'), 'utf8').replaceAll('__APP_VERSION__', config.version);
      res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-cache', ...BASE_HEADERS, 'Content-Security-Policy': APP_CSP });
      res.end(req.method === 'HEAD' ? undefined : src);
      return;
    }
    let rel = decodeURIComponent(pathname);
    if (rel === '/' || !path.extname(rel)) rel = '/index.html';
    const file = path.normalize(path.join(config.publicDir, rel));
    if (!file.startsWith(config.publicDir + path.sep)) throw new HttpError(404, '찾을 수 없습니다.');
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      throw new HttpError(404, '찾을 수 없습니다.');
    }
    if (!stat.isFile()) throw new HttpError(404, '찾을 수 없습니다.');
    const ext = path.extname(file);
    const cache = ext === '.png' || ext === '.ico' ? 'public, max-age=86400' : 'no-cache';
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': cache,
      ...BASE_HEADERS,
      'Content-Security-Policy': path.basename(file) === 'billing.html' ? BILLING_CSP : APP_CSP,
    });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(file).pipe(res);
  }

  function applyCors(req, res) {
    const origin = req.headers.origin;
    if (origin && config.allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;
    try {
      if (pathname.startsWith('/api/')) {
        applyCors(req, res);
        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }
        if (pathname === '/api/events' && req.method === 'GET') return handleEvents(req, res);
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = pathname.match(r.pattern);
          if (!m) continue;
          const result = await r.handler(req, m.slice(1), url, res);
          if (result === HANDLED) return;
          return send(res, 200, result);
        }
        throw new HttpError(404, '없는 API 입니다.');
      }
      // 휴대폰 "공유하기"로 들어온 요청: 앱(서비스워커)이 없을 때만 여기로 온다 → 입력 화면으로 보낸다.
      if (pathname === '/share-target') {
        req.resume();
        return redirect(res, '/#/new');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, '허용되지 않는 요청입니다.');
      return serveStatic(req, res, pathname);
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof HttpError) return send(res, err.status, { error: err.message, ...(err.extra || {}) });
      console.error('[server] 처리 중 오류', err);
      return send(res, 500, { error: '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' });
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res);
  });
  const heartbeat = setInterval(() => hub.heartbeat(), 25000);
  heartbeat.unref();
  let jobTimer = null;
  if (overrides.jobs !== false) {
    jobTimer = setInterval(() => runJobs().catch(() => {}), 5 * 60 * 1000);
    jobTimer.unref();
    setTimeout(() => runJobs().catch(() => {}), 5000).unref();
  }
  server.on('close', () => {
    clearInterval(heartbeat);
    if (jobTimer) clearInterval(jobTimer);
    db.close();
  });
  function close(callback) {
    // 실시간 스트림 연결이 열려 있으면 server.close 가 끝나지 않으므로 먼저 정리한다.
    hub.closeAll();
    server.close(callback);
    server.closeAllConnections();
  }
  return { server, config, db, close, runJobs, billing, google, importReview };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { server, config, close } = createApp();
  server.listen(config.port, config.host, () => {
    // 런처의 "중지" 기능이 이 프로세스를 찾을 수 있도록 PID 를 남긴다.
    fs.writeFileSync(path.join(config.dataDir, 'server.pid'), String(process.pid));
    console.log(`${config.appName} v${config.version} 실행 중`);
    console.log(`  이 컴퓨터:  http://localhost:${config.port}`);
    for (const u of lanAddresses(config.port)) console.log(`  같은 와이파이의 휴대폰: ${u}`);
    console.log(`  답글 엔진: ${config.anthropicApiKey ? `Claude (${config.anthropicModel})` : '내장 문장 엔진 (ANTHROPIC_API_KEY 미설정)'}`);
    console.log(`  정기결제: ${config.tossSecretKey ? '토스페이먼츠 사용' : '미설정'} · Google 연동: ${config.googleClientId ? '사용' : '미설정'}`);
  });
  const shutdown = () => close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
