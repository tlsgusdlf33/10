// 리뷰답글 도우미 웹앱 (PC·휴대폰 공용). 빌드 과정 없이 브라우저에서 바로 실행된다.
// 사용자 입력은 항상 textContent 로만 화면에 넣는다 (innerHTML 사용 금지).

const PLATFORMS = [
  { id: 'baemin', name: '배민', center: 'https://self.baemin.com' },
  { id: 'coupangeats', name: '쿠팡이츠', center: 'https://store.coupangeats.com' },
  { id: 'yogiyo', name: '요기요', center: 'https://ceo.yogiyo.co.kr' },
  { id: 'naver', name: '네이버', center: 'https://new.smartplace.naver.com' },
  { id: 'kakao', name: '카카오맵', center: '' },
  { id: 'google', name: '구글', center: 'https://business.google.com' },
  { id: 'etc', name: '기타', center: '' },
];
const STATUS_LABEL = { draft: '답글 대기', approved: '승인됨', posted: '게시 완료', skipped: '건너뜀' };
const STATUS_BADGE = { draft: 'warn', approved: 'info', posted: 'ok', skipped: '' };
const SENTIMENT = { positive: ['긍정', 'ok'], mixed: ['보통', 'warn'], negative: ['부정', 'danger'] };
const TONES = [
  { id: 'friendly', name: '친근하게', example: '"맛있게 드셨다니 저희가 더 기뻐요! 또 들러주세요 😊"' },
  { id: 'polite', name: '정중하게', example: '"소중한 리뷰에 진심으로 감사드립니다. 더 좋은 맛으로 보답하겠습니다."' },
  { id: 'cheerful', name: '유쾌하게', example: '"리뷰 보고 주방이 들썩였어요!! 다음엔 더 맛있게 준비해 둘게요~"' },
];

const state = {
  token: safeGet('rrh_token'),
  me: null,
  bootVersion: null,
  sync: { status: 'off', devices: 0, controller: null, retry: 0 },
  onSync: null,
  swReg: null,
  installPrompt: null,
  dirty: false,
};

// ───────────────────────── 유틸 ─────────────────────────
function safeGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeSet(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* 사생활 보호 모드 등 저장소를 못 쓰는 경우 */
  }
}

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in el && typeof value !== 'string') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

function toast(message, kind = '') {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), kind === 'error' ? 4500 : 2500);
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return '방금 전';
  if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function stars(n) {
  return h('span', { class: 'stars-static', 'aria-label': `별점 ${n}점` }, '★'.repeat(n), h('span', { class: 'off' }, '★'.repeat(5 - n)));
}

function platformOf(id) {
  return PLATFORMS.find((p) => p.id === id) || PLATFORMS[PLATFORMS.length - 1];
}

function deviceName() {
  const ua = navigator.userAgent;
  const standalone = matchMedia('(display-mode: standalone)').matches ? ' (앱)' : '';
  if (/iPhone/.test(ua)) return `iPhone${standalone}`;
  if (/iPad/.test(ua)) return `iPad${standalone}`;
  if (/Android/.test(ua)) return `${/Mobile/.test(ua) ? 'Android 휴대폰' : 'Android 태블릿'}${standalone}`;
  const os = /Windows/.test(ua) ? 'Windows PC' : /Mac/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux PC' : '컴퓨터';
  const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '브라우저';
  return `${os} · ${br}${standalone}`;
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 아래 대체 방식 사용 */
  }
  // http(같은 와이파이 접속) 환경에서는 Clipboard API 를 쓸 수 없어 예전 방식으로 복사한다.
  const ta = h('textarea', { readonly: true });
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.append(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

function busy(button, label) {
  const original = [...button.childNodes];
  button.disabled = true;
  button.replaceChildren(h('span', { class: 'spinner' }), label);
  return () => {
    button.disabled = false;
    button.replaceChildren(...original);
  };
}

// ───────────────────────── API ─────────────────────────
class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  let res;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, '인터넷 연결을 확인해 주세요.');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.token && !path.startsWith('/api/auth/')) {
    signOut(true);
    throw new ApiError(401, '다시 로그인해 주세요.');
  }
  if (!res.ok) throw new ApiError(res.status, data.error || `요청 실패 (${res.status})`);
  return data;
}

function signIn(token) {
  state.token = token;
  safeSet('rrh_token', token);
  connectSync();
  location.hash = '#/new';
  render();
}

function signOut(expired = false) {
  state.token = null;
  state.me = null;
  safeSet('rrh_token', null);
  state.sync.controller?.abort();
  if (expired) toast('로그인이 만료되었어요. 다시 로그인해 주세요.', 'error');
  render();
}

async function loadMe() {
  state.me = await api('GET', '/api/me');
  return state.me;
}

// ───────────────────────── 실시간 동기화 ─────────────────────────
// 같은 계정의 다른 기기에서 바뀐 내용을 즉시 받아 화면을 새로 그린다.
async function connectSync() {
  state.sync.controller?.abort();
  if (!state.token) return;
  const controller = new AbortController();
  state.sync.controller = controller;
  try {
    const res = await fetch('/api/events', { headers: { Authorization: `Bearer ${state.token}` }, signal: controller.signal });
    if (res.status === 401) return signOut(true);
    if (!res.ok || !res.body) throw new Error('stream');
    setSyncStatus('on');
    state.sync.retry = 0;
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        handleSyncEvent(raw);
      }
    }
  } catch {
    if (controller.signal.aborted) return;
  }
  if (controller.signal.aborted || !state.token) return;
  setSyncStatus('off');
  state.sync.retry = Math.min(state.sync.retry + 1, 6);
  setTimeout(connectSync, 1000 * 2 ** state.sync.retry);
}

