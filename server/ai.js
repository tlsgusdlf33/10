// AI 답글 생성: Claude API 로 가게 말투에 맞춘 답글 초안을 만든다.
// API 키가 없거나 호출이 실패하면 내장 문장 엔진(templates.js)으로 자동 전환해 서비스가 멈추지 않게 한다.
import Anthropic from '@anthropic-ai/sdk';
import { generateLocal } from './templates.js';

const TONE_TEXT = {
  friendly: '친근하고 따뜻한 말투 (해요체, 동네 단골에게 말하듯)',
  polite: '정중하고 격식 있는 말투 (합니다체)',
  cheerful: '밝고 유쾌한 말투 (해요체, 느낌표와 의성어를 적당히)',
};
const EMOJI_TEXT = { none: '이모지를 쓰지 않는다', some: '이모지를 1~2개만 쓴다', many: '이모지를 3~5개 자연스럽게 쓴다' };

export const PLATFORMS = {
  baemin: '배달의민족',
  coupangeats: '쿠팡이츠',
  yogiyo: '요기요',
  naver: '네이버 지도(플레이스)',
  kakao: '카카오맵',
  google: '구글 지도',
  etc: '기타',
};

const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    sentiment: { type: 'string', enum: ['positive', 'mixed', 'negative'] },
    is_malicious: { type: 'boolean' },
    malicious_reason: { type: 'string' },
    key_points: { type: 'array', items: { type: 'string' } },
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
    guidance: { type: 'string' },
  },
  required: ['sentiment', 'is_malicious', 'malicious_reason', 'key_points', 'drafts', 'calm_reply', 'guidance'],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `당신은 한국 소상공인(식당·카페·가게) 사장님을 대신해 배달앱·지도앱 리뷰에 달 답글 초안을 쓰는 도우미입니다.
사장님은 초안을 확인한 뒤 직접 게시하므로, 그대로 붙여넣어도 자연스러운 완성된 답글을 써야 합니다.

답글 원칙:
- 가게 정보에 적힌 말투·이모지 사용량·인사말·맺음말을 따르고, 예시 답글이 있으면 그 문체를 닮게 씁니다.
- 리뷰에 나온 구체적인 내용(메뉴, 칭찬한 점, 불편했던 점)을 한두 가지 짚어서, 복사해 붙인 듯한 답글이 되지 않게 합니다.
- 칭찬에는 감사를, 불만에는 변명 없이 사과와 구체적인 개선 약속을 담습니다.
- 사장님이 확인하지 않은 사실(환불·쿠폰·서비스 제공, 직원 징계, 원인 단정)을 약속하거나 인정하지 않습니다. 필요하면 "매장으로 연락 주시면 확인해 드리겠습니다"처럼 안내합니다.
- 고객의 개인정보·주문 상세·전화번호를 쓰지 않습니다. 금지어 목록에 있는 표현은 쓰지 않습니다.
- 각 답글은 공백 포함 300자 이내로, 줄바꿈은 맺음말 서명 앞에만 씁니다.

출력:
- drafts 에는 서로 느낌이 다른 초안 3개를 담습니다: label 은 "기본", "짧게"(2~3문장), "정성 가득"(조금 더 길고 따뜻하게).
- key_points 에는 리뷰의 핵심(칭찬·불만 요소)을 짧은 명사구로 0~4개 적습니다.
- 욕설·비방, 보상을 조건으로 한 별점 압박, 사실과 무관한 공격, 경쟁업체로 의심되는 비방이면 is_malicious 를 true 로 하고 malicious_reason 에 이유를 한 문장으로 씁니다.
  이때 calm_reply 에는 감정을 싣지 않고 사실 확인을 정중히 요청하는 대응 답글을, guidance 에는 사장님이 취할 조치(플랫폼 신고, 증빙 보관 등)를 번호 목록으로 씁니다.
- 악성이 아니면 malicious_reason, calm_reply, guidance 는 빈 문자열로 둡니다.`;

