// 월간 리뷰 리포트와 파일럿 지표.
// - 사장님용: 불만 키워드 상위 5개, 칭찬 포인트, 별점 추이, 운영 개선 힌트 (답글 외의 가치 → 해지 방지)
// - 운영자용: 매장별 주간 사용 횟수, 답글 수정률(그대로 쓸 만한 비율), 유료 매장 수·이탈률
import { COMPLAINT_TAGS, PRAISE_TAGS } from './templates.js';

export const MINUTES_SAVED_PER_REPLY = 3;
const USABLE_EDIT_RATE = 0.15; // 15% 이하로만 고쳤으면 "그대로 쓸 만한 초안"으로 본다

const HINTS = {
  '배달 지연': '주문이 몰리는 시간대에 조리 순서와 배달 대행 배차를 점검하고, 예상 시간을 넉넉히 안내해 보세요.',
  '음식 온도': '보온 포장재를 쓰고, 조리 완료부터 픽업까지 기다리는 시간을 줄여 보세요.',
  맛: '같은 메뉴 불만이 반복되는지 확인하고, 간·레시피를 계량해 표준화해 보세요.',
  양: '메뉴 사진·설명에 실제 양을 정확히 적어 기대치를 맞춰 보세요.',
  이물질: '위생모·장갑 착용과 조리대 점검을 매일 체크리스트로 확인해 보세요.',
  위생: '위생모·장갑 착용과 조리대 점검을 매일 체크리스트로 확인해 보세요.',
  누락: '포장 마감 전에 주문서와 대조해 체크하는 단계를 하나 추가해 보세요.',
  '응대 태도': '전화·포장 응대 문구를 짧게 정해 두고 직원과 함께 연습해 보세요.',
  포장: '국물·소스 메뉴는 실링·랩 포장을 한 번 더 하고 용기를 점검해 보세요.',
  가격: '가격 대비 만족을 높일 세트 구성이나 소량 메뉴를 검토해 보세요.',
};

/** 0(그대로 사용) ~ 1(완전히 새로 씀) 사이의 수정 정도. */
export function editRate(original, edited) {
  const a = String(original || '');
  const b = String(edited || '');
  if (!a && !b) return 0;
  const prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return Math.round((prev[b.length] / Math.max(a.length, b.length)) * 1000) / 1000;
}

/** 승인한 답글과 가장 가까운 초안을 찾아 수정률을 계산한다. */
export function measureEdit(candidates, finalReply) {
  let best = { draft: '', rate: 1 };
  for (const text of candidates.filter(Boolean)) {
    const rate = editRate(text, finalReply);
    if (rate < best.rate) best = { draft: text, rate };
  }
  return best;
}

export function tagsOf(row) {
  let meta = {};
  try {
    meta = JSON.parse(row.drafts || '{}');
  } catch {
    /* 깨진 데이터는 무시 */
  }
  const keyPoints = meta.keyPoints || [];
  return {
    praises: meta.praises || keyPoints.filter((k) => PRAISE_TAGS.includes(k)),
    complaints: meta.complaints || keyPoints.filter((k) => COMPLAINT_TAGS.includes(k)),
  };
}

function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 1));
  return [start.toISOString(), end.toISOString()];
}

function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