function handleSyncEvent(raw) {
  let event = 'message';
  let data = '';
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  if (!data) return;
  const payload = JSON.parse(data);
  if (event === 'hello') {
    // 서버가 새 버전으로 바뀌었으면 앱도 새 버전을 받아 오도록 한다.
    if (state.bootVersion && payload.version !== state.bootVersion) offerAppUpdate(payload.version);
    refreshDevices();
    return;
  }
  if (event !== 'change') return;
  if (payload.entity === 'devices') return refreshDevices();
  if (payload.entity === 'plan' || payload.entity === 'store') loadMe().catch(() => {});
  clearTimeout(handleSyncEvent.timer);
  handleSyncEvent.timer = setTimeout(() => state.onSync?.(payload.entity), 250);
}

async function refreshDevices() {
  try {
    const stats = await api('GET', '/api/stats');
    state.sync.devices = stats.devicesOnline;
    updateSyncBadge();
  } catch {
    /* 무시 */
  }
}

function setSyncStatus(status) {
  state.sync.status = status;
  updateSyncBadge();
}

function updateSyncBadge() {
  for (const el of document.querySelectorAll('[data-sync]')) {
    const on = state.sync.status === 'on';
    el.replaceChildren(
      h('span', { class: `sync-dot ${on ? 'on' : 'off'}` }),
      on ? (state.sync.devices > 1 ? `기기 ${state.sync.devices}대 연동 중` : '동기화됨') : '연결 끊김',
    );
  }
}

window.addEventListener('online', () => state.token && connectSync());

// ───────────────────────── 업데이트 ─────────────────────────
function showBanner(text, buttonLabel, onClick) {
  const banner = document.getElementById('update-banner');
  document.getElementById('update-text').textContent = text;
  const btn = document.getElementById('update-apply');
  btn.textContent = buttonLabel;
  btn.onclick = onClick;
  banner.hidden = false;
}

function offerAppUpdate(version) {
  if (state.swReg) {
    state.swReg.update().catch(() => {});
  } else {
    showBanner(`새 버전(${version})이 나왔어요.`, '새로고침', () => location.reload());
  }
}

async function setupServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  const hadController = Boolean(navigator.serviceWorker.controller);
  const reg = await navigator.serviceWorker.register('/sw.js').catch(() => null);
  if (!reg) return;
  state.swReg = reg;
  const promptIfWaiting = () => {
    if (reg.waiting && navigator.serviceWorker.controller) {
      showBanner('새 버전이 준비됐어요. 다시 설치할 필요 없이 바로 적용됩니다.', '지금 적용', () => reg.waiting?.postMessage({ type: 'SKIP_WAITING' }));
    }
  };
  promptIfWaiting();
  reg.addEventListener('updatefound', () => {
    const worker = reg.installing;
    worker?.addEventListener('statechange', () => worker.state === 'installed' && promptIfWaiting());
  });
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });
  setInterval(() => reg.update().catch(() => {}), 30 * 60 * 1000);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && reg.update().catch(() => {}));
}

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  state.installPrompt = event;
});

async function checkProgramUpdate() {
  // PC 에서 직접 실행하는 경우: 관리자에게 프로그램 새 버전이 있으면 알려 준다.
  if (!state.me?.isAdmin) return;
  try {
    const info = await api('GET', '/api/system/update');
    if (info.available && info.canApply) {
      showBanner(`프로그램 새 버전(${info.latest})이 있어요.`, '업데이트', () => {
        location.hash = '#/account';
        document.getElementById('update-banner').hidden = true;
      });
    }
  } catch {
    /* 업데이트 확인 실패는 조용히 넘어간다 */
  }
}

// ───────────────────────── 레이아웃 ─────────────────────────
const NAV = [
  { hash: '#/new', icon: '✍️', label: '답글 만들기' },
  { hash: '#/list', icon: '🗂️', label: '리뷰함' },
  { hash: '#/store', icon: '🏪', label: '가게 설정' },
  { hash: '#/account', icon: '👤', label: '내 정보' },
];

function navLinks(current) {
  return NAV.map((n) =>
    h('a', { class: `navlink${current.startsWith(n.hash) ? ' active' : ''}`, href: n.hash }, h('span', { class: 'ico', 'aria-hidden': 'true' }, n.icon), n.label),
  );
}

function shell(title, content, { back } = {}) {
  const current = location.hash || '#/new';
  const app = document.getElementById('app');
  app.replaceChildren(
    h(
      'div',
      { class: 'shell' },
      h(
        'nav',
        { class: 'sidebar', 'aria-label': '메뉴' },
        h('div', { class: 'brand' }, h('img', { src: '/icons/icon-192.png', alt: '', width: 34, height: 34 }), '리뷰답글 도우미'),
        navLinks(current),
        h('div', { class: 'side-foot' }, h('div', { 'data-sync': '' }), h('div', { text: state.me?.store?.name || '' })),
      ),
      h(
        'div',
        { class: 'main' },
        h(
          'header',
          { class: 'topbar' },
          back ? h('a', { class: 'btn btn-ghost btn-small', href: back, 'aria-label': '뒤로' }, '←') : null,
          h('h1', { text: title }),
          h('span', { class: 'sync', 'data-sync': '' }),
        ),
        h('main', { class: 'content' }, content),
      ),
      h('nav', { class: 'bottomnav', 'aria-label': '메뉴' }, navLinks(current)),
    ),
  );
  updateSyncBadge();
  window.scrollTo(0, 0);
}

