// 내장 문장 엔진: AI 키가 없을 때(무료 체험, 오프라인, 장애 시)에도 답글 초안을 만들어 주는 규칙 기반 생성기.
// AI 엔진과 같은 결과 형식을 돌려주므로 화면은 어느 엔진인지 신경 쓰지 않아도 된다.
import crypto from 'node:crypto';

const PROFANITY = [
  '시발', '씨발', '씨빨', 'ㅅㅂ', 'ㅆㅂ', '병신', 'ㅂㅅ', '개새', '새끼', '좆', 'ㅈ같', '존나', '미친놈', '미친년',
  '꺼져', '닥쳐', '망해라', '망해버', '망하길', '망했으면', '죽어라', '뒤져', '뒈져', '쓰레기같', '쓰레기 같',
];
const EXTORTION = ['안 주면', '안주면', '해주면 별점', '안 해주면', '안해주면', '서비스 주면', '별점 테러', '리뷰 테러'];

const COMPLAINTS = [
  { key: 'late', words: ['늦', '오래 걸', '한참', '지연', '시간이 너무'], label: '배달 지연' },
  { key: 'cold', words: ['식어', '식었', '미지근', '차가웠', '불어', '불었'], label: '음식 온도' },
  { key: 'taste', words: ['짜요', '짜서', '너무 짜', '짰', '싱거', '맛없', '맛이 없', '별로였', '맛은 별로', '느끼', '비려', '비린'], label: '맛' },
  { key: 'portion', words: ['양이 적', '양 적', '양이 너무 적', '양이 작', '부실'], label: '양' },
  { key: 'foreign', words: ['머리카락', '이물질', '벌레', '비닐', '털이'], label: '이물질' },
  { key: 'missing', words: ['누락', '빠졌', '빠져', '안 왔', '안왔', '안 들어'], label: '누락' },
  { key: 'rude', words: ['불친절', '태도', '싸가지', '퉁명', '무시'], label: '응대 태도' },
  { key: 'package', words: ['샜', '새서', '쏟아', '터져', '터졌', '포장이', '엉망'], label: '포장' },
  { key: 'price', words: ['비싸', '가격에 비해', '가성비'], label: '가격' },
];

const PRAISES = [
  { key: 'tasty', words: ['맛있', '존맛', '맛나', 'JMT', '맛집', '꿀맛', '최고'], label: '맛 칭찬' },
  { key: 'kind', words: ['친절', '응대', '사장님 감사'], label: '친절' },
  { key: 'fast', words: ['빨리', '빠르', '빠른', '금방'], label: '빠른 배달' },
  { key: 'plenty', words: ['양 많', '양이 많', '푸짐', '넉넉'], label: '푸짐한 양' },
  { key: 'again', words: ['재주문', '또 시', '또시', '단골', '또 올', '또올', '자주'], label: '재방문 의사' },
  { key: 'clean', words: ['깔끔', '정갈', '위생', '신선'], label: '깔끔함' },
];

function includesAny(text, words) {
  return words.some((w) => text.includes(w));
}

function seeded(text) {
  // 같은 리뷰는 같은 초안이, 다른 리뷰는 다른 문장이 나오도록 내용 기반 의사난수 사용.
  let seed = crypto.createHash('md5').update(text).digest().readUInt32LE(0);
  return (arr) => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return arr[seed % arr.length];
  };
}

export function analyzeReview({ rating, content }) {
  const text = String(content || '');
  const compact = text.replace(/\s+/g, '');
  const complaints = COMPLAINTS.filter((c) => includesAny(text, c.words) || includesAny(compact, c.words.map((w) => w.replace(/\s+/g, ''))));
  const praises = PRAISES.filter((p) => includesAny(text, p.words));
  const profane = PROFANITY.some((w) => compact.includes(w.replace(/\s+/g, '')));
  const extortion = includesAny(text, EXTORTION);

  let sentiment = 'positive';
  if (rating <= 2 || (complaints.length && !praises.length && rating <= 3)) sentiment = 'negative';
  else if (complaints.length || rating === 3) sentiment = 'mixed';

  let maliciousReason = '';
  if (profane) maliciousReason = '욕설·비방 표현이 포함되어 있습니다.';
  else if (extortion) maliciousReason = '보상(서비스·환불)을 조건으로 한 별점 압박이 의심됩니다.';
  else if (rating === 1 && !complaints.length && text.replace(/\s/g, '').length < 15) {
    maliciousReason = '구체적인 사유 없는 최저 별점입니다. 경쟁 업체나 단순 비방일 수 있습니다.';
  }

  return {
    sentiment,
    isMalicious: Boolean(maliciousReason),
    maliciousReason,
    complaints,
    praises,
  };
}

