// 리뷰답글 도우미 서버: API, 실시간 동기화(SSE), 웹앱(PWA) 파일을 한 프로세스에서 제공한다.
// 외부 웹 프레임워크 없이 node:http 만 사용한다.
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
import { createGenerator, PLATFORMS } from './ai.js';
import { RESTART_EXIT_CODE, applyUpdate, checkForUpdate } from '../scripts/updater.js';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

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

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

const STATUSES = ['draft', 'approved', 'posted', 'skipped'];
const STORE_FIELDS = {
  name: 60,
  category: 40,
  tone: 20,
  emoji: 10,
  greeting: 120,
  signature: 120,
  sample_replies: 2000,
  avoid_words: 300,
  notes: 500,
};
const MINUTES_SAVED_PER_REPLY = 3;

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
  const hub = createSyncHub();
  const authLimiter = createRateLimiter(20, 10 * 60 * 1000);
  const generateLimiter = createRateLimiter(30, 60 * 1000);
  let updateCache = null;

  // ───────────── 도우미 함수 ─────────────
  function send(res, status, body, headers = {}) {
    const json = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store', ...headers });
    res.end(json);
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 100 * 1024) throw new HttpError(413, '요청 내용이 너무 큽니다.');
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

  function bearer(req) {
    const h = req.headers.authorization || '';
    return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  }

  function requireUser(req) {
    const user = authenticate(db, bearer(req));
    if (!user) throw new HttpError(401, '로그인이 필요합니다.');
    return user;
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

  function reviewOut(row) {
    return {
      id: row.id,
      platform: row.platform,
      platformName: PLATFORMS[row.platform] || row.platform,
      rating: row.rating,
      author: row.author,
      menu: row.menu,
      content: row.content,
      status: row.status,
      sentiment: row.sentiment,
      isMalicious: Boolean(row.is_malicious),
      maliciousReason: row.malicious_reason,
      keyPoints: JSON.parse(row.drafts || '{}').keyPoints || [],
      drafts: JSON.parse(row.drafts || '{}').drafts || [],
      calmReply: row.calm_reply,
      guidance: row.guidance,
      finalReply: row.final_reply,
      engine: row.engine,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
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
    return { platform, rating, content, author: str(body.author, 50, '닉네임'), menu: str(body.menu, 100, '메뉴') };
  }

  async function runGeneration(user, review) {
    const plan = planOf(user);
    if (plan.remaining <= 0) {
      throw new HttpError(
        402,
        plan.plan === 'free'
          ? `이번 달 무료 사용량(${plan.limit}회)을 모두 사용했어요. 프로 요금제(${config.priceText})로 계속 이용할 수 있어요.`
          : '이번 달 사용량을 모두 사용했어요. 관리자에게 문의해 주세요.',
      );
    }
    if (!generateLimiter(`u${user.id}`)) throw new HttpError(429, '잠시 후 다시 시도해 주세요.');
    const result = await generator.generate(review, getStore(user.id));
    db.prepare(
      `INSERT INTO usage (user_id, month, generations) VALUES (?, ?, 1)
       ON CONFLICT(user_id, month) DO UPDATE SET generations = generations + 1`,
    ).run(user.id, currentMonth());
    return result;
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
      drafts: JSON.stringify({ drafts: result.drafts, keyPoints: result.keyPoints }),
      calm_reply: result.calmReply,
      guidance: result.guidance,
      engine: result.engine,
    };
  }

  // ───────────── 라우트 ─────────────
  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

  route('GET', /^\/api\/health$/, () => ({ ok: true, version: config.version }));
  route('GET', /^\/api\/version$/, () => ({ version: config.version, engine: generator.engine, appName: config.appName }));

  route('POST', /^\/api\/auth\/signup$/, async (req) => {
    if (!authLimiter(`ip${clientIp(req)}`)) throw new HttpError(429, '시도 횟수가 너무 많습니다. 잠시 후 다시 시도해 주세요.');
    const body = await readBody(req);
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
      version: config.version,
      priceText: config.priceText,
      paymentUrl: config.paymentUrl,
    };
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
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND substr(token_hash, 1, 16) = ?").run(user.id, id);
    return { ok: true };
  });

  route('GET', /^\/api\/store$/, (req) => getStore(requireUser(req).id));

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
      `UPDATE stores SET name=?, category=?, tone=?, emoji=?, greeting=?, signature=?, sample_replies=?, avoid_words=?, notes=?, updated_at=?
       WHERE user_id=?`,
    ).run(
      next.name, next.category, next.tone, next.emoji, next.greeting, next.signature,
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
    return db.prepare(sql).all(...params).map(reviewOut);
  });

  route('POST', /^\/api\/reviews$/, async (req) => {
    const user = requireUser(req);
    const input = parseReviewInput(await readBody(req));
    const result = await runGeneration(user, input);
    const cols = resultColumns(result);
    const ts = now();
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO reviews (user_id, platform, rating, author, menu, content, status, sentiment, is_malicious, malicious_reason,
          drafts, calm_reply, guidance, final_reply, engine, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        user.id, input.platform, input.rating, input.author, input.menu, input.content,
        cols.sentiment, cols.is_malicious, cols.malicious_reason, cols.drafts, cols.calm_reply, cols.guidance,
        defaultReply(result), cols.engine, ts, ts,
      );
    hub.publish(user.id, { entity: 'reviews' });
    return { review: reviewOut(getReview(user.id, Number(lastInsertRowid))), warning: result.warning || null };
  });

  route('GET', /^\/api\/reviews\/(\d+)$/, (req, [id]) => reviewOut(getReview(requireUser(req).id, Number(id))));

  route('POST', /^\/api\/reviews\/(\d+)\/regenerate$/, async (req, [id]) => {
    const user = requireUser(req);
    const row = getReview(user.id, Number(id));
    const result = await runGeneration(user, row);
    const cols = resultColumns(result);
    db.prepare(
      `UPDATE reviews SET sentiment=?, is_malicious=?, malicious_reason=?, drafts=?, calm_reply=?, guidance=?, engine=?,
        final_reply=?, updated_at=? WHERE id=? AND user_id=?`,
    ).run(
      cols.sentiment, cols.is_malicious, cols.malicious_reason, cols.drafts, cols.calm_reply, cols.guidance, cols.engine,
      defaultReply(result), now(), row.id, user.id,
    );
    hub.publish(user.id, { entity: 'reviews' });
    return { review: reviewOut(getReview(user.id, row.id)), warning: result.warning || null };
  });

  route('PATCH', /^\/api\/reviews\/(\d+)$/, async (req, [id]) => {
    const user = requireUser(req);
    const row = getReview(user.id, Number(id));
    const body = await readBody(req);
    const finalReply = 'finalReply' in body ? str(body.finalReply, 2000, '답글') : row.final_reply;
    let status = row.status;
    if ('status' in body) {
      if (!STATUSES.includes(body.status)) throw new HttpError(400, '알 수 없는 상태입니다.');
      status = body.status;
    }
    const postedAt = status === 'posted' ? row.posted_at || now() : null;
    db.prepare('UPDATE reviews SET final_reply=?, status=?, posted_at=?, updated_at=? WHERE id=? AND user_id=?').run(
      finalReply, status, postedAt, now(), row.id, user.id,
    );
    hub.publish(user.id, { entity: 'reviews' });
    return reviewOut(getReview(user.id, row.id));
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

  route('GET', /^\/api\/admin\/users$/, (req) => {
    requireAdmin(req);
    return db
      .prepare(
        `SELECT u.id, u.email, u.plan, u.plan_until, u.created_at, s.name AS store_name,
          (SELECT COUNT(*) FROM reviews r WHERE r.user_id = u.id) AS reviews
         FROM users u LEFT JOIN stores s ON s.user_id = u.id ORDER BY u.id DESC`,
      )
      .all()
      .map((u) => {
        const p = planOf({ id: u.id, plan: u.plan, planUntil: u.plan_until, createdAt: u.created_at });
        return { id: u.id, email: u.email, storeName: u.store_name || '', reviews: u.reviews, createdAt: u.created_at, plan: p };
      });
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
      res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
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
      ...SECURITY_HEADERS,
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
          return send(res, 200, result);
        }
        throw new HttpError(404, '없는 API 입니다.');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, '허용되지 않는 요청입니다.');
      return serveStatic(req, res, pathname);
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      console.error('[server] 처리 중 오류', err);
      return send(res, 500, { error: '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' });
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res);
  });
  const heartbeat = setInterval(() => hub.heartbeat(), 25000);
  heartbeat.unref();
  server.on('close', () => {
    clearInterval(heartbeat);
    db.close();
  });
  function close(callback) {
    // 실시간 스트림 연결이 열려 있으면 server.close 가 끝나지 않으므로 먼저 정리한다.
    hub.closeAll();
    server.close(callback);
    server.closeAllConnections();
  }
  return { server, config, db, close };
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
  });
  const shutdown = () => close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
