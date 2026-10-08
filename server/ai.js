// AI 답글 생성: Claude API 로 가게 말투에 맞춘 답글 초안을 만든다.
// - 사장님이 승인한 과거 답글을 예시로 넣어, 쓸수록 가게 말투에 가까워진다.
// - 리뷰 속 개인정보(전화번호·주소)는 가린 뒤 보낸다.
// - API 키가 없거나 호출이 실패하면 내장 문장 엔진(templates.js)으로 자동 전환해 서비스가 멈추지 않게 한다.
import Anthropic from '@anthropic-ai/sdk';
import { PLATFORMS } from './platforms.js';
import { maskPII } from './safety.js';
import { COMPLAINT_TAGS, PRAISE_TAGS, generateLocal } from './templates.js';

const TONE_TEXT = {
  friendly: '친근하고 따뜻한 말투 (해요체, 동네 단골에게 말하듯)',
  polite: '정중하고 격식 있는 말투 (합니다체)',
  cheerful: '밝고 유쾌한 말투 (해요체, 느낌표와 의성어를 적당히)',
};
const EMOJI_TEXT = { none: '이모지를 쓰지 않는다', some: '이모지를 1~2개만 쓴다', many: '이모지를 3~5개 자연스럽게 쓴다' };

const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    sentiment: { type: 'string', enum: ['positive', 'mixed', 'negative'] },
    is_malicious: { type: 'boolean' },
    malicious_reason: { type: 'string' },
    praise_tags: { type: 'array', items: { type: 'string', enum: PRAISE_TAGS } },
    complaint_tags: { type: 'array', items: { type: 'string', enum: COMPLAINT_TAGS } },
    drafts: {
      type: 'array',
      items: {
        type: 'object',
        properties: { label: { type: 'string' }, text: { type: 'string' } },
        required: ['label', 'text'],
        additionalProperties: false,
      },
    },
    calm_reply: { type: 'string' },
  },
  required: ['sentiment', 'is_malicious', 'malicious_reason', 'praise_tags', 'complaint_tags', 'drafts', 'calm_reply'],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `당신은 한국 소상공인(식당·카페·가게) 사장님을 대신해 배달앱·지도앱 리뷰에 달 답글 초안을 쓰는 도우미입니다.
사장님은 초안을 확인한 뒤 직접 게시하므로, 그대로 붙여넣어도 자연스러운 완성된 답글을 써야 합니다.

답글 원칙:
- 가게 정보에 적힌 말투·이모지 사용량·인사말·사장님 호칭·맺음말을 따릅니다.
- "사장님이 승인한 과거 답글"이 있으면 그 문체·길이·자주 쓰는 표현을 가장 우선해서 닮게 씁니다.
- 리뷰에 나온 구체적인 내용(메뉴, 칭찬한 점, 불편했던 점)을 한두 가지 짚어서, 복사해 붙인 듯한 답글이 되지 않게 합니다.
- 별점에 맞춰 톤을 조절합니다: 5점은 감사 중심으로 밝게, 4점은 감사와 함께 아쉬운 점이 있으면 짚고, 3점은 감사와 개선 약속을 균형 있게, 1~2점은 첫 문장부터 진심 어린 사과와 구체적인 개선 약속을 담고 밝은 표현·이모지는 자제합니다.
- 대표 메뉴는 긍정 리뷰에서 자연스러울 때만 한 번 권합니다.
- 사장님이 확인하지 않은 사실(환불·쿠폰·서비스 제공, 직원 징계, 원인 단정)을 약속하거나 인정하지 않습니다. 필요하면 "매장으로 연락 주시면 확인해 드리겠습니다"처럼 안내합니다.
- 고객의 개인정보·주문 상세·전화번호·주소를 쓰지 않습니다. 리뷰어를 비난하거나 가르치려 들지 않습니다.
- "최고", "100%", "무조건", 건강·효능 주장 같은 과장·허위 광고 표현을 쓰지 않습니다. 금지어 목록에 있는 표현은 쓰지 않습니다.
- 각 답글은 공백 포함 300자 이내로, 줄바꿈은 맺음말 서명 앞에만 씁니다.

출력:
- drafts 에는 서로 느낌이 다른 초안 2개를 담습니다: label 은 "기본", "짧고 담백하게"(2~3문장).
- praise_tags, complaint_tags 에는 리뷰에 나온 칭찬·불만 요소를 목록에서 골라 담습니다 (없으면 빈 배열).
- 욕설·비방, 보상을 조건으로 한 별점 압박, 주문·이용과 무관한 공격, 허위로 의심되는 내용, 경쟁업체로 의심되는 비방이면 is_malicious 를 true 로 하고 malicious_reason 에 이유를 한 문장으로 씁니다.
  이때 calm_reply 에는 감정을 싣지 않고 사실 확인을 정중히 요청하는 대응 답글을 씁니다.
- 악성이 아니면 malicious_reason, calm_reply 는 빈 문자열로 둡니다.`;