// ───────────────────────── 화면: 로그인 ─────────────────────────
function viewAuth() {
  let mode = 'login';
  const email = h('input', { type: 'email', autocomplete: 'email', required: true, placeholder: 'owner@example.com' });
  const password = h('input', { type: 'password', autocomplete: 'current-password', required: true, minLength: 8, placeholder: '8자 이상' });
  const submit = h('button', { class: 'btn btn-primary btn-block btn-lg', type: 'submit' }, '로그인');
  const switchBtn = h('button', { class: 'btn btn-ghost btn-block', type: 'button' }, '처음이신가요? 무료로 시작하기');
  const hint = h('p', { class: 'muted small' }, 'PC와 휴대폰에서 같은 계정으로 로그인하면 리뷰와 설정이 자동으로 연동됩니다.');

  switchBtn.addEventListener('click', () => {
    mode = mode === 'login' ? 'signup' : 'login';
    submit.textContent = mode === 'login' ? '로그인' : '무료 체험 시작';
    switchBtn.textContent = mode === 'login' ? '처음이신가요? 무료로 시작하기' : '이미 계정이 있어요. 로그인';
    password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  });

  const form = h(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        const done = busy(submit, mode === 'login' ? '로그인 중...' : '가입 중...');
        try {
          const { token } = await api('POST', `/api/auth/${mode}`, { email: email.value, password: password.value, device: deviceName() });
          signIn(token);
        } catch (err) {
          toast(err.message, 'error');
          done();
        }
      },
    },
    h('label', { class: 'field' }, h('span', { text: '이메일' }), email),
    h('label', { class: 'field' }, h('span', { text: '비밀번호' }), password),
    submit,
    switchBtn,
    hint,
  );

  document.getElementById('app').replaceChildren(
    h(
      'div',
      { class: 'auth' },
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'logo' }, h('img', { src: '/icons/icon-192.png', alt: '', width: 72, height: 72 }), h('h1', { text: '리뷰답글 도우미' }), h('p', { class: 'muted small', text: '리뷰를 붙여넣으면 가게 말투로 답글 초안을 만들어 드려요.' })),
        form,
      ),
    ),
  );
}

// ───────────────────────── 화면: 답글 만들기 ─────────────────────────
function viewNew() {
  let platform = safeGet('rrh_platform') || 'baemin';
  let rating = 5;
  const me = state.me;

  const platformChips = h(
    'div',
    { class: 'chips', role: 'group', 'aria-label': '플랫폼' },
    PLATFORMS.map((p) =>
      h('button', {
        class: 'chip',
        type: 'button',
        text: p.name,
        'aria-pressed': String(p.id === platform),
        'data-id': p.id,
        onclick: (e) => {
          platform = p.id;
          safeSet('rrh_platform', p.id);
          for (const c of platformChips.children) c.setAttribute('aria-pressed', String(c === e.currentTarget));
        },
      }),
    ),
  );

  const starRow = h('div', { class: 'stars', role: 'group', 'aria-label': '별점' });
  const paintStars = () => [...starRow.children].forEach((b, i) => b.classList.toggle('on', i < rating));
  for (let i = 1; i <= 5; i++) {
    starRow.append(h('button', { class: 'star-btn', type: 'button', 'aria-label': `${i}점`, text: '★', onclick: () => ((rating = i), paintStars()) }));
  }
  paintStars();

  const content = h('textarea', { placeholder: '배달앱·지도앱에서 리뷰 내용을 복사해 여기에 붙여넣으세요.', maxLength: 3000, required: true, rows: 6 });
  const author = h('input', { type: 'text', placeholder: '예: 맛집탐방러', maxLength: 50 });
  const menu = h('input', { type: 'text', placeholder: '예: 참치김밥 2줄, 라볶이', maxLength: 100 });
  const submit = h('button', { class: 'btn btn-primary btn-block btn-lg', type: 'submit' }, '✨ 답글 초안 만들기');

  const pasteBtn =
    navigator.clipboard?.readText && window.isSecureContext
      ? h('button', {
          class: 'btn btn-small',
          type: 'button',
          text: '📋 붙여넣기',
          onclick: async () => {
            try {
              content.value = (await navigator.clipboard.readText()).slice(0, 3000);
              content.focus();
            } catch {
              toast('붙여넣기 권한이 없어요. 입력창을 길게 눌러 붙여넣어 주세요.', 'error');
            }
          },
        })
      : null;

  const plan = me.plan;
  const needsStore = !me.store.name;

  const form = h(
    'form',
    {
      class: 'card',
      onsubmit: async (e) => {
        e.preventDefault();
        if (!content.value.trim()) return toast('리뷰 내용을 붙여넣어 주세요.', 'error');
        const done = busy(submit, '가게 말투로 답글 쓰는 중...');
        try {
          const { review, warning } = await api('POST', '/api/reviews', {
            platform,
            rating,
            content: content.value,
            author: author.value,
            menu: menu.value,
          });
          if (warning) toast(warning);
          loadMe().catch(() => {});
          location.hash = `#/review/${review.id}`;
        } catch (err) {
          toast(err.message, 'error');
          done();
        }
      },
    },
    h('label', { class: 'field' }, h('span', { text: '어디에 달린 리뷰인가요?' }), platformChips),
    h('label', { class: 'field' }, h('span', { text: '별점' }), starRow),
    h('label', { class: 'field' }, h('div', { class: 'row between' }, h('span', { text: '리뷰 내용', class: 'grow' }), pasteBtn), content),
    h(
      'details',
      {},
      h('summary', { text: '추가 정보 (선택) — 닉네임·메뉴를 넣으면 더 자연스러워요' }),
      h('label', { class: 'field' }, h('span', { text: '고객 닉네임' }), author),
      h('label', { class: 'field' }, h('span', { text: '주문 메뉴' }), menu),
    ),
    submit,
    h('p', { class: 'muted small', text: `이번 달 남은 횟수 ${plan.remaining}회 · ${plan.label}${me.engine === 'local' ? ' · 기본 문장 엔진' : ''}` }),
  );

  shell('답글 만들기', [
    needsStore
      ? h('div', { class: 'alert info' }, h('h3', { text: '먼저 가게 정보를 알려 주세요' }), h('p', { class: 'small', text: '가게 이름과 말투를 설정하면 사장님 말투에 맞춘 답글이 나와요.' }), h('a', { class: 'btn btn-small', href: '#/store', text: '가게 설정하러 가기' }))
      : null,
    h('div', { class: 'section-title', text: '리뷰를 붙여넣고 버튼만 누르세요' }),
    form,
  ]);
  state.onSync = null;
}

