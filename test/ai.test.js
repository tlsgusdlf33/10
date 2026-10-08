import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGenerator } from '../server/ai.js';

const config = { anthropicApiKey: 'test-key', anthropicModel: 'claude-opus-5-5', anthropicEffort: 'low' };
const review = { platform: 'baemin', rating: 5, content: '떡볶이 맛있어요 010-1234-5678 로 연락주세요', author: '', menu: '' };
const store = { name: '행복분식', tone: 'friendly', emoji: 'some' };
const quiet = { warn() {} };

const aiResult = {
  sentiment: 'positive',
  is_malicious: false,
  malicious_reason: '',
  praise_tags: ['맛 칭찬'],
  complaint_tags: [],
  drafts: [
    { label: '기본', text: '맛있게 드셔주셔서 감사해요!' },
    { label: '짧고 담백하게', text: '감사합니다!' },
  ],
  calm_reply: '',
};

function messageResponse(result, stop = 'end_turn') {
  return new Response(
    JSON.stringify({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [{ type: 'text', text: JSON.stringify(result) }],
      stop_reason: stop,
      usage: { input_tokens: 10, output_tokens: 10 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

test('Claude 응답을 정리해서 돌려주고, 요청에 구조화 출력과 fallbacks 를 담는다', async () => {
  const bodies = [];
  const fetch = async (url, init) => {
    bodies.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return messageResponse(aiResult);
  };
  const gen = createGenerator(config, { fetch, logger: quiet });
  assert.equal(gen.engine, 'claude');
  const out = await gen.generate(review, store);
  assert.equal(out.engine, 'claude');
  assert.equal(out.drafts.length, 2);
  assert.deepEqual(out.keyPoints, ['맛 칭찬']);
  assert.deepEqual(out.praises, ['맛 칭찬']);
  const sent = bodies[0].body;
  assert.equal(sent.model, 'claude-opus-5-5');
  assert.equal(sent.fallbacks, 'default');
  assert.equal(sent.output_config.effort, 'low');
  assert.equal(sent.output_config.format.type, 'json_schema');
  assert.ok(sent.messages[0].content.includes('행복분식'));
  assert.ok(!sent.messages[0].content.includes('010-1234-5678'), '개인정보는 가린 뒤 보낸다');
});

test('fallbacks 요청이 400 이면 기본 요청으로 다시 시도한다', async () => {
  const bodies = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (body.fallbacks) {
      return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'unsupported' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }
    return messageResponse(aiResult);
  };
  const out = await createGenerator(config, { fetch, logger: quiet }).generate(review, store);
  assert.equal(out.engine, 'claude');
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].fallbacks, undefined);
});

test('API 장애나 거절이면 내장 엔진으로 대체하고 안내 문구를 붙인다', async () => {
  const down = async () => {
    throw new TypeError('network down');
  };
  const out = await createGenerator({ ...config }, { fetch: down, logger: quiet }).generate(review, store);
  assert.equal(out.engine, 'local');
  assert.ok(out.warning);
  assert.equal(out.drafts.length, 2);

  const refuse = async () => messageResponse(aiResult, 'refusal');
  const out2 = await createGenerator(config, { fetch: refuse, logger: quiet }).generate(review, store);
  assert.equal(out2.engine, 'local');
});

test('키가 없으면 내장 엔진', async () => {
  const gen = createGenerator({ ...config, anthropicApiKey: '' });
  assert.equal(gen.engine, 'local');
  assert.equal((await gen.generate(review, store)).engine, 'local');
});

test('승인한 과거 답글을 말투 예시로 함께 보낸다', async () => {
  const bodies = [];
  const fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return messageResponse(aiResult);
  };
  const examples = [{ rating: 5, content: '최고예요', reply: '감사합니다 단골님~ 행복분식 이모가' }];
  await createGenerator(config, { fetch, logger: quiet }).generate(review, { ...store, owner_title: '이모' }, { examples });
  const content = bodies[0].messages[0].content;
  assert.ok(content.includes('사장님이 승인한 과거 답글'));
  assert.ok(content.includes('행복분식 이모가'));
  assert.ok(content.includes('사장님 호칭'));
});

test('캡처 이미지에서 리뷰를 읽어 낸다', async () => {
  const bodies = [];
  const fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return messageResponse({ reviews: [{ platform: 'coupangeats', rating: 2, author: '배고파', menu: '', content: '너무 늦게 왔어요' }] });
  };
  const gen = createGenerator(config, { fetch, logger: quiet });
  const reviews = await gen.extractFromImage('aGVsbG8=', 'image/png');
  assert.deepEqual(reviews, [{ platform: 'coupangeats', rating: 2, author: '배고파', menu: '', content: '너무 늦게 왔어요' }]);
  assert.equal(bodies[0].messages[0].content[0].type, 'image');
  await assert.rejects(createGenerator({ ...config, anthropicApiKey: '' }).extractFromImage('aGVsbG8=', 'image/png'));
});