function topCounts(list, limit) {
  const counts = new Map();
  for (const item of list) counts.set(item, (counts.get(item) || 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([label, count]) => ({ label, count }));
}

export function buildMonthlyReport(db, userId, month) {
  const [from, to] = monthRange(month);
  const rows = db
    .prepare('SELECT rating, status, is_malicious, drafts, edit_rate FROM reviews WHERE user_id = ? AND created_at >= ? AND created_at < ?')
    .all(userId, from, to);
  const [pFrom, pTo] = monthRange(shiftMonth(month, -1));
  const prevRows = db.prepare('SELECT drafts FROM reviews WHERE user_id = ? AND created_at >= ? AND created_at < ?').all(userId, pFrom, pTo);

  const complaints = rows.flatMap((r) => tagsOf(r).complaints);
  const praises = rows.flatMap((r) => tagsOf(r).praises);
  const prevComplaintCounts = topCounts(
    prevRows.flatMap((r) => tagsOf(r).complaints),
    100,
  ).reduce((acc, c) => ({ ...acc, [c.label]: c.count }), {});
  const topComplaints = topCounts(complaints, 5).map((c) => ({ ...c, prev: prevComplaintCounts[c.label] || 0 }));
  const topPraises = topCounts(praises, 5);

  const ratingDist = [1, 2, 3, 4, 5].map((s) => rows.filter((r) => r.rating === s).length);
  const answered = rows.filter((r) => r.status === 'approved' || r.status === 'posted').length;
  const edits = rows.map((r) => r.edit_rate).filter((v) => typeof v === 'number');

  const trend = [];
  for (let i = 5; i >= 0; i--) {
    const m = shiftMonth(month, -i);
    const [f, t] = monthRange(m);
    const agg = db
      .prepare('SELECT COUNT(*) AS n, AVG(rating) AS avg FROM reviews WHERE user_id = ? AND created_at >= ? AND created_at < ?')
      .get(userId, f, t);
    trend.push({ month: m, count: agg.n, avgRating: agg.avg ? Math.round(agg.avg * 10) / 10 : null });
  }

  const hints = topComplaints.filter((c) => HINTS[c.label]).slice(0, 3).map((c) => `${c.label}: ${HINTS[c.label]}`);
  if (topPraises[0]) hints.push(`칭찬이 가장 많은 "${topPraises[0].label}"을(를) 가게 소개와 메뉴 설명에 강조해 보세요.`);

  return {
    month,
    total: rows.length,
    avgRating: rows.length ? Math.round((rows.reduce((s, r) => s + r.rating, 0) / rows.length) * 10) / 10 : null,
    ratingDist,
    answered,
    responseRate: rows.length ? Math.round((answered / rows.length) * 100) : 0,
    malicious: rows.filter((r) => r.is_malicious).length,
    topComplaints,
    topPraises,
    trend,
    avgEditRate: edits.length ? Math.round((edits.reduce((a, b) => a + b, 0) / edits.length) * 100) : null,
    minutesSaved: rows.length * MINUTES_SAVED_PER_REPLY,
    hints,
  };
}

function weekStart(date) {
  const d = new Date(date);
  const day = (d.getUTCDay() + 6) % 7; // 월요일 시작
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

/** 운영자용 파일럿 지표: 매장별 최근 8주 사용량과 수정률. */
export function buildPilotMetrics(db, { weeks = 8, priceAmount }) {
  const since = new Date(Date.now() - weeks * 7 * 86400000);
  const sinceWeek = weekStart(since);
  const users = db
    .prepare('SELECT u.id, u.email, u.plan, u.plan_until, s.name AS store FROM users u LEFT JOIN stores s ON s.user_id = u.id ORDER BY u.id')
    .all();
  const weekKeys = [];
  for (let i = weeks - 1; i >= 0; i--) weekKeys.push(weekStart(new Date(Date.now() - i * 7 * 86400000)));

  const stores = users.map((u) => {
    const rows = db
      .prepare('SELECT created_at, edit_rate FROM reviews WHERE user_id = ? AND created_at >= ?')
      .all(u.id, `${sinceWeek}T00:00:00.000Z`);
    const byWeek = Object.fromEntries(weekKeys.map((k) => [k, { count: 0, edits: [] }]));
    for (const r of rows) {
      const k = weekStart(r.created_at);
      if (!byWeek[k]) continue;
      byWeek[k].count += 1;
      if (typeof r.edit_rate === 'number') byWeek[k].edits.push(r.edit_rate);
    }
    const series = weekKeys.map((k) => {
      const w = byWeek[k];
      const avg = w.edits.length ? w.edits.reduce((a, b) => a + b, 0) / w.edits.length : null;
      return {
        week: k,
        reviews: w.count,
        editRate: avg === null ? null : Math.round(avg * 100),
        usable: w.edits.length ? Math.round((w.edits.filter((e) => e <= USABLE_EDIT_RATE).length / w.edits.length) * 100) : null,
      };
    });
    const withEdits = series.filter((s) => s.editRate !== null);
    const allEdits = rows.map((r) => r.edit_rate).filter((v) => typeof v === 'number');
    return {
      id: u.id,
      email: u.email,
      store: u.store || '',
      activeWeeks: series.filter((s) => s.reviews > 0).length,
      series,
      firstEditRate: withEdits[0]?.editRate ?? null,
      lastEditRate: withEdits.at(-1)?.editRate ?? null,
      usableRate: allEdits.length ? Math.round((allEdits.filter((e) => e <= USABLE_EDIT_RATE).length / allEdits.length) * 100) : null,
    };
  });

  const nowIso = new Date().toISOString();
  const monthStart = `${nowIso.slice(0, 7)}-01T00:00:00.000Z`;
  const paying = db.prepare("SELECT COUNT(*) AS n FROM users WHERE plan = 'pro' AND (plan_until IS NULL OR plan_until > ?)").get(nowIso).n;
  const canceledThisMonth = db
    .prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE canceled_at IS NOT NULL AND canceled_at >= ?")
    .get(monthStart).n;
  const activeSubs = db.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE status IN ('active', 'past_due') AND cancel_at_period_end = 0").get().n;
  const base = activeSubs + canceledThisMonth;
  return {
    weeks: weekKeys,
    stores,
    business: {
      payingStores: paying,
      mrr: paying * priceAmount,
      activeSubscriptions: activeSubs,
      canceledThisMonth,
      churnRate: base ? Math.round((canceledThisMonth / base) * 1000) / 10 : 0,
    },
  };
}