// ───────────────────────── 화면: 리뷰함 ─────────────────────────
async function viewList() {
  let status = safeGet('rrh_filter') || '';
  const search = h('input', { type: 'search', placeholder: '리뷰 내용·닉네임·메뉴 검색' });
  const listEl = h('div', { class: 'stack' });
  const statsEl = h('div');
  const filters = [
    ['', '전체'],
    ['draft', '대기'],
    ['approved', '승인됨'],
    ['posted', '게시 완료'],
    ['skipped', '건너뜀'],
  ];
  const tabs = h(
    'div',
    { class: 'tabs chips' },
    filters.map(([id, label]) =>
      h('button', {
        class: 'chip tab',
        type: 'button',
        text: label,
        'aria-pressed': String(id === status),
        onclick: (e) => {
          status = id;
          safeSet('rrh_filter', id);
          for (const c of tabs.children) c.setAttribute('aria-pressed', String(c === e.currentTarget));
          load();
        },
      }),
    ),
  );

  async function loadStats() {
    try {
      const s = await api('GET', '/api/stats');
      state.sync.devices = s.devicesOnline;
      updateSyncBadge();
      statsEl.replaceChildren(
        h(
          'div',
          { class: 'stats' },
          h('div', { class: 'stat' }, h('b', { text: String(s.month.total) }), h('span', { text: '이번 달 리뷰' })),
          h('div', { class: 'stat' }, h('b', { text: String(s.counts.draft) }), h('span', { text: '답글 대기' })),
          h('div', { class: 'stat' }, h('b', { text: `${s.month.minutesSaved}분` }), h('span', { text: '아낀 시간(추정)' })),
        ),
      );
    } catch {
      /* 통계는 없어도 된다 */
    }
  }

  async function load() {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (search.value.trim()) params.set('q', search.value.trim());
    try {
      const reviews = await api('GET', `/api/reviews?${params}`);
      if (!reviews.length) {
        listEl.replaceChildren(h('div', { class: 'empty' }, h('p', { text: '아직 리뷰가 없어요.' }), h('a', { class: 'btn btn-primary', href: '#/new', text: '첫 답글 만들기' })));
        return;
      }
      listEl.replaceChildren(
        ...reviews.map((r) =>
          h(
            'a',
            { class: 'card review-item', href: `#/review/${r.id}` },
            h(
              'div',
              { class: 'row between' },
              h('div', { class: 'row' }, h('span', { class: 'badge brand', text: r.platformName }), stars(r.rating)),
              h('span', { class: `badge ${STATUS_BADGE[r.status]}`, text: STATUS_LABEL[r.status] }),
            ),
            h('p', { class: 'snippet', text: r.content }),
            h(
              'div',
              { class: 'row small muted' },
              r.author ? h('span', { text: r.author }) : null,
              h('span', { text: fmtDate(r.createdAt) }),
              r.isMalicious ? h('span', { class: 'badge danger', text: '⚠ 악성 의심' }) : null,
            ),
          ),
        ),
      );
    } catch (err) {
      listEl.replaceChildren(h('div', { class: 'empty', text: err.message }));
    }
  }

  let t;
  search.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(load, 300);
  });

  shell('리뷰함', [statsEl, h('div', { class: 'section-title', text: '리뷰 목록' }), h('div', { class: 'stack' }, search, tabs), h('div', { class: 'section-title' }), listEl]);
  state.onSync = (entity) => {
    if (entity === 'reviews') {
      load();
      loadStats();
    }
  };
  await Promise.all([load(), loadStats()]);
}

