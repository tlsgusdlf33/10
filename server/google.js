// Google 비즈니스 프로필 공식 API 연동: 리뷰 자동 수집 → 승인 1번으로 답글 게시.
// 사장님 비밀번호를 받지 않고 Google OAuth 동의로만 연결한다 (business.manage 권한).
// 참고: Google 비즈니스 프로필 API 는 Google Cloud 프로젝트별로 사용 신청·승인이 필요하다.
import crypto from 'node:crypto';
import { now } from './db.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const ACCOUNTS_URL = 'https://mybusinessaccountmanagement.googleapis.com/v1/accounts';
const INFO_API = 'https://mybusinessbusinessinformation.googleapis.com/v1';
const REVIEWS_API = 'https://mybusiness.googleapis.com/v4';
const SCOPE = 'https://www.googleapis.com/auth/business.manage';
const STARS = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
const SYNC_INTERVAL_MS = 15 * 60 * 1000;
const IMPORT_WINDOW_MS = 60 * 86400000; // 처음 연결할 때 최근 60일 안의 답글 없는 리뷰만 가져온다

export function createGoogle({ db, config, sealer, fetch = globalThis.fetch, logger = console, importReview }) {
  const enabled = Boolean(config.googleClientId && config.googleClientSecret);
  const pendingStates = new Map(); // state -> { userId, redirectUri, expires }

  function redirectUri(origin) {
    return `${config.publicUrl || origin}/api/integrations/google/callback`;
  }

  async function tokenRequest(params) {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.googleClientId, client_secret: config.googleClientSecret, ...params }),
      signal: AbortSignal.timeout(20000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Google 인증 실패: ${data.error_description || data.error || res.status}`);
    return data;
  }

  function row(userId) {
    return db.prepare("SELECT * FROM integrations WHERE user_id = ? AND provider = 'google'").get(userId) || null;
  }

  async function accessToken(r) {
    if (r.access_token && r.access_expires_at > Date.now() + 60000) return sealer.open(r.access_token);
    const data = await tokenRequest({ grant_type: 'refresh_token', refresh_token: sealer.open(r.refresh_token) });
    const expires = Date.now() + (data.expires_in || 3600) * 1000;
    db.prepare("UPDATE integrations SET access_token = ?, access_expires_at = ? WHERE user_id = ? AND provider = 'google'").run(
      sealer.seal(data.access_token),
      expires,
      r.user_id,
    );
    r.access_token = sealer.seal(data.access_token);
    r.access_expires_at = expires;
    return data.access_token;
  }

  async function api(r, url, init = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await accessToken(r);
      const res = await fetch(url, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
        signal: AbortSignal.timeout(20000),
      });
      if (res.status === 401 && attempt === 0) {
        r.access_expires_at = 0; // 토큰이 만료됐으면 새로 받아 한 번 더 시도
        continue;
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Google API 오류 (${res.status}): ${data.error?.message || '알 수 없는 오류'}`);
      return data;
    }
    throw new Error('Google 인증이 만료되었습니다. 다시 연결해 주세요.');
  }

  function status(userId) {
    const r = row(userId);
    return {
      enabled,
      connected: Boolean(r),
      locationTitle: r?.location_title || '',
      locationSelected: Boolean(r?.location_name),
      lastSyncedAt: r?.last_synced_at || null,
      lastError: r?.last_error || '',
    };
  }

  function startUrl(userId, origin) {
    if (!enabled) throw new Error('Google 연동이 설정되어 있지 않습니다.');
    const state = crypto.randomBytes(24).toString('base64url');
    const uri = redirectUri(origin);
    pendingStates.set(state, { userId, redirectUri: uri, expires: Date.now() + 10 * 60000 });
    for (const [k, v] of pendingStates) if (v.expires < Date.now()) pendingStates.delete(k);
    const params = new URLSearchParams({
      client_id: config.googleClientId,
      redirect_uri: uri,
      response_type: 'code',
      scope: SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    });
    return `${AUTH_URL}?${params}`;
  }

  async function listLocations(userId) {
    const r = row(userId);
    if (!r) throw new Error('Google 계정이 연결되어 있지 않습니다.');
    const { accounts = [] } = await api(r, ACCOUNTS_URL);
    const out = [];
    for (const account of accounts) {
      const { locations = [] } = await api(r, `${INFO_API}/${account.name}/locations?readMask=name,title&pageSize=100`);
      for (const loc of locations) out.push({ account: account.name, location: loc.name, title: loc.title || loc.name });
    }
    return out;
  }

  async function selectLocation(userId, { account, location }) {
    const match = (await listLocations(userId)).find((l) => l.account === account && l.location === location);
    if (!match) throw new Error('선택한 매장을 찾을 수 없습니다.');
    db.prepare(
      "UPDATE integrations SET account_name = ?, location_name = ?, location_title = ?, last_error = '' WHERE user_id = ? AND provider = 'google'",
    ).run(match.account, match.location, match.title, userId);
    return status(userId);
  }

  /** OAuth 콜백: 코드 교환 → 저장 → 매장이 하나면 자동 선택. 연결한 사용자 id 를 돌려준다. */
  async function callback({ code, state }) {
    const pending = pendingStates.get(state);
    pendingStates.delete(state);
    if (!pending || pending.expires < Date.now()) throw new Error('연결 요청이 만료되었습니다. 다시 시도해 주세요.');
    const data = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: pending.redirectUri });
    if (!data.refresh_token) throw new Error('Google 에서 장기 접근 권한을 받지 못했습니다. 다시 연결해 주세요.');
    db.prepare(
      `INSERT INTO integrations (user_id, provider, refresh_token, access_token, access_expires_at, connected_at)
       VALUES (?, 'google', ?, ?, ?, ?)
       ON CONFLICT(user_id, provider) DO UPDATE SET refresh_token = excluded.refresh_token, access_token = excluded.access_token,
         access_expires_at = excluded.access_expires_at, connected_at = excluded.connected_at, last_error = ''`,
    ).run(pending.userId, sealer.seal(data.refresh_token), sealer.seal(data.access_token), Date.now() + (data.expires_in || 3600) * 1000, now());
    try {
      const locations = await listLocations(pending.userId);
      if (locations.length === 1) await selectLocation(pending.userId, locations[0]);
    } catch (err) {
      logger.warn(`[google] 매장 목록 조회 실패: ${err.message}`);
    }
    return pending.userId;
  }

  async function disconnect(userId) {
    const r = row(userId);
    if (!r) return status(userId);
    try {
      await fetch(`${REVOKE_URL}?token=${encodeURIComponent(sealer.open(r.refresh_token))}`, { method: 'POST', signal: AbortSignal.timeout(10000) });
    } catch {
      /* 권한 취소 실패해도 연결 정보는 지운다 */
    }
    db.prepare("DELETE FROM integrations WHERE user_id = ? AND provider = 'google'").run(userId);
    return status(userId);
  }

  /** 새 리뷰를 가져와 답글 초안을 만든다. 가져온 개수를 돌려준다. */
  async function sync(userId) {
    const r = row(userId);
    if (!r?.location_name) return 0;
    try {
      const data = await api(r, `${REVIEWS_API}/${r.account_name}/${r.location_name}/reviews?pageSize=50&orderBy=updateTime%20desc`);
      const since = Date.parse(r.connected_at) - IMPORT_WINDOW_MS;
      let imported = 0;
      for (const review of data.reviews || []) {
        if (review.reviewReply) continue; // 이미 답글이 있는 리뷰
        if (Date.parse(review.createTime) < since) continue;
        const exists = db.prepare('SELECT 1 FROM reviews WHERE user_id = ? AND external_id = ?').get(userId, review.name);
        if (exists) continue;
        await importReview(userId, {
          platform: 'google',
          rating: STARS[review.starRating] || 5,
          author: review.reviewer?.isAnonymous ? '' : review.reviewer?.displayName || '',
          menu: '',
          content: (review.comment || '').trim() || '(내용 없이 별점만 남긴 리뷰)',
          externalId: review.name,
          source: 'google',
        });
        imported += 1;
      }
      db.prepare("UPDATE integrations SET last_synced_at = ?, last_error = '' WHERE user_id = ? AND provider = 'google'").run(now(), userId);
      return imported;
    } catch (err) {
      db.prepare("UPDATE integrations SET last_synced_at = ?, last_error = ? WHERE user_id = ? AND provider = 'google'").run(
        now(),
        String(err.message).slice(0, 300),
        userId,
      );
      throw err;
    }
  }

  async function publishReply(userId, externalId, comment) {
    const r = row(userId);
    if (!r) throw new Error('Google 계정 연결이 끊어졌습니다. 내 정보에서 다시 연결해 주세요.');
    if (!externalId.startsWith(`${r.account_name}/${r.location_name}/reviews/`)) throw new Error('연결된 매장의 리뷰가 아닙니다.');
    await api(r, `${REVIEWS_API}/${externalId}/reply`, { method: 'PUT', body: JSON.stringify({ comment }) });
  }

  /** 서버가 주기적으로 호출: 연결된 매장의 새 리뷰를 15분마다 가져온다. */
  async function runDue() {
    if (!enabled) return 0;
    const cutoff = new Date(Date.now() - SYNC_INTERVAL_MS).toISOString();
    const rows = db
      .prepare("SELECT user_id FROM integrations WHERE provider = 'google' AND location_name != '' AND (last_synced_at IS NULL OR last_synced_at < ?)")
      .all(cutoff);
    let total = 0;
    for (const r of rows) {
      try {
        total += await sync(r.user_id);
      } catch (err) {
        logger.warn(`[google] 사용자 ${r.user_id} 리뷰 수집 실패: ${err.message}`);
      }
    }
    return total;
  }

  return { enabled, status, startUrl, callback, listLocations, selectLocation, disconnect, sync, publishReply, runDue };
}
