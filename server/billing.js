// 정기결제(빌링): 토스페이먼츠 자동결제 API 사용.
//  1) 브라우저에서 카드 등록(requestBillingAuth) → successUrl 로 authKey 가 돌아온다.
//  2) 서버가 authKey 로 빌링키를 발급받아 암호화해 저장한다.
//  3) 무료 체험 중이면 체험이 끝나는 날 첫 결제, 아니면 즉시 결제. 이후 매달 같은 날 자동 결제.
//  4) 해지는 버튼 하나: 다음 결제일부터 청구하지 않고, 이미 낸 기간은 끝까지 쓴다.
import crypto from 'node:crypto';
import { now } from './db.js';

const TOSS_API = 'https://api.tosspayments.com';
const MAX_FAILURES = 3;

export function addMonths(iso, months) {
  const d = new Date(iso);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  // 1월 31일 → 2월 28일처럼 달의 마지막 날을 넘지 않게 맞춘다.
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString();
}

export function createBilling({ db, config, sealer, fetch = globalThis.fetch, logger = console, planOf, notify }) {
  const enabled = Boolean(config.tossClientKey && config.tossSecretKey);
  const auth = `Basic ${Buffer.from(`${config.tossSecretKey}:`).toString('base64')}`;

  async function toss(path, body, idempotencyKey) {
    const headers = { Authorization: auth, 'Content-Type': 'application/json' };
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const res = await fetch(`${TOSS_API}${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.message || `결제 서버 오류 (HTTP ${res.status})`);
      err.code = data.code;
      throw err;
    }
    return data;
  }

  /** 토스 고객 키: 추측할 수 없고 계정마다 고정된 값. */
  function customerKeyFor(userId) {
    const mac = crypto.createHmac('sha256', config.tossSecretKey || 'disabled').update(`customer:${userId}`).digest('hex');
    return `rrh_${mac.slice(0, 40)}`;
  }

  function subscriptionOf(userId) {
    return db.prepare('SELECT * FROM subscriptions WHERE user_id = ?').get(userId) || null;
  }

  function status(user) {
    const sub = subscriptionOf(user.id);
    const payments = db
      .prepare('SELECT order_id, amount, status, message, created_at FROM payments WHERE user_id = ? ORDER BY id DESC LIMIT 24')
      .all(user.id)
      .map((p) => ({ orderId: p.order_id, amount: p.amount, status: p.status, message: p.message, createdAt: p.created_at }));
    return {
      enabled,
      clientKey: enabled ? config.tossClientKey : null,
      customerKey: enabled ? customerKeyFor(user.id) : null,
      amount: config.priceAmount,
      subscription: sub && {
        status: sub.status,
        cardLabel: sub.card_label,
        amount: sub.amount,
        nextBillingAt: sub.next_billing_at,
        cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
        failCount: sub.fail_count,
      },
      payments,
    };
  }

  async function charge(userId) {
    const sub = subscriptionOf(userId);
    if (!sub) throw new Error('구독 정보가 없습니다.');
    const user = db.prepare('SELECT id, email, plan, plan_until FROM users WHERE id = ?').get(userId);
    const orderId = `rrh-${userId}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    db.prepare("INSERT INTO payments (user_id, order_id, amount, status, created_at) VALUES (?, ?, ?, 'pending', ?)").run(
      userId,
      orderId,
      sub.amount,
      now(),
    );
    try {
      const payment = await toss(
        `/v1/billing/${encodeURIComponent(sealer.open(sub.billing_key))}`,
        {
          customerKey: sub.customer_key,
          amount: sub.amount,
          orderId,
          orderName: `${config.appName} 프로 1개월`,
          customerEmail: user.email,
        },
        orderId,
      );
      if (payment.status !== 'DONE') throw new Error(`결제가 완료되지 않았습니다 (${payment.status})`);
      const base =
        user.plan === 'pro' && user.plan_until && Date.parse(user.plan_until) > Date.now() ? user.plan_until : new Date().toISOString();
      const until = addMonths(base, 1);
      db.exec('BEGIN');
      db.prepare("UPDATE payments SET status = 'done', payment_key = ? WHERE order_id = ?").run(payment.paymentKey || '', orderId);
      db.prepare("UPDATE users SET plan = 'pro', plan_until = ? WHERE id = ?").run(until, userId);
      db.prepare("UPDATE subscriptions SET status = 'active', next_billing_at = ?, fail_count = 0, updated_at = ? WHERE user_id = ?").run(
        until,
        now(),
        userId,
      );
      db.exec('COMMIT');
      notify?.(userId);
      return { ok: true, until };
    } catch (err) {
      const failCount = sub.fail_count + 1;
      const retryAt = new Date(Date.now() + 86400000).toISOString();
      db.prepare("UPDATE payments SET status = 'failed', message = ? WHERE order_id = ?").run(String(err.message).slice(0, 300), orderId);
      db.prepare('UPDATE subscriptions SET status = ?, fail_count = ?, next_billing_at = ?, updated_at = ? WHERE user_id = ?').run(
        failCount >= MAX_FAILURES ? 'canceled' : 'past_due',
        failCount,
        retryAt,
        now(),
        userId,
      );
      logger.warn(`[billing] 사용자 ${userId} 결제 실패 (${failCount}회): ${err.message}`);
      notify?.(userId);
      return { ok: false, error: err.message };
    }
  }

  /** 카드 등록 완료(successUrl) 처리: 빌링키 발급 → 저장 → 필요하면 첫 결제. */
  async function confirm(user, { authKey, customerKey }) {
    if (!enabled) throw new Error('정기결제가 설정되어 있지 않습니다.');
    if (!authKey || customerKey !== customerKeyFor(user.id)) throw new Error('카드 등록 정보가 올바르지 않습니다.');
    const issued = await toss('/v1/billing/authorizations/issue', { authKey, customerKey });
    const cardNo = issued.cardNumber || issued.card?.number || '';
    const company = issued.cardCompany || issued.card?.issuerCode || '';
    const cardLabel = [company, cardNo.slice(-4) ? `끝자리 ${cardNo.slice(-4)}` : ''].filter(Boolean).join(' ');
    const existing = subscriptionOf(user.id);
    const plan = planOf(user);
    // 이미 낸 기간이 남아 있거나 무료 체험 중이면 그 기간이 끝나는 날 결제한다.
    let next = new Date().toISOString();
    if (existing && existing.status === 'active' && Date.parse(existing.next_billing_at) > Date.now()) next = existing.next_billing_at;
    else if ((plan.plan === 'trial' || plan.plan === 'pro') && plan.until) next = plan.until;
    const ts = now();
    db.prepare(
      `INSERT INTO subscriptions (user_id, status, customer_key, billing_key, card_label, amount, next_billing_at, cancel_at_period_end, fail_count, created_at, updated_at)
       VALUES (?, 'active', ?, ?, ?, ?, ?, 0, 0, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET status = 'active', customer_key = excluded.customer_key, billing_key = excluded.billing_key,
         card_label = excluded.card_label, amount = excluded.amount, next_billing_at = excluded.next_billing_at,
         cancel_at_period_end = 0, fail_count = 0, canceled_at = NULL, updated_at = excluded.updated_at`,
    ).run(user.id, customerKey, sealer.seal(issued.billingKey), cardLabel, config.priceAmount, next, ts, ts);
    let charged = null;
    if (Date.parse(next) <= Date.now() + 60000) charged = await charge(user.id);
    notify?.(user.id);
    return { ...status(user), charged };
  }

  function cancel(user) {
    const { changes } = db
      .prepare("UPDATE subscriptions SET cancel_at_period_end = 1, canceled_at = ?, updated_at = ? WHERE user_id = ? AND status != 'canceled'")
      .run(now(), now(), user.id);
    if (!changes) throw new Error('해지할 구독이 없습니다.');
    notify?.(user.id);
    return status(user);
  }

  function resume(user) {
    const { changes } = db
      .prepare("UPDATE subscriptions SET cancel_at_period_end = 0, canceled_at = NULL, updated_at = ? WHERE user_id = ? AND status != 'canceled'")
      .run(now(), user.id);
    if (!changes) throw new Error('다시 시작할 구독이 없습니다. 카드를 새로 등록해 주세요.');
    notify?.(user.id);
    return status(user);
  }

  /** 결제일이 된 구독을 처리한다 (서버가 주기적으로 호출). */
  async function runDue() {
    if (!enabled) return { charged: 0, ended: 0 };
    const due = db
      .prepare("SELECT user_id, cancel_at_period_end FROM subscriptions WHERE status IN ('active', 'past_due') AND next_billing_at <= ?")
      .all(new Date().toISOString());
    let charged = 0;
    let ended = 0;
    for (const sub of due) {
      if (sub.cancel_at_period_end) {
        db.prepare("UPDATE subscriptions SET status = 'canceled', updated_at = ? WHERE user_id = ?").run(now(), sub.user_id);
        ended += 1;
        notify?.(sub.user_id);
        continue;
      }
      if ((await charge(sub.user_id)).ok) charged += 1;
    }
    return { charged, ended };
  }

  return { enabled, status, confirm, cancel, resume, runDue, charge, customerKeyFor };
}