const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    reviews: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          platform: { type: 'string', enum: Object.keys(PLATFORMS) },
          rating: { type: 'integer', enum: [0, 1, 2, 3, 4, 5] },
          author: { type: 'string' },
          menu: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['platform', 'rating', 'author', 'menu', 'content'],
        additionalProperties: false,
      },
    },
  },
  required: ['reviews'],
  additionalProperties: false,
};

const EXTRACT_PROMPT = `이 이미지는 배달앱·지도앱 리뷰 화면을 캡처한 것입니다. 화면에 보이는 고객 리뷰를 모두 찾아 옮겨 적어 주세요.
- content 에는 고객이 쓴 리뷰 본문만 그대로 옮깁니다 (사장님 답글, 광고, 버튼 글자 제외).
- rating 은 채워진 별 개수(1~5)이고, 보이지 않으면 0 입니다.
- platform 은 화면 디자인·로고로 판단하고, 모르겠으면 etc 입니다. (baemin=배달의민족, coupangeats=쿠팡이츠, yogiyo=요기요, naver=네이버, kakao=카카오맵, google=구글)
- author 는 닉네임, menu 는 주문 메뉴가 보이면 적고, 없으면 빈 문자열입니다.
- 리뷰가 없으면 reviews 를 빈 배열로 둡니다.`;

function storeBlock(store) {
  const lines = [
    `가게 이름: ${store.name || '(미입력)'}`,
    `업종: ${store.category || '(미입력)'}`,
    `말투: ${TONE_TEXT[store.tone] || TONE_TEXT.friendly}`,
    `이모지: ${EMOJI_TEXT[store.emoji] || EMOJI_TEXT.some}`,
  ];
  if (store.owner_title) lines.push(`사장님 호칭(인사할 때 "가게 이름 + 호칭"으로 소개): ${store.owner_title}`);
  if (store.signature_menus) lines.push(`대표 메뉴: ${store.signature_menus}`);
  if (store.greeting) lines.push(`인사말(첫 문장으로 사용): ${store.greeting}`);
  if (store.signature) lines.push(`맺음말 서명(마지막 줄에 그대로 사용): ${store.signature}`);
  if (store.avoid_words) lines.push(`쓰면 안 되는 표현: ${store.avoid_words}`);
  if (store.notes) lines.push(`사장님 메모(참고 사항): ${store.notes}`);
  if (store.sample_replies) lines.push(`사장님이 직접 넣은 답글 예시:\n${store.sample_replies}`);
  return lines.join('\n');
}

function examplesBlock(examples) {
  if (!examples?.length) return '';
  const items = examples.map(
    (e, i) => `예시 ${i + 1} (별점 ${e.rating}점)\n<review>\n${maskPII(e.content).text}\n</review>\n<owner_reply>\n${e.reply}\n</owner_reply>`,
  );
  return `\n\n[사장님이 승인한 과거 답글 — 이 말투를 닮게 쓰세요]\n${items.join('\n\n')}`;
}

function reviewBlock(review) {
  return [
    `플랫폼: ${PLATFORMS[review.platform]?.name || review.platform}`,
    `별점: ${review.rating}점 / 5점`,
    review.author ? `작성자 닉네임: ${maskPII(review.author).text}` : null,
    review.menu ? `주문 메뉴: ${review.menu}` : null,
    `리뷰 내용:\n<review>\n${maskPII(review.content).text}\n</review>`,
  ]
    .filter(Boolean)
    .join('\n');
}