function storeBlock(store) {
  const lines = [
    `가게 이름: ${store.name || '(미입력)'}`,
    `업종: ${store.category || '(미입력)'}`,
    `말투: ${TONE_TEXT[store.tone] || TONE_TEXT.friendly}`,
    `이모지: ${EMOJI_TEXT[store.emoji] || EMOJI_TEXT.some}`,
  ];
  if (store.greeting) lines.push(`인사말(첫 문장으로 사용): ${store.greeting}`);
  if (store.signature) lines.push(`맺음말 서명(마지막 줄에 그대로 사용): ${store.signature}`);
  if (store.avoid_words) lines.push(`쓰면 안 되는 표현: ${store.avoid_words}`);
  if (store.notes) lines.push(`사장님 메모(참고 사항): ${store.notes}`);
  if (store.sample_replies) lines.push(`평소 사장님이 쓰는 답글 예시:\n${store.sample_replies}`);
  return lines.join('\n');
}

function reviewBlock(review) {
  return [
    `플랫폼: ${PLATFORMS[review.platform] || review.platform}`,
    `별점: ${review.rating}점 / 5점`,
    review.author ? `작성자 닉네임: ${review.author}` : null,
    review.menu ? `주문 메뉴: ${review.menu}` : null,
    `리뷰 내용:\n<review>\n${review.content}\n</review>`,
  ]
    .filter(Boolean)
    .join('\n');
}

function normalize(result) {
  const drafts = Array.isArray(result.drafts)
    ? result.drafts.filter((d) => d && typeof d.text === 'string' && d.text.trim()).slice(0, 3)
    : [];
  if (!drafts.length) throw new Error('AI 응답에 답글 초안이 없습니다.');
  return {
    sentiment: ['positive', 'mixed', 'negative'].includes(result.sentiment) ? result.sentiment : 'mixed',
    isMalicious: Boolean(result.is_malicious),
    maliciousReason: String(result.malicious_reason || ''),
    keyPoints: Array.isArray(result.key_points) ? result.key_points.map(String).slice(0, 4) : [],
    drafts: drafts.map((d) => ({ label: String(d.label || '초안'), text: d.text.trim() })),
    calmReply: String(result.calm_reply || '').trim(),
    guidance: String(result.guidance || '').trim(),
  };
}

export function createGenerator(config, { logger = console, fetch } = {}) {
  const client = config.anthropicApiKey
    ? new Anthropic({ apiKey: config.anthropicApiKey, maxRetries: 2, timeout: 60_000, ...(fetch ? { fetch } : {}) })
    : null;

  async function callClaude(review, store) {
    const request = {
      model: config.anthropicModel,
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      output_config: {
        // ANTHROPIC_EFFORT 를 비우면 effort 를 보내지 않는다 (effort 를 지원하지 않는 모델용).
        ...(config.anthropicEffort ? { effort: config.anthropicEffort } : {}),
        format: { type: 'json_schema', schema: RESULT_SCHEMA },
      },
      messages: [
        {
          role: 'user',
          content: `[가게 정보]\n${storeBlock(store)}\n\n[답글을 달 리뷰]\n${reviewBlock(review)}\n\n위 리뷰에 대한 답글 초안을 작성해 주세요.`,
        },
      ],
    };
    let response;
    try {
      // 안전 분류기가 거절하면 서버 측에서 권장 모델로 다시 시도하도록 fallbacks 를 켠다.
      response = await client.beta.messages.create({
        ...request,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      });
    } catch (err) {
      // 모델을 바꿔서 fallbacks 를 지원하지 않는 경우 등: 기본 요청으로 한 번 더 시도한다.
      if (!(err instanceof Anthropic.BadRequestError)) throw err;
      response = await client.messages.create(request);
    }
    if (response.stop_reason === 'refusal') throw new Error('AI 가 이 리뷰에 대한 답글 생성을 거절했습니다.');
    if (response.stop_reason === 'max_tokens') throw new Error('AI 응답이 길이 제한으로 잘렸습니다.');
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    return normalize(JSON.parse(text));
  }

  return {
    engine: client ? 'claude' : 'local',
    async generate(review, store) {
      if (!client) return { ...generateLocal(review, store), engine: 'local' };
      try {
        return { ...(await callClaude(review, store)), engine: 'claude' };
      } catch (err) {
        const detail = err instanceof Anthropic.APIError ? `API ${err.status}: ${err.message}` : err.message;
        logger.warn(`[ai] Claude 호출 실패, 내장 엔진으로 대체합니다 - ${detail}`);
        return { ...generateLocal(review, store), engine: 'local', warning: 'AI 연결이 원활하지 않아 기본 문장 엔진으로 만들었어요.' };
      }
    },
  };
}
