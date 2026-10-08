// 사업 계획서(10. 소상공인 리뷰 답글 마이크로 SaaS) 기능 테스트:
// 안전 필터, 말투 학습(수정률), 월간 리포트, 정기결제, Google 공식 API 연동, 개인정보 보관 기간.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../server/index.js';
import { addMonths } from '../server/billing.js';
import { editRate } from '../server/report.js';
import { checkReply, maskPII } from '../server/safety.js';

let base;
let app;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rrh-plan-'));
const calls = [];
const fake = { tossFail: false, googleReviews: [] };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// 토스페이먼츠·Google API 를 흉내 내는 가짜 fetch
async function fakeFetch(url, init = {}) {
  const u = String(url);
  calls.push({ url: u, method: init.method || 'GET', body: init.body });
  if (u.endsWith('/v1/billing/authorizations/issue')) {
    return json({ billingKey: 'bk_test_123', customerKey: JSON.parse(init.body).customerKey, cardCompany: '신한', cardNumber: '12345678****1234' });
  }
  if (u.includes('/v1/billing/')) {
    if (fake.tossFail) return json({ code: 'REJECT_CARD_COMPANY', message: '카드사 거절' }, 400);
    return json({ status: 'DONE', paymentKey: `pk_${calls.length}` });
  }
  if (u === 'https://oauth2.googleapis.com/token') return json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
  if (u.startsWith('https://oauth2.googleapis.com/revoke')) return json({});
  if (u === 'https://mybusinessaccountmanagement.googleapis.com/v1/accounts') return json({ accounts: [{ name: 'accounts/1' }] });
  if (u.startsWith('https://mybusinessbusinessinformation.googleapis.com/v1/accounts/1/locations')) {
    return json({ locations: [{ name: 'locations/9', title: '행복김밥 역삼점' }] });
  }
  if (u.startsWith('https://mybusiness.googleapis.com/v4/accounts/1/locations/9/reviews?')) return json({ reviews: fake.googleReviews });
  if (u.endsWith('/reply') && init.method === 'PUT') return json({ comment: JSON.parse(init.body).comment });
  return json({ error: { message: `unexpected ${u}` } }, 404);
}

async function call(method, url, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const data = await res.json().catch(() => null);
  return { status: res.status, data, headers: res.headers };
}