// ───────────────────────── 화면: 리뷰 상세 / 답글 승인 ─────────────────────────
async function viewReview(id) {
  let review;
  try {
    review = await api('GET', `/api/reviews/${id}`);
  } catch (err) {
    shell('리뷰', h('div', { class: 'empty', text: err.message }), { back: '#/list' });
    return;
  }
  state.dirty = false;
  const editor = h('textarea', { rows: 7, maxLength: 2000 });
  editor.value = review.finalReply || review.drafts[0]?.text || '';
  const counter = h('span', { class: 'muted small' });
  const updateCounter = () => (counter.textContent = `${editor.value.length}자`);
  updateCounter();
  editor.addEventListener('input', () => {
    state.dirty = true;
    updateCounter();
    for (const d of draftsEl.children) d.classList.remove('selected');
  });

  const useText = (text, card) => {
    editor.value = text;
    state.dirty = true;
    updateCounter();
    for (const d of draftsEl.querySelectorAll('.draft')) d.classList.toggle('selected', d === card);
    editor.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const draftsEl = h('div');
  for (const d of review.drafts) {
    const card = h('div', { class: `draft${d.text === editor.value ? ' selected' : ''}` });
    card.append(
      h('div', { class: 'row between' }, h('span', { class: 'label', text: d.label }), h('button', { class: 'btn btn-small', type: 'button', text: '이 초안 쓰기', onclick: () => useText(d.text, card) })),
      h('p', { class: 'pre', text: d.text }),
    );
    draftsEl.append(card);
  }

  const platform = platformOf(review.platform);
  const [sentLabel, sentClass] = SENTIMENT[review.sentiment] || ['분석 전', ''];

  async function save(status, message) {
    const body = { finalReply: editor.value };
    if (status) body.status = status;
    const updated = await api('PATCH', `/api/reviews/${review.id}`, body);
    review = updated;
    state.dirty = false;
    if (message) toast(message);
    renderActions();
  }

  const actions = h('div', { class: 'stack' });
  function renderActions() {
    const statusBadge = h('span', { class: `badge ${STATUS_BADGE[review.status]}`, text: STATUS_LABEL[review.status] });
    const approve = h('button', {
      class: 'btn btn-primary btn-block btn-lg',
      type: 'button',
      text: review.status === 'draft' || review.status === 'skipped' ? '✅ 승인하고 복사하기' : '📋 답글 다시 복사',
      onclick: async () => {
        if (!editor.value.trim()) return toast('답글 내용이 비어 있어요.', 'error');
        const copied = await copyText(editor.value);
        try {
          await save(review.status === 'posted' ? undefined : 'approved', copied ? '복사했어요! 사장님 센터에 붙여넣어 게시하세요.' : '저장했어요. 답글을 길게 눌러 직접 복사해 주세요.');
        } catch (err) {
          toast(err.message, 'error');
        }
      },
    });
    const center = platform.center
      ? h('a', { class: 'btn btn-block', href: platform.center, target: '_blank', rel: 'noopener noreferrer', text: `${platform.name} 사장님 센터 열기 ↗` })
      : null;
    const posted =
      review.status === 'posted'
        ? h('button', { class: 'btn btn-block', type: 'button', text: '↩ 대기로 되돌리기', onclick: () => save('draft', '대기 상태로 바꿨어요.').catch((e) => toast(e.message, 'error')) })
        : h('button', { class: 'btn btn-ok btn-block', type: 'button', text: '🎉 게시 완료로 표시', onclick: () => save('posted', '게시 완료! 수고하셨어요.').catch((e) => toast(e.message, 'error')) });
    const more = h(
      'div',
      { class: 'row' },
      h('button', {
        class: 'btn btn-small',
        type: 'button',
        text: '💾 저장만',
        onclick: () => save(undefined, '저장했어요.').catch((e) => toast(e.message, 'error')),
      }),
      h('button', {
        class: 'btn btn-small',
        type: 'button',
        text: '🔄 초안 다시 만들기',
        onclick: async (e) => {
          if (state.dirty && !confirm('수정한 답글이 새 초안으로 바뀝니다. 계속할까요?')) return;
          const done = busy(e.currentTarget, '만드는 중...');
          try {
            const { warning } = await api('POST', `/api/reviews/${review.id}/regenerate`);
            if (warning) toast(warning);
            state.dirty = false;
            viewReview(review.id);
          } catch (err) {
            toast(err.message, 'error');
            done();
          }
        },
      }),
      review.status !== 'skipped'
        ? h('button', { class: 'btn btn-small', type: 'button', text: '⏭ 건너뛰기', onclick: () => save('skipped', '건너뛰었어요.').catch((e) => toast(e.message, 'error')) })
        : null,
      h('button', {
        class: 'btn btn-small btn-danger',
        type: 'button',
        text: '🗑 삭제',
        onclick: async () => {
          if (!confirm('이 리뷰를 삭제할까요? 모든 기기에서 사라집니다.')) return;
          try {
            await api('DELETE', `/api/reviews/${review.id}`);
            toast('삭제했어요.');
            location.hash = '#/list';
          } catch (err) {
            toast(err.message, 'error');
          }
        },
      }),
    );
    actions.replaceChildren(
      h('div', { class: 'row' }, h('span', { class: 'muted small', text: '상태' }), statusBadge, review.postedAt ? h('span', { class: 'muted small', text: fmtDate(review.postedAt) }) : null),
      approve,
      center,
      posted,
      more,
    );
  }
  renderActions();

  const malicious = review.isMalicious
    ? h(
        'div',
        { class: 'alert danger' },
        h('h3', { text: '⚠ 악성 리뷰로 의심돼요' }),
        h('p', { class: 'small', text: review.maliciousReason }),
        review.calmReply
          ? h(
              'div',
              { class: 'draft' },
              h('div', { class: 'row between' }, h('span', { class: 'label', text: '감정적이지 않은 대응 문구' }), h('button', { class: 'btn btn-small', type: 'button', text: '이 문구 쓰기', onclick: (e) => useText(review.calmReply, e.currentTarget.closest('.draft')) })),
              h('p', { class: 'pre', text: review.calmReply }),
            )
          : null,
        review.guidance ? h('details', { open: true }, h('summary', { text: '사장님이 하실 일' }), h('p', { class: 'pre small', text: review.guidance })) : null,
      )
    : null;

  shell(
    '답글 확인',
    [
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'row between' }, h('div', { class: 'row' }, h('span', { class: 'badge brand', text: review.platformName }), stars(review.rating)), h('span', { class: 'muted small', text: fmtDate(review.createdAt) })),
        h('p', { class: 'pre', text: review.content }),
        h(
          'div',
          { class: 'row small' },
          review.author ? h('span', { class: 'muted', text: `👤 ${review.author}` }) : null,
          review.menu ? h('span', { class: 'muted', text: `🍽 ${review.menu}` }) : null,
          h('span', { class: `badge ${sentClass}`, text: sentLabel }),
          ...review.keyPoints.map((k) => h('span', { class: 'badge', text: k })),
        ),
      ),
      malicious,
      h('div', { class: 'section-title', text: `답글 초안 ${review.drafts.length}개${review.engine === 'local' ? ' · 기본 문장 엔진' : ' · AI'}` }),
      draftsEl,
      h('div', { class: 'section-title', text: '올릴 답글 (자유롭게 고치세요)' }),
      h('div', { class: 'card' }, editor, h('div', { class: 'row between' }, h('span', { class: 'muted small', text: '고친 내용은 다른 기기에도 바로 반영돼요.' }), counter)),
      h('div', { class: 'section-title' }),
      actions,
    ],
    { back: '#/list' },
  );

  state.onSync = async (entity) => {
    if (entity !== 'reviews') return;
    try {
      const fresh = await api('GET', `/api/reviews/${review.id}`);
      if (fresh.updatedAt === review.updatedAt) return;
      if (state.dirty) {
        toast('다른 기기에서 이 리뷰가 바뀌었어요. 저장하면 지금 내용으로 덮어씁니다.');
        return;
      }
      viewReview(review.id);
    } catch (err) {
      if (err.status === 404) {
        toast('다른 기기에서 삭제된 리뷰예요.');
        location.hash = '#/list';
      }
    }
  };
}