function normalize(result) {
  const drafts = Array.isArray(result.drafts)
    ? result.drafts.filter((d) => d && typeof d.text === 'string' && d.text.trim()).slice(0, 2)
    : [];
  if (!drafts.length) throw new Error('AI 응답에 답글 초안이 없습니다.');
  const praises = (result.praise_tags || []).filter((t) => PRAISE_TAGS.includes(t));
  const complaints = (result.complaint_tags || []).filter((t) => COMPLAINT_TAGS.includes(t));
  return {
    sentiment: ['positive', 'mixed', 'negative'].includes(result.sentiment) ? result.sentiment : 'mixed',
    isMalicious: Boolean(result.is_malicious),
    maliciousReason: String(result.malicious_reason || ''),
    keyPoints: [...praises, ...complaints].slice(0, 5),
    praises,
    complaints,
    drafts: drafts.map((d) => ({ label: String(d.label || '초안'), text: d.text.trim() })),
    calmReply: String(result.calm_reply || '').trim(),
  };
}

function textOf(response) {
  if (response.stop_reason === 'refusal') throw new Error('AI 가 이 요청을 거절했습니다.');
  if (response.stop_reason === 'max_tokens') throw new Error('AI 응답이 길이 제한으로 잘렸습니다.');
  return response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

export function createGenerator(config, { logger = console, fetch } = {}) {
  const client = config.anthropicApiKey
    ? new Anthropic({ apiKey: config.anthropicApiKey, maxRetries: 2, timeout: 60_000, ...(fetch ? { fetch } : {}) })
    : null;

  async function send(request) {
    try {
      // 안전 분류기가 거절하면 서버 측에서 권장 모델로 다시 시도하도록 fallbacks 를 켠다.
      return await client.beta.messages.create({
        ...request,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      });
    } catch (err) {
      // 모델을 바꿔서 fallbacks 를 지원하지 않는 경우 등: 기본 요청으로 한 번 더 시도한다.
      if (!(err instanceof Anthropic.BadRequestError)) throw err;
      return client.messages.create(request);
    }
  }

  function outputConfig(schema) {
    return {
      // ANTHROPIC_EFFORT 를 비우면 effort 를 보내지 않는다 (effort 를 지원하지 않는 모델용).
      ...(config.anthropicEffort ? { effort: config.anthropicEffort } : {}),
      format: { type: 'json_schema', schema },
    };
  }

  async function callClaude(review, store, examples) {
    const response = await send({
      model: config.anthropicModel,
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      output_config: outputConfig(RESULT_SCHEMA),
      messages: [
        {
          role: 'user',
          content: `[가게 정보]\n${storeBlock(store)}${examplesBlock(examples)}\n\n[답글을 달 리뷰]\n${reviewBlock(review)}\n\n위 리뷰에 대한 답글 초안을 작성해 주세요.`,
        },
      ],
    });
    return normalize(JSON.parse(textOf(response)));
  }

  return {
    engine: client ? 'claude' : 'local',
    canReadImages: Boolean(client),

    /** @param {{examples?: {rating:number, content:string, reply:string}[]}} [options] */
    async generate(review, store, { examples = [] } = {}) {
      if (!client) return { ...generateLocal(review, store), engine: 'local' };
      try {
        return { ...(await callClaude(review, store, examples)), engine: 'claude' };
      } catch (err) {
        const detail = err instanceof Anthropic.APIError ? `API ${err.status}: ${err.message}` : err.message;
        logger.warn(`[ai] Claude 호출 실패, 내장 엔진으로 대체합니다 - ${detail}`);
        return { ...generateLocal(review, store), engine: 'local', warning: 'AI 연결이 원활하지 않아 기본 문장 엔진으로 만들었어요.' };
      }
    },

    /** 리뷰 화면 캡처에서 리뷰를 읽어 낸다 (OCR). */
    async extractFromImage(base64, mediaType) {
      if (!client) throw new Error('캡처 인식은 AI 키(ANTHROPIC_API_KEY)가 설정되어 있어야 사용할 수 있어요.');
      const response = await send({
        model: config.anthropicModel,
        max_tokens: 4000,
        output_config: outputConfig(EXTRACT_SCHEMA),
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
              { type: 'text', text: EXTRACT_PROMPT },
            ],
          },
        ],
      });
      const parsed = JSON.parse(textOf(response));
      return (parsed.reviews || [])
        .filter((r) => r && typeof r.content === 'string' && r.content.trim())
        .slice(0, 10)
        .map((r) => ({
          platform: PLATFORMS[r.platform] ? r.platform : 'etc',
          rating: Number.isInteger(r.rating) && r.rating >= 1 && r.rating <= 5 ? r.rating : null,
          author: String(r.author || '').slice(0, 50),
          menu: String(r.menu || '').slice(0, 100),
          content: r.content.trim().slice(0, 3000),
        }));
    },
  };
}
