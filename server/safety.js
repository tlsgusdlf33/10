// 안전 필터: 답글에 개인정보, 과장·허위 광고 표현, 리뷰어를 비난하는 표현이 들어가지 않게 한다.
// - 개인정보(전화번호·이메일·상세 주소)는 자동으로 가린다.
// - 과장 광고·비난·사장님 금지어는 경고로 표시하고, 승인할 때 한 번 더 확인받는다.

const PII_PATTERNS = [
  { label: '전화번호', re: /(?<!\d)(?:\+?82[-.\s]?)?0\d{1,2}[-.\s)]?\d{3,4}[-.\s]?\d{4}(?!\d)/g },
  { label: '전화번호', re: /(?<!\d)1[5-9]\d{2}[-.\s]?\d{4}(?!\d)/g }, // 1588-0000 같은 대표번호
  { label: '이메일', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  // 도로명 주소: "역삼로 123", "테헤란로10길 5-2". 뒤에 개·줄·인분 같은 단위가 붙으면 주소가 아니다.
  { label: '상세 주소', re: /[가-힣][가-힣0-9]+(?:대로|로|길)\s?\d{1,4}(?:-\d{1,4})?(?![가-힣0-9])(?:,?\s?\d+동)?(?:\s?\d+호)?/g },
  { label: '상세 주소', re: /\d+동\s?\d+호/g },
];

const EXAGGERATION = [
  '세계 최고', '대한민국 최고', '국내 최고', '업계 최고', '최초', '100%', '백퍼센트', '무조건', '절대 실패',
  '완치', '치료', '병이 낫', '다이어트 효과', '살 안 찌', '효과 보장', '부작용 없', '평생 보장',
];

const BLAME = [
  '거짓말', '허위 리뷰', '블랙컨슈머', '진상', '고객님 잘못', '고객님 탓', '이해력', '어이가 없', '어이없',
  '황당하', '고소하겠', '고소할', '법적 조치', '신고하겠', '다시 오지 마', '오지 마세요', '주문하지 마',
];

export function maskPII(text) {
  let found = [];
  let out = String(text || '');
  for (const { label, re } of PII_PATTERNS) {
    out = out.replace(re, () => {
      found.push(label);
      return '[개인정보]';
    });
  }
  found = [...new Set(found)];
  return { text: out, found };
}

function findTerms(text, terms) {
  const compact = text.replace(/\s+/g, '');
  return terms.filter((t) => compact.includes(t.replace(/\s+/g, '')));
}

function storeAvoidWords(store) {
  return String(store?.avoid_words || '')
    .split(/[,\n]/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2);
}

/**
 * 답글 한 개를 점검한다. 개인정보는 가린 문장을 돌려주고, 나머지는 경고 목록으로 돌려준다.
 * @returns {{ text: string, warnings: string[] }}
 */
export function checkReply(text, store) {
  const { text: masked, found } = maskPII(text);
  const warnings = [];
  if (found.length) warnings.push(`개인정보(${found.join(', ')})를 자동으로 가렸어요.`);
  const exaggeration = findTerms(masked, EXAGGERATION);
  if (exaggeration.length) warnings.push(`과장·허위 광고로 보일 수 있는 표현: ${exaggeration.join(', ')}`);
  const blame = findTerms(masked, BLAME);
  if (blame.length) warnings.push(`리뷰어를 비난하는 표현: ${blame.join(', ')}`);
  const avoid = findTerms(masked, storeAvoidWords(store));
  if (avoid.length) warnings.push(`사장님이 쓰지 말라고 한 표현: ${avoid.join(', ')}`);
  return { text: masked, warnings };
}

/** 생성 결과(초안들과 대응 문구)를 모두 점검해 가린 문장과 경고를 붙인다. */
export function applySafety(result, store) {
  const drafts = result.drafts.map((d) => {
    const checked = checkReply(d.text, store);
    return { ...d, text: checked.text, warnings: checked.warnings };
  });
  const calm = result.calmReply ? checkReply(result.calmReply, store) : { text: '', warnings: [] };
  return { ...result, drafts, calmReply: calm.text, calmWarnings: calm.warnings };
}
