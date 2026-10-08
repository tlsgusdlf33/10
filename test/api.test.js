import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../server/index.js';
import { compareVersions } from '../scripts/updater.js';

let base;
let app;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rrh-test-'));

async function call(method, url, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function signup(email, password = 'password123', device = 'test') {
  const r = await call('POST', '/api/auth/signup', { body: { email, password, device, agree: true } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.token;
}

before(async () => {
  app = createApp({ dataDir, anthropicApiKey: '', adminEmails: ['admin@test.kr'], freeMonthlyLimit: 2, port: 0, jobs: false });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => app.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('계정', () => {
  test('가입, 중복 가입 거부, 로그인, 잘못된 비밀번호', async () => {
    await signup('owner@test.kr');
    const dup = await call('POST', '/api/auth/signup', { body: { email: 'OWNER@test.kr', password: 'password123', agree: true } });
    assert.equal(dup.status, 409);
    const bad = await call('POST', '/api/auth/login', { body: { email: 'owner@test.kr', password: 'wrongpass1' } });
    assert.equal(bad.status, 401);
    const ok = await call('POST', '/api/auth/login', { body: { email: 'owner@test.kr', password: 'password123' } });
    assert.equal(ok.status, 200);
    assert.ok(ok.data.token);
  });

  test('짧은 비밀번호와 잘못된 이메일은 거부', async () => {
    assert.equal((await call('POST', '/api/auth/signup', { body: { email: 'x@test.kr', password: 'short', agree: true } })).status, 400);
    assert.equal((await call('POST', '/api/auth/signup', { body: { email: 'not-an-email', password: 'password123', agree: true } })).status, 400);
  });

  test('로그인 없이 API 접근 불가', async () => {
    assert.equal((await call('GET', '/api/me')).status, 401);
    assert.equal((await call('GET', '/api/reviews', { token: 'bogus' })).status, 401);
  });
});

describe('리뷰 답글 흐름', () => {
  let token;
  before(async () => {
    token = await signup('shop@test.kr');
    const store = await call('PUT', '/api/store', { token, body: { name: '행복김밥', tone: 'polite', signature: '- 사장 드림', unknown: 'x' } });
    assert.equal(store.status, 200);
    assert.equal(store.data.name, '행복김밥');
    assert.equal(store.data.tone, 'polite');
  });

  test('리뷰를 넣으면 초안 2개가 생기고 승인·게시 상태로 바뀐다', async () => {
    const created = await call('POST', '/api/reviews', {
      token,
      body: { platform: 'baemin', rating: 5, content: '김밥이 정말 맛있어요! 또 시킬게요', author: '초코', menu: '참치김밥' },
    });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    const review = created.data.review;
    assert.equal(review.drafts.length, 2);
    assert.equal(review.status, 'draft');
    assert.equal(review.sentiment, 'positive');
    assert.ok(review.drafts[0].text.includes('행복김밥'));
    assert.ok(review.drafts[0].text.endsWith('- 사장 드림'));

    const approved = await call('PATCH', `/api/reviews/${review.id}`, { token, body: { finalReply: '감사합니다!', status: 'approved' } });
    assert.equal(approved.data.status, 'approved');
    assert.equal(approved.data.finalReply, '감사합니다!');
    const posted = await call('PATCH', `/api/reviews/${review.id}`, { token, body: { status: 'posted' } });
    assert.equal(posted.data.status, 'posted');
    assert.ok(posted.data.postedAt);

    const list = await call('GET', '/api/reviews?status=posted', { token });
    assert.equal(list.data.length, 1);
    const search = await call('GET', '/api/reviews?q=%EC%B4%88%EC%BD%94', { token }); // "초코"
    assert.equal(search.data.length, 1);
  });

  test('악성 리뷰는 대응 문구와 조치 안내를 따로 준다', async () => {
    const r = await call('POST', '/api/reviews', { token, body: { platform: 'naver', rating: 1, content: '시발 맛 최악 망해라' } });
    assert.equal(r.status, 200);
    assert.equal(r.data.review.isMalicious, true);
    assert.ok(r.data.review.calmReply.length > 20);
    assert.ok(r.data.review.guidance.includes('신고'));
    assert.equal(r.data.review.finalReply, r.data.review.calmReply);
    assert.ok(!r.data.review.drafts[0].text.includes('하이요'));
  });

  test('입력값 검증', async () => {
    assert.equal((await call('POST', '/api/reviews', { token, body: { platform: 'nope', rating: 5, content: 'a' } })).status, 400);
    assert.equal((await call('POST', '/api/reviews', { token, body: { platform: 'baemin', rating: 7, content: 'a' } })).status, 400);
    assert.equal((await call('POST', '/api/reviews', { token, body: { platform: 'baemin', rating: 5, content: '   ' } })).status, 400);
    assert.equal((await call('PATCH', '/api/reviews/1', { token, body: { status: 'weird' } })).status, 400);
  });

  test('다른 계정의 리뷰는 볼 수 없다', async () => {
    const other = await signup('other@test.kr');
    const mine = await call('GET', '/api/reviews', { token });
    const id = mine.data[0].id;
    assert.equal((await call('GET', `/api/reviews/${id}`, { token: other })).status, 404);
    assert.equal((await call('DELETE', `/api/reviews/${id}`, { token: other })).status, 404);
    assert.equal((await call('GET', '/api/reviews', { token: other })).data.length, 0);
  });

  test('통계', async () => {
    const s = await call('GET', '/api/stats', { token });
    assert.equal(s.data.month.total, 2);
    assert.equal(s.data.counts.posted, 1);
    assert.equal(s.data.month.malicious, 1);
  });
});

describe('기기 간 동기화', () => {
  test('PC 에서 바꾸면 같은 계정의 휴대폰 스트림으로 변경 알림이 온다', async () => {
    const pc = await signup('sync@test.kr', 'password123', 'Windows PC');
    const phone = (await call('POST', '/api/auth/login', { body: { email: 'sync@test.kr', password: 'password123', device: 'Android' } })).data.token;
    const controller = new AbortController();
    const res = await fetch(`${base}/api/events`, { headers: { Authorization: `Bearer ${phone}` }, signal: controller.signal });
    assert.equal(res.status, 200);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let text = '';
    const waitFor = async (needle) => {
      while (!text.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) throw new Error('stream ended');
        text += value;
      }
    };
    await waitFor('event: hello');
    await call('PUT', '/api/store', { token: pc, body: { name: '동기화식당' } });
    await waitFor('"entity":"store"');
    const phoneStore = await call('GET', '/api/store', { token: phone });
    assert.equal(phoneStore.data.name, '동기화식당');

    const sessions = await call('GET', '/api/sessions', { token: pc });
    assert.equal(sessions.data.length, 2);
    assert.equal(sessions.data.filter((s) => s.current).length, 1);
    controller.abort();
  });

  test('다른 기기 로그아웃', async () => {
    const pc = await signup('devices@test.kr');
    const phone = (await call('POST', '/api/auth/login', { body: { email: 'devices@test.kr', password: 'password123' } })).data.token;
    const sessions = (await call('GET', '/api/sessions', { token: pc })).data;
    const phoneSession = sessions.find((s) => !s.current);
    await call('DELETE', `/api/sessions/${phoneSession.id}`, { token: pc });
    assert.equal((await call('GET', '/api/me', { token: phone })).status, 401);
    assert.equal((await call('GET', '/api/me', { token: pc })).status, 200);
  });
});

describe('요금제', () => {
  test('무료 요금제는 월 사용량 제한, 관리자가 프로로 바꾸면 해제', async () => {
    const token = await signup('free@test.kr');
    const admin = await signup('admin@test.kr');
    const users = await call('GET', '/api/admin/users', { token: admin });
    const target = users.data.find((u) => u.email === 'free@test.kr');
    assert.equal(target.plan.plan, 'trial');
    await call('PATCH', `/api/admin/users/${target.id}`, { token: admin, body: { plan: 'free' } });

    const body = { platform: 'baemin', rating: 4, content: '맛있어요' };
    assert.equal((await call('POST', '/api/reviews', { token, body })).status, 200);
    assert.equal((await call('POST', '/api/reviews', { token, body })).status, 200);
    assert.equal((await call('POST', '/api/reviews', { token, body })).status, 402);

    await call('PATCH', `/api/admin/users/${target.id}`, { token: admin, body: { plan: 'pro', months: 1 } });
    const me = await call('GET', '/api/me', { token });
    assert.equal(me.data.plan.plan, 'pro');
    assert.ok(me.data.plan.until);
    assert.equal((await call('POST', '/api/reviews', { token, body })).status, 200);
  });

  test('관리자가 아니면 관리 API 를 쓸 수 없다', async () => {
    const token = await signup('nobody@test.kr');
    assert.equal((await call('GET', '/api/admin/users', { token })).status, 403);
    assert.equal((await call('POST', '/api/system/update', { token })).status, 403);
  });
});

describe('웹앱 제공', () => {
  test('index, 매니페스트, 서비스워커 버전 주입', async () => {
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.ok(index.headers.get('content-security-policy'));
    const sw = await (await fetch(`${base}/sw.js`)).text();
    assert.ok(!sw.includes('__APP_VERSION__'));
    assert.ok(sw.includes(`rrh-shell-`));
    const manifest = await (await fetch(`${base}/manifest.webmanifest`)).json();
    assert.equal(manifest.display, 'standalone');
  });

  test('폴더 밖 파일 접근 차단', async () => {
    const res = await fetch(`${base}/%2e%2e/package.json`);
    assert.equal(res.status, 404);
    const res2 = await fetch(`${base}/..%2fserver%2fdb.js`);
    assert.equal(res2.status, 404);
  });

  test('버전 비교', () => {
    assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
    assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
    assert.equal(compareVersions('1.0.0', '1.0.1'), -1);
  });
});