// ───────────────────────── 화면: 가게 설정 ─────────────────────────
async function viewStore() {
  const store = await api('GET', '/api/store');
  state.dirty = false;
  const f = {};
  const input = (key, attrs = {}) => {
    const el = h(attrs.multiline ? 'textarea' : 'input', { type: 'text', ...attrs, multiline: null });
    el.value = store[key] || '';
    el.addEventListener('input', () => (state.dirty = true));
    f[key] = el;
    return el;
  };

  const toneGroup = h(
    'div',
    { class: 'tone-options' },
    TONES.map((t) => {
      const radio = h('input', { type: 'radio', name: 'tone', value: t.id, checked: store.tone === t.id, onchange: () => (state.dirty = true) });
      return h('label', { class: 'tone-option' }, radio, h('div', {}, h('b', { text: t.name }), h('div', { class: 'small muted', text: t.example })));
    }),
  );
  const emoji = h(
    'select',
    { onchange: () => (state.dirty = true) },
    [
      ['none', '쓰지 않기'],
      ['some', '조금 (1~2개)'],
      ['many', '많이 (3~5개)'],
    ].map(([v, l]) => h('option', { value: v, text: l, selected: store.emoji === v })),
  );

  const saveBtn = h('button', { class: 'btn btn-primary btn-block btn-lg', type: 'submit', text: '저장하기' });
  const form = h(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        const done = busy(saveBtn, '저장 중...');
        try {
          await api('PUT', '/api/store', {
            name: f.name.value,
            category: f.category.value,
            tone: form.querySelector('input[name="tone"]:checked')?.value || 'friendly',
            emoji: emoji.value,
            greeting: f.greeting.value,
            signature: f.signature.value,
            sample_replies: f.sample_replies.value,
            avoid_words: f.avoid_words.value,
            notes: f.notes.value,
          });
          state.dirty = false;
          await loadMe();
          toast('저장했어요. 다른 기기에도 바로 반영됩니다.');
        } catch (err) {
          toast(err.message, 'error');
        }
        done();
      },
    },
    h(
      'div',
      { class: 'card' },
      h('h2', { text: '기본 정보' }),
      h('label', { class: 'field' }, h('span', { text: '가게 이름' }), input('name', { placeholder: '예: 행복김밥 역삼점', maxLength: 60 })),
      h('label', { class: 'field' }, h('span', { text: '업종' }), input('category', { placeholder: '예: 분식, 카페, 치킨', maxLength: 40 })),
    ),
    h(
      'div',
      { class: 'card' },
      h('h2', { text: '답글 말투' }),
      toneGroup,
      h('label', { class: 'field' }, h('span', { text: '이모지' }), emoji),
      h('label', { class: 'field' }, h('span', { text: '첫 인사말 (선택)' }), input('greeting', { placeholder: '예: 안녕하세요, 행복김밥 사장입니다!', maxLength: 120 }), h('small', { text: '비워 두면 말투에 맞게 알아서 인사해요.' })),
      h('label', { class: 'field' }, h('span', { text: '맺음말 서명 (선택)' }), input('signature', { placeholder: '예: - 행복김밥 사장 김행복 드림', maxLength: 120 })),
    ),
    h(
      'div',
      { class: 'card' },
      h('h2', { text: '사장님 말투 학습 (선택)' }),
      h('label', { class: 'field' }, h('span', { text: '평소에 쓰던 답글 예시' }), input('sample_replies', { multiline: true, rows: 5, maxLength: 2000, placeholder: '예전에 직접 쓴 답글 2~3개를 붙여넣으면 그 말투를 닮게 써요.' })),
      h('label', { class: 'field' }, h('span', { text: '쓰지 말아야 할 표현' }), input('avoid_words', { placeholder: '예: 서비스 드릴게요, 환불', maxLength: 300 })),
      h('label', { class: 'field' }, h('span', { text: '참고 메모' }), input('notes', { multiline: true, rows: 3, maxLength: 500, placeholder: '예: 국내산 재료만 사용, 매주 월요일 휴무, 포장 할인 1,000원' })),
    ),
    h('div', { class: 'section-title' }),
    saveBtn,
  );

  shell('가게 설정', form);
  state.onSync = (entity) => {
    if (entity !== 'store') return;
    if (state.dirty) toast('다른 기기에서 가게 설정이 바뀌었어요. 저장하면 지금 내용으로 덮어씁니다.');
    else viewStore();
  };
}