const TONES = {
  friendly: {
    hello: ['안녕하세요{name}! {store}입니다', '반가워요{name}! {store}{yeyo}', '안녕하세요{name}~ {store}입니다'],
    thanks: ['소중한 리뷰 정말 감사드려요', '맛있게 드셨다니 저희가 더 기뻐요', '이렇게 따뜻한 리뷰 남겨주셔서 감사해요'],
    sorry: ['불편을 드려 정말 죄송해요', '기대에 못 미쳐 마음이 무겁네요. 정말 죄송합니다', '실망을 드려서 너무 죄송해요'],
    bye: ['다음에도 맛있는 음식으로 보답할게요', '또 찾아주시면 더 정성껏 준비할게요', '늘 건강하시고 좋은 하루 보내세요'],
  },
  polite: {
    hello: ['안녕하십니까{name}, {store}입니다', '반갑습니다{name}, {store}입니다', '안녕하세요{name}. {store}입니다'],
    thanks: ['소중한 리뷰를 남겨주셔서 진심으로 감사드립니다', '저희 매장을 이용해 주셔서 감사합니다', '정성스러운 후기에 깊이 감사드립니다'],
    sorry: ['이용에 불편을 드려 진심으로 사과드립니다', '기대에 부응하지 못해 대단히 죄송합니다', '불편을 끼쳐 드려 송구합니다'],
    bye: ['앞으로도 변함없는 맛과 서비스로 보답하겠습니다', '다시 찾아주시면 더욱 만족스럽게 모시겠습니다', '항상 건강하시고 평안한 하루 되십시오'],
  },
  cheerful: {
    hello: ['안녕하세요{name}!! {store}입니다', '와아 반가워요{name}! {store}{yeyo}', '하이요{name}~ {store}입니다'],
    thanks: ['리뷰 보고 저희 주방이 들썩였어요', '이런 리뷰는 사장님 비타민이에요', '맛있게 드셔주셔서 완전 감동이에요'],
    sorry: ['헉, 불편을 드려서 정말 죄송해요', '아이고, 이건 저희가 잘못했어요. 죄송합니다', '실망시켜 드려서 너무 미안해요'],
    bye: ['다음엔 더 맛있게 준비해 둘게요', '또 놀러 와 주세요! 기다릴게요', '오늘도 행복 가득한 하루 보내세요'],
  },
};

const PRAISE_LINES = {
  tasty: ['맛있게 드셨다니 정말 다행이에요', '음식 맛을 좋게 봐주셔서 큰 힘이 됩니다'],
  kind: ['친절하다고 해주셔서 감사해요. 앞으로도 늘 웃으며 맞이할게요', '응대까지 좋게 봐주셔서 감사합니다'],
  fast: ['빠르게 받아보셨다니 다행이에요', '따뜻할 때 드실 수 있도록 앞으로도 신속히 준비하겠습니다'],
  plenty: ['넉넉하게 드셨다니 기쁩니다', '배부르게 드셨다니 저희도 뿌듯해요'],
  again: ['다시 찾아주신다는 말씀이 가장 큰 응원이에요', '단골이 되어주셔서 늘 감사한 마음입니다'],
  clean: ['깔끔함은 저희가 제일 신경 쓰는 부분이라 더 기쁩니다', '위생과 신선함은 앞으로도 꼭 지키겠습니다'],
};

const FIX_LINES = {
  late: '배달이 늦어진 부분은 주문 몰리는 시간대 조리 동선을 다시 점검하고 배달 대행사와도 공유하겠습니다',
  cold: '음식이 식어서 도착한 점, 포장 보온과 출발 시간을 더 꼼꼼히 챙기겠습니다',
  taste: '말씀해 주신 맛 부분은 레시피와 간을 다시 확인해 보겠습니다',
  portion: '양에 대한 의견도 소중히 듣고 구성과 양을 다시 검토하겠습니다',
  foreign: '이물질 문제는 절대 있어서는 안 되는 일입니다. 조리 공간 위생 점검을 바로 진행하겠습니다',
  missing: '누락된 메뉴는 정말 죄송합니다. 포장 마감 전 확인 절차를 한 번 더 두겠습니다',
  rude: '응대로 기분 상하셨다니 죄송합니다. 직원 모두와 다시 이야기 나누겠습니다',
  package: '포장 문제로 불편을 드렸네요. 용기와 포장 방법을 바로 바꿔보겠습니다',
  price: '가격 대비 만족을 드릴 수 있도록 구성과 품질을 더 고민하겠습니다',
};

const EMOJI = { positive: ['😊', '🙏', '💛', '🥰'], negative: ['🙏'], mixed: ['🙂', '🙏'] };

function hasFinalConsonant(word) {
  // 한글 마지막 글자에 받침이 있으면 "이에요", 없으면 "예요"를 붙인다.
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  return code >= 0 && code <= 11171 && code % 28 !== 0;
}

function sentenceEnd(s) {
  return /[.!?~요다]$/.test(s) ? (/[요다]$/.test(s) ? `${s}.` : s) : `${s}.`;
}