async function signup(email) {
  const r = await call('POST', '/api/auth/signup', { body: { email, password: 'password123', agree: true } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.token;
}

before(async () => {
  app = createApp({
    dataDir,
    anthropicApiKey: '',
    adminEmails: ['admin@test.kr'],
    port: 0,
    jobs: false,
    fetch: fakeFetch,
    tossClientKey: 'test_ck_x',
    tossSecretKey: 'test_sk_x',
    googleClientId: 'gid',
    googleClientSecret: 'gsecret',
    publicUrl: 'https://review.example.com',
    retentionDays: 365,
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => app.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('안전 필터', () => {
  test('전화번호·주소·이메일은 가리고, 과장·비난·금지어는 경고', () => {
    assert.equal(maskPII('연락 010-1234-5678, 역삼로 123').text, '연락 [개인정보], [개인정보]');
    assert.equal(maskPII('김밥으로 2줄 시켰어요').text, '김밥으로 2줄 시켰어요');
    const r = checkReply('국내 최고 맛집! 진상 고객은 사절. 서비스 드릴게요', { avoid_words: '서비스 드릴게요' });
    assert.equal(r.warnings.length, 3);
  });

  test('가입은 약관 동의가 있어야 한다', async () => {
    const r = await call('POST', '/api/auth/signup', { body: { email: 'noagree@test.kr', password: 'password123' } });
    assert.equal(r.status, 400);
  });

  test('주의 표현이 있으면 승인 전에 확인을 받고, 개인정보는 저장 시 가린다', async () => {
    const token = await signup('safe@test.kr');
    const { data } = await call('POST', '/api/reviews', { token, body: { platform: 'baemin', rating: 5, content: '맛있어요' } });
    const id = data.review.id;
    const risky = '감사합니다! 저희는 세계 최고 맛집이에요. 문의는 010-9999-8888';
    const first = await call('PATCH', `/api/reviews/${id}`, { token, body: { finalReply: risky, status: 'approved' } });
    assert.equal(first.status, 409);
    assert.ok(first.data.warnings.some((w) => w.includes('세계 최고')));
    const ok = await call('PATCH', `/api/reviews/${id}`, { token, body: { finalReply: risky, status: 'approved', confirmWarnings: true } });
    assert.equal(ok.status, 200);
    assert.ok(!ok.data.finalReply.includes('010-9999-8888'));
    assert.ok(ok.data.finalReply.includes('[개인정보]'));
  });
});

describe('말투 학습과 수정률', () => {
  test('승인하면 초안 대비 수정률이 기록되고, 학습 예시 수가 늘어난다', async () => {
    const token = await signup('learn@test.kr');
    await call('PUT', '/api/store', { token, body: { name: '행복김밥', owner_title: '사장', signature_menus: '참치김밥, 라볶이' } });
    const { data } = await call('POST', '/api/reviews', { token, body: { platform: 'naver', rating: 5, content: '김밥 맛있어요' } });
    const draft = data.review.drafts[0].text;
    assert.ok(draft.includes('행복김밥 사장'), draft);
    assert.ok(draft.includes('참치김밥'), '대표 메뉴를 권한다');
    const same = await call('PATCH', `/api/reviews/${data.review.id}`, { token, body: { finalReply: draft, status: 'approved' } });
    assert.equal(same.data.editRate, 0);

    const { data: d2 } = await call('POST', '/api/reviews', { token, body: { platform: 'naver', rating: 4, content: '맛있지만 조금 짜요' } });
    const edited = await call('PATCH', `/api/reviews/${d2.review.id}`, { token, body: { finalReply: '감사합니다. 간을 다시 볼게요.', status: 'posted' } });
    assert.ok(edited.data.editRate > 0.5);
    const store = await call('GET', '/api/store', { token });
    assert.equal(store.data.learnedExamples, 2);
  });

  test('수정률 계산', () => {
    assert.equal(editRate('안녕하세요', '안녕하세요'), 0);
    assert.equal(editRate('abcd', 'abce'), 0.25);
  });
});

describe('월간 리포트', () => {
  test('불만 상위, 칭찬 포인트, 별점 추이, 개선 힌트', async () => {
    const token = await signup('report@test.kr');
    const reviews = [
      [2, '배달이 너무 늦고 다 식었어요'],
      [1, '배달이 한참 걸렸어요. 늦어요'],
      [5, '맛있어요 또 시킬게요'],
      [4, '양이 많고 푸짐해요'],
    ];
    for (const [rating, content] of reviews) {
      await call('POST', '/api/reviews', { token, body: { platform: 'baemin', rating, content } });
    }
    const { data } = await call('GET', '/api/report', { token });
    assert.equal(data.total, 4);
    assert.equal(data.topComplaints[0].label, '배달 지연');
    assert.equal(data.topComplaints[0].count, 2);
    assert.ok(data.topPraises.length >= 2);
    assert.equal(data.trend.length, 6);
    assert.ok(data.hints.some((h) => h.startsWith('배달 지연')));
    assert.equal((await call('GET', '/api/report?month=2026-13', { token })).status, 400);
  });

  test('관리자 파일럿 지표', async () => {
    const admin = await signup('admin@test.kr');
    const { data } = await call('GET', '/api/admin/metrics', { token: admin });
    assert.equal(data.weeks.length, 8);
    const learn = data.stores.find((s) => s.email === 'learn@test.kr');
    assert.equal(learn.activeWeeks, 1);
    assert.equal(learn.usableRate, 50);
    assert.ok('churnRate' in data.business);
  });
});

describe('정기결제 (토스페이먼츠)', () => {
  test('체험 중 카드 등록 → 체험 종료일에 첫 결제 → 해지 → 기간 끝에 종료', async () => {
    const token = await signup('pay@test.kr');
    const info = (await call('GET', '/api/billing', { token })).data;
    assert.equal(info.enabled, true);
    assert.equal(info.amount, 9900);
    assert.equal(info.plan.plan, 'trial');

    const bad = await call('POST', '/api/billing/confirm', { token, body: { authKey: 'a', customerKey: 'someone-else' } });
    assert.equal(bad.status, 400);

    const confirmed = await call('POST', '/api/billing/confirm', { token, body: { authKey: 'auth_1', customerKey: info.customerKey } });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data));
    assert.equal(confirmed.data.charged, null, '체험 중에는 바로 결제하지 않는다');
    assert.equal(confirmed.data.subscription.nextBillingAt, info.plan.until);
    assert.ok(confirmed.data.subscription.cardLabel.includes('1234'));
    const stored = app.db.prepare('SELECT billing_key FROM subscriptions').get();
    assert.ok(!stored.billing_key.includes('bk_test_123'), '빌링키는 암호화해서 저장한다');

    // 결제일이 되었다고 가정
    const userId = app.db.prepare("SELECT id FROM users WHERE email = 'pay@test.kr'").get().id;
    app.db.prepare('UPDATE subscriptions SET next_billing_at = ? WHERE user_id = ?').run(new Date(Date.now() - 1000).toISOString(), userId);
    const run = await app.runJobs();
    assert.equal(run.billing.charged, 1);
    let me = (await call('GET', '/api/me', { token })).data;
    assert.equal(me.plan.plan, 'pro');
    const payments = (await call('GET', '/api/billing', { token })).data.payments;
    assert.equal(payments[0].status, 'done');
    assert.equal(payments[0].amount, 9900);

    const canceled = await call('POST', '/api/billing/cancel', { token });
    assert.equal(canceled.data.subscription.cancelAtPeriodEnd, true);
    const resumed = await call('POST', '/api/billing/resume', { token });
    assert.equal(resumed.data.subscription.cancelAtPeriodEnd, false);
    await call('POST', '/api/billing/cancel', { token });
    app.db.prepare('UPDATE subscriptions SET next_billing_at = ? WHERE user_id = ?').run(new Date(Date.now() - 1000).toISOString(), userId);
    const ended = await app.runJobs();
    assert.equal(ended.billing.ended, 1);
    me = (await call('GET', '/api/me', { token })).data;
    assert.equal(me.plan.plan, 'pro', '이미 낸 기간은 끝까지 쓴다');
    assert.equal((await call('GET', '/api/billing', { token })).data.subscription.status, 'canceled');
  });

  test('결제 실패는 다음 날 다시 시도하고, 3번 실패하면 멈춘다', async () => {
    const token = await signup('fail@test.kr');
    const userId = app.db.prepare("SELECT id FROM users WHERE email = 'fail@test.kr'").get().id;
    app.db.prepare("UPDATE users SET plan = 'free' WHERE id = ?").run(userId); // 체험 종료 상태
    const info = (await call('GET', '/api/billing', { token })).data;
    fake.tossFail = true;
    const r = await call('POST', '/api/billing/confirm', { token, body: { authKey: 'auth_2', customerKey: info.customerKey } });
    assert.equal(r.data.charged.ok, false);
    assert.equal(r.data.subscription.status, 'past_due');
    for (let i = 0; i < 2; i++) {
      app.db.prepare('UPDATE subscriptions SET next_billing_at = ? WHERE user_id = ?').run(new Date(Date.now() - 1000).toISOString(), userId);
      await app.runJobs();
    }
    assert.equal((await call('GET', '/api/billing', { token })).data.subscription.status, 'canceled');
    fake.tossFail = false;
  });

  test('월 더하기는 말일을 넘지 않는다', () => {
    assert.equal(addMonths('2026-01-31T00:00:00.000Z', 1), '2026-02-28T00:00:00.000Z');
    assert.equal(addMonths('2026-03-15T09:00:00.000Z', 1), '2026-04-15T09:00:00.000Z');
  });

  test('카드 등록 화면은 토스 스크립트만 추가로 허용한다', async () => {
    const res = await fetch(`${base}/billing.html`);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-security-policy').includes('https://js.tosspayments.com'));
    const app2 = await fetch(`${base}/`);
    assert.ok(!app2.headers.get('content-security-policy').includes('tosspayments'));
  });
});

describe('Google 비즈니스 프로필 연동', () => {
  test('연결 → 새 리뷰 자동 수집 → 승인 1번으로 게시', async () => {
    const token = await signup('google@test.kr');
    const start = await call('POST', '/api/integrations/google/start', { token });
    const authUrl = new URL(start.data.url);
    assert.equal(authUrl.searchParams.get('redirect_uri'), 'https://review.example.com/api/integrations/google/callback');
    assert.equal(authUrl.searchParams.get('scope'), 'https://www.googleapis.com/auth/business.manage');

    const cb = await call('GET', `/api/integrations/google/callback?code=c1&state=${authUrl.searchParams.get('state')}`);
    assert.equal(cb.status, 303);
    assert.equal(cb.headers.get('location'), '/#/account?google=connected');
    const replay = await call('GET', `/api/integrations/google/callback?code=c1&state=${authUrl.searchParams.get('state')}`);
    assert.equal(replay.headers.get('location'), '/#/account?google=failed', 'state 는 한 번만 쓸 수 있다');

    const status = (await call('GET', '/api/integrations', { token })).data.google;
    assert.equal(status.connected, true);
    assert.equal(status.locationTitle, '행복김밥 역삼점');

    fake.googleReviews = [
      { name: 'accounts/1/locations/9/reviews/r1', starRating: 'FOUR', comment: '깔끔하고 맛있어요', reviewer: { displayName: '김손님' }, createTime: new Date().toISOString() },
      { name: 'accounts/1/locations/9/reviews/r2', starRating: 'FIVE', comment: '좋아요', reviewer: { displayName: '이손님' }, createTime: new Date().toISOString(), reviewReply: { comment: '감사합니다' } },
      { name: 'accounts/1/locations/9/reviews/r3', starRating: 'ONE', reviewer: { isAnonymous: true }, createTime: new Date().toISOString() },
    ];
    const synced = await call('POST', '/api/integrations/google/sync', { token });
    assert.equal(synced.data.imported, 2, '답글이 이미 있는 리뷰는 가져오지 않는다');
    assert.equal((await call('POST', '/api/integrations/google/sync', { token })).data.imported, 0, '같은 리뷰는 두 번 가져오지 않는다');

    const list = (await call('GET', '/api/reviews', { token })).data;
    const r1 = list.find((r) => r.content === '깔끔하고 맛있어요');
    assert.equal(r1.platform, 'google');
    assert.equal(r1.rating, 4);
    assert.equal(r1.canPublish, true);
    assert.equal(r1.drafts.length, 2);

    const published = await call('POST', `/api/reviews/${r1.id}/publish`, { token, body: { finalReply: '감사합니다! 또 오세요.' } });
    assert.equal(published.status, 200, JSON.stringify(published.data));
    assert.equal(published.data.status, 'posted');
    const put = calls.find((c) => c.method === 'PUT');
    assert.equal(put.url, 'https://mybusiness.googleapis.com/v4/accounts/1/locations/9/reviews/r1/reply');
    assert.equal(JSON.parse(put.body).comment, '감사합니다! 또 오세요.');

    const pasted = (await call('POST', '/api/reviews', { token, body: { platform: 'baemin', rating: 5, content: '굿' } })).data.review;
    assert.equal((await call('POST', `/api/reviews/${pasted.id}/publish`, { token, body: {} })).status, 400);

    const off = await call('DELETE', '/api/integrations/google', { token });
    assert.equal(off.data.connected, false);
  });
});

describe('개인정보·기타', () => {
  test('보관 기간이 지난 리뷰는 자동 삭제', async () => {
    const token = await signup('old@test.kr');
    const { data } = await call('POST', '/api/reviews', { token, body: { platform: 'baemin', rating: 5, content: '오래된 리뷰' } });
    app.db.prepare('UPDATE reviews SET created_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', data.review.id);
    const out = await app.runJobs({ forceRetention: true });
    assert.ok(out.purged >= 1);
    assert.equal((await call('GET', `/api/reviews/${data.review.id}`, { token })).status, 404);
  });

  test('회원 탈퇴는 비밀번호 확인 후 모든 데이터를 지운다', async () => {
    const token = await signup('bye@test.kr');
    assert.equal((await call('DELETE', '/api/me', { token, body: { password: 'wrong-pass' } })).status, 400);
    assert.equal((await call('DELETE', '/api/me', { token, body: { password: 'password123' } })).status, 200);
    assert.equal((await call('GET', '/api/me', { token })).status, 401);
  });

  test('공개 설정과 공유하기 대체 경로', async () => {
    const { data } = await call('GET', '/api/public/config');
    assert.equal(data.trialDays, 30);
    assert.equal(data.billingEnabled, true);
    const shared = await fetch(`${base}/share-target`, { method: 'POST', body: 'text=hi', redirect: 'manual' });
    assert.equal(shared.status, 303);
  });
});