// ───────────────────────── 화면: 내 정보 ─────────────────────────
async function viewAccount() {
  const me = await loadMe();
  const [sessions, info] = await Promise.all([api('GET', '/api/sessions'), api('GET', '/api/system/info')]);
  const plan = me.plan;
  const pct = Math.min(100, Math.round((plan.used / Math.max(1, plan.limit)) * 100));
  const bar = h('div');
  bar.style.width = `${pct}%`;

  const planCard = h(
    'div',
    { class: 'card' },
    h('div', { class: 'row between' }, h('h2', { text: '요금제' }), h('span', { class: `badge ${plan.plan === 'pro' ? 'ok' : plan.plan === 'trial' ? 'info' : ''}`, text: plan.label })),
    plan.until ? h('p', { class: 'small muted', text: `${plan.plan === 'trial' ? '체험 종료' : '이용 기한'}: ${new Date(plan.until).toLocaleDateString('ko-KR')}` }) : null,
    h('p', { class: 'small', text: `이번 달 사용 ${plan.used} / ${plan.limit}회` }),
    h('div', { class: 'progress' }, bar),
    plan.plan !== 'pro'
      ? h(
          'div',
          { class: 'stack' },
          h('p', { class: 'small', text: `프로 요금제 ${me.priceText} — 매달 넉넉한 답글 생성, PC·휴대폰 동기화 포함.` }),
          me.paymentUrl ? h('a', { class: 'btn btn-primary btn-block', href: me.paymentUrl, target: '_blank', rel: 'noopener noreferrer', text: '프로로 업그레이드' }) : h('p', { class: 'small muted', text: '업그레이드는 관리자에게 문의해 주세요.' }),
        )
      : null,
  );

  const deviceCard = h(
    'div',
    { class: 'card' },
    h('h2', { text: `로그인한 기기 ${sessions.length}대` }),
    h('p', { class: 'small muted', text: '같은 계정으로 로그인한 기기끼리 리뷰·답글·가게 설정이 실시간으로 연동돼요.' }),
    ...sessions.map((s) =>
      h(
        'div',
        { class: 'row between' },
        h('div', {}, h('div', { text: `${s.device}${s.current ? ' (지금 이 기기)' : ''}` }), h('div', { class: 'small muted', text: `마지막 사용 ${fmtDate(s.lastSeen)}` })),
        s.current
          ? null
          : h('button', {
              class: 'btn btn-small btn-danger',
              type: 'button',
              text: '로그아웃',
              onclick: async () => {
                await api('DELETE', `/api/sessions/${s.id}`).catch((e) => toast(e.message, 'error'));
                viewAccount();
              },
            }),
      ),
    ),
  );

  const isIos = /iPhone|iPad/.test(navigator.userAgent);
  const installed = matchMedia('(display-mode: standalone)').matches;
  const installBtn = state.installPrompt
    ? h('button', {
        class: 'btn btn-primary btn-block',
        type: 'button',
        text: '📲 이 기기에 앱으로 설치',
        onclick: async () => {
          state.installPrompt.prompt();
          await state.installPrompt.userChoice;
          state.installPrompt = null;
          viewAccount();
        },
      })
    : null;
  const mobileCard = h(
    'div',
    { class: 'card' },
    h('h2', { text: '휴대폰에서 쓰기 / 앱 설치' }),
    installed ? h('p', { class: 'badge ok', text: '앱으로 설치되어 실행 중이에요' }) : null,
    installBtn,
    h(
      'ol',
      { class: 'steps small' },
      info.lanUrls.length && ['localhost', '127.0.0.1'].includes(location.hostname)
        ? h('li', {}, '휴대폰을 이 PC와 같은 와이파이에 연결하고 휴대폰 브라우저에서 아래 주소를 여세요: ', ...info.lanUrls.map((u) => h('div', {}, h('code', { class: 'url', text: u }))))
        : h('li', {}, '휴대폰 브라우저에서 지금 이 주소를 여세요: ', h('code', { class: 'url', text: location.origin })),
      h('li', { text: '같은 이메일로 로그인하면 PC와 자동으로 연동됩니다.' }),
      h('li', { text: isIos ? 'Safari 공유 버튼 → "홈 화면에 추가"를 누르면 앱 아이콘이 생겨요.' : '브라우저 메뉴(⋮) → "앱 설치" 또는 "홈 화면에 추가"를 누르면 앱 아이콘이 생겨요.' }),
    ),
    h('p', { class: 'small muted', text: '앱은 다시 설치할 필요 없이 열 때마다 자동으로 최신 버전으로 바뀝니다.' }),
  );

  const updateBox = h('div', { class: 'stack' }, h('p', { class: 'small muted', text: '업데이트 확인 중...' }));
  const versionCard = h(
    'div',
    { class: 'card' },
    h('h2', { text: '버전 / 업데이트' }),
    h('p', { class: 'small', text: `현재 버전 ${info.version} · 답글 엔진: ${info.engine === 'claude' ? `Claude AI (${info.model})` : '기본 문장 엔진 (AI 키 미설정)'}` }),
    updateBox,
  );
  api('GET', '/api/system/update?refresh=1')
    .then((u) => {
      if (u.error) return updateBox.replaceChildren(h('p', { class: 'small muted', text: `업데이트 확인 실패: ${u.error}` }));
      if (!u.available) {
        return updateBox.replaceChildren(
          h('p', { class: 'small', text: u.mode === 'none' ? '자동 업데이트 설정이 없어요 (클라우드 배포본은 새 버전 배포 시 자동 반영).' : '최신 버전을 사용 중이에요. ✅' }),
        );
      }
      const children = [h('p', { class: 'small', text: `새 버전 ${u.latest}이(가) 있어요.` })];
      if (u.notes) children.push(h('p', { class: 'pre small muted', text: u.notes }));
      if (u.canApply && me.isAdmin) {
        children.push(
          h('button', {
            class: 'btn btn-primary btn-block',
            type: 'button',
            text: '지금 업데이트 (재설치 필요 없음)',
            onclick: async (e) => {
              const done = busy(e.currentTarget, '업데이트 중... 창을 닫지 마세요');
              try {
                const r = await api('POST', '/api/system/update');
                if (r.error) throw new Error(r.error);
                toast('업데이트를 적용했어요. 잠시 후 새 버전으로 다시 열립니다.');
                await waitForNewServer(info.version);
                location.reload();
              } catch (err) {
                toast(err.message, 'error');
                done();
              }
            },
          }),
        );
      } else {
        children.push(h('p', { class: 'small muted', text: '프로그램 아이콘으로 다시 실행하면 자동으로 업데이트됩니다.' }));
      }
      updateBox.replaceChildren(...children);
    })
    .catch(() => updateBox.replaceChildren(h('p', { class: 'small muted', text: '업데이트 정보를 확인하지 못했어요.' })));

  const current = h('input', { type: 'password', autocomplete: 'current-password', placeholder: '현재 비밀번호' });
  const next = h('input', { type: 'password', autocomplete: 'new-password', placeholder: '새 비밀번호 (8자 이상)', minLength: 8 });
  const pwCard = h(
    'details',
    { class: 'card' },
    h('summary', { text: '비밀번호 변경' }),
    h(
      'form',
      {
        onsubmit: async (e) => {
          e.preventDefault();
          try {
            await api('POST', '/api/auth/password', { current: current.value, next: next.value });
            toast('비밀번호를 바꿨어요. 다른 기기는 로그아웃됐어요.');
            viewAccount();
          } catch (err) {
            toast(err.message, 'error');
          }
        },
      },
      h('label', { class: 'field' }, current),
      h('label', { class: 'field' }, next),
      h('button', { class: 'btn btn-block', type: 'submit', text: '변경하기' }),
    ),
  );

  shell('내 정보', [
    h('div', { class: 'card' }, h('div', { class: 'row between' }, h('div', {}, h('b', { text: me.email }), h('div', { class: 'small muted', text: me.store.name || '가게 이름 미설정' })), h('span', { class: 'sync', 'data-sync': '' }))),
    planCard,
    deviceCard,
    mobileCard,
    versionCard,
    pwCard,
    me.isAdmin ? h('a', { class: 'btn btn-block', href: '#/admin', text: '🛠 관리자: 가입자·요금제 관리' }) : null,
    h('div', { class: 'section-title' }),
    h('button', {
      class: 'btn btn-block btn-danger',
      type: 'button',
      text: '이 기기에서 로그아웃',
      onclick: async () => {
        await api('POST', '/api/auth/logout').catch(() => {});
        signOut();
      },
    }),
  ]);
  updateSyncBadge();
  state.onSync = (entity) => entity === 'plan' && viewAccount();
}