export function generateLocal(review, store) {
  const analysis = analyzeReview(review);
  const pick = seeded(`${review.content}|${review.rating}|${store.name}`);
  const tone = TONES[store.tone] || TONES.friendly;
  const storeName = store.name?.trim() || '저희 가게';
  const author = review.author?.trim();
  const fill = (s) =>
    s
      .replaceAll('{store}', storeName)
      .replaceAll('{yeyo}', hasFinalConsonant(storeName) ? '이에요' : '예요')
      .replaceAll('{name}', author ? ` ${author}님` : '');
  const emojiOn = store.emoji !== 'none';
  const emoji = (kind) => (emojiOn ? ` ${pick(EMOJI[kind] || EMOJI.positive)}` : '');
  const menu = review.menu?.trim();
  // 불만·악성 리뷰에는 말투 설정과 상관없이 차분한 인사로 시작한다.
  const helloPool = analysis.sentiment === 'positive' ? tone.hello : [TONES.polite.hello[2]];
  const greeting = store.greeting?.trim() ? store.greeting.trim() : fill(pick(helloPool));
  const signature = store.signature?.trim();

  const parts = { opening: sentenceEnd(greeting), body: [], closing: '' };
  const fixes = [];
  if (analysis.sentiment === 'positive') {
    parts.body.push(sentenceEnd(pick(tone.thanks)) + emoji('positive'));
    for (const p of analysis.praises.slice(0, 2)) parts.body.push(sentenceEnd(pick(PRAISE_LINES[p.key])));
    if (menu) parts.body.push(`${menu} 마음에 드셨다니 더 정성껏 만들게요.`);
  } else {
    parts.body.push(sentenceEnd(analysis.sentiment === 'negative' ? pick(tone.sorry) : pick(tone.thanks)));
    for (const p of analysis.praises.slice(0, 1)) parts.body.push(sentenceEnd(pick(PRAISE_LINES[p.key])));
    fixes.push(...analysis.complaints.slice(0, 2).map((c) => sentenceEnd(FIX_LINES[c.key])));
    if (fixes.length) parts.body.push(...fixes);
    else parts.body.push('남겨주신 의견을 하나하나 다시 살펴보고 부족한 점을 고치겠습니다.');
    if (analysis.sentiment === 'negative') {
      parts.body.push('불편하셨던 부분은 매장으로 연락 주시면 꼭 다시 확인하고 챙겨드리겠습니다.');
    }
  }
  parts.closing = sentenceEnd(pick(tone.bye)) + (analysis.sentiment === 'positive' ? emoji('positive') : '');

  const sign = signature ? `\n${signature}` : '';
  const standard = [parts.opening, ...parts.body, parts.closing].join(' ') + sign;
  const short = [parts.opening, parts.body[0], fixes[0], parts.closing].filter(Boolean).join(' ') + sign;
  const warmExtra =
    analysis.sentiment === 'positive'
      ? '바쁘신 와중에 시간 내어 글까지 남겨주신 마음 덕분에 오늘 하루도 힘내서 준비합니다.'
      : '한 분 한 분의 식사가 저희에게는 가장 중요하기에, 이번 일을 계기로 더 나아진 모습 보여드리겠습니다.';
  const warm = [parts.opening, ...parts.body, warmExtra, parts.closing].join(' ') + sign;

  const drafts = [
    { label: '기본', text: standard },
    { label: '짧게', text: short },
    { label: '정성 가득', text: warm },
  ];

  let calmReply = '';
  let guidance = '';
  if (analysis.isMalicious) {
    calmReply =
      `안녕하세요, ${storeName}입니다. 이용 후 의견 남겨주셔서 감사합니다. ` +
      '말씀하신 내용은 주문 내역과 매장 상황을 함께 확인하고 있으나, 구체적인 상황을 알기 어려워 정확한 확인이 필요합니다. ' +
      '불편하신 점이 있으셨다면 매장으로 직접 연락 주시면 성실히 확인해 드리겠습니다. 다른 고객님들께서도 참고하실 수 있도록 정중히 답변드립니다.' +
      sign;
    guidance = [
      '1) 욕설·비방·허위 내용은 답글보다 먼저 플랫폼의 "리뷰 신고(게시 중단 요청)" 기능을 이용하세요.',
      '2) 답글에는 감정적인 반박, 고객 개인정보, 주문 상세 내용을 쓰지 마세요.',
      '3) 주문 내역·통화 기록·사진 등 증빙을 캡처해 보관하세요.',
      '4) 보상을 조건으로 별점을 요구하면 응하지 말고 플랫폼 고객센터에 알리세요.',
    ].join('\n');
  }

  return {
    sentiment: analysis.sentiment,
    isMalicious: analysis.isMalicious,
    maliciousReason: analysis.maliciousReason,
    keyPoints: [...analysis.praises.map((p) => p.label), ...analysis.complaints.map((c) => c.label)],
    drafts,
    calmReply,
    guidance,
  };
}