async function waitForNewServer(oldVersion) {
  // 서버가 재시작되어 버전이 바뀔 때까지 최대 90초 기다린다.
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      if (res.ok && (await res.json()).version !== oldVersion) return;
    } catch {
      /* 재시작 중 */
    }
  }
}

// ───────────────────────── 화면: 관리자 ─────────────────────────
async function viewAdmin() {
  let users;
  try {
    users = await api('GET', '/api/admin/users');
  } catch (err) {
    shell('관리자', h('div', { class: 'empty', text: err.message }), { back: '#/account' });
    return;
  }
  const rows = users.map((u) => {
    const plan = h('select', {}, [
      ['trial', '무료 체험'],
      ['pro', '프로'],
      ['free', '무료'],
    ].map(([v, l]) => h('option', { value: v, text: l, selected: u.plan.plan === v })));
    const months = h('input', { type: 'number', min: 0, max: 36, value: 1, 'aria-label': '개월' });
    months.style.width = '70px';
    return h(
      'tr',
      {},
      h('td', {}, h('div', { text: u.email }), h('div', { class: 'small muted', text: `${u.storeName || '-'} · 리뷰 ${u.reviews}개 · ${new Date(u.createdAt).toLocaleDateString('ko-KR')} 가입` })),
      h('td', {}, h('span', { class: 'badge', text: u.plan.label }), u.plan.until ? h('div', { class: 'small muted', text: `~${new Date(u.plan.until).toLocaleDateString('ko-KR')}` }) : null, h('div', { class: 'small muted', text: `${u.plan.used}/${u.plan.limit}회` })),
      h(
        'td',
        {},
        h('div', { class: 'row' }, plan, months, h('span', { class: 'small muted', text: '개월' })),
        h('button', {
          class: 'btn btn-small',
          type: 'button',
          text: '적용',
          onclick: async () => {
            try {
              await api('PATCH', `/api/admin/users/${u.id}`, { plan: plan.value, months: Number(months.value) });
              toast('요금제를 바꿨어요.');
              viewAdmin();
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        }),
      ),
    );
  });
  shell(
    '가입자 관리',
    [
      h('p', { class: 'small muted', text: '입금 확인 후 "프로 + 개월 수"를 적용하면 기존 기한 뒤로 연장돼요. 0개월은 기한 없음.' }),
      h('div', { class: 'card table-wrap' }, h('table', { class: 'table' }, h('thead', {}, h('tr', {}, h('th', { text: '가입자' }), h('th', { text: '요금제' }), h('th', { text: '변경' }))), h('tbody', {}, rows))),
    ],
    { back: '#/account' },
  );
  state.onSync = null;
}

// ───────────────────────── 라우터 ─────────────────────────
async function render() {
  if (!state.token) {
    state.onSync = null;
    return viewAuth();
  }
  try {
    if (!state.me) await loadMe();
  } catch (err) {
    if (!state.token) return;
    document.getElementById('app').replaceChildren(
      h('div', { class: 'auth' }, h('div', { class: 'card' }, h('p', { text: err.message }), h('button', { class: 'btn btn-primary btn-block', text: '다시 시도', onclick: () => render() }))),
    );
    return;
  }
  const hash = location.hash || '#/new';
  try {
    const m = hash.match(/^#\/review\/(\d+)$/);
    if (m) await viewReview(Number(m[1]));
    else if (hash === '#/list') await viewList();
    else if (hash === '#/store') await viewStore();
    else if (hash === '#/account') await viewAccount();
    else if (hash === '#/admin') await viewAdmin();
    else viewNew();
  } catch (err) {
    toast(err.message, 'error');
  }
}

window.addEventListener('hashchange', () => {
  state.dirty = false;
  render();
});

async function boot() {
  try {
    const v = await fetch('/api/version', { cache: 'no-store' }).then((r) => r.json());
    state.bootVersion = v.version;
  } catch {
    /* 오프라인으로 시작한 경우 */
  }
  setupServiceWorker();
  await render();
  if (state.token) {
    connectSync();
    checkProgramUpdate();
  }
}

boot();
