/**
 * dsh-image-vision-bridge v2 离线自测:不启动 harness,仅验证核心逻辑。
 * 运行:cd "$DSH_HOME/profiles" && node node_modules/dsh-image-vision-bridge/test/transform.test.mjs
 */
import assert from 'node:assert/strict';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { internals } from '../lib/index.js';

const {
  bridgeStream, clipDescription, imageBlockText, imagesOf, onLlmStream,
  resolveConfig, rewriteContent, rewriteRequest, textOf,
} = internals;

let passed = 0;
function ok(label) {
  passed += 1;
  console.log(`ok ${passed} - ${label}`);
}

// --- resolveConfig ---
const cfg = resolveConfig({});
assert.equal(cfg.provider, 'opencode-go');
assert.equal(cfg.model, 'mimo-v2.5');
assert.equal(cfg.enabled, true);
const cfg2 = resolveConfig({ provider: 'x', model: 'y', maxTokens: 100, prompt: 'p', enabled: false });
assert.equal(cfg2.provider, 'x');
assert.equal(cfg2.model, 'y');
assert.equal(cfg2.maxTokens, 100);
assert.equal(cfg2.enabled, false);
ok('resolveConfig 默认值与覆盖');

// --- clipDescription ---
assert.equal(clipDescription('abc', 10), 'abc');
assert.ok(clipDescription('a'.repeat(100), 10).includes('[已截断'));
ok('clipDescription 截断');

// --- 构造含图片的消息 ---
const ref = {
  attachmentId: 'att-1',
  mediaType: 'image/png',
  bytes: 100,
  width: 800,
  height: 600,
  name: 'shot.png',
};
const imageMessage = createUserMessage({
  content: [
    { type: 'text', text: '这是截图' },
    { type: 'image', attachment: ref },
  ],
  source: { kind: 'user' },
});
assert.equal(imagesOf(imageMessage.content).length, 1);
assert.equal(textOf(imageMessage.content), '这是截图');
ok('imagesOf / textOf');

// --- imageBlockText 成功/失败 ---
const okText = imageBlockText(imagesOf(imageMessage.content), { text: '描述内容' }, cfg);
assert.ok(okText.includes('shot.png') && okText.includes('描述内容'));
const failText = imageBlockText(imagesOf(imageMessage.content), { error: 'boom' }, cfg);
assert.ok(failText.includes('分析失败') && failText.includes('boom'));
ok('imageBlockText 成功与失败格式');

// --- 模拟视觉流 ---
function makeStream(text) {
  return (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: text.slice(0, 3) };
    yield { type: 'text-delta', index: 0, text: text.slice(3) };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  })();
}

// --- rewriteRequest:含图片的消息被改写为描述文本,原消息不变 ---
const calls = [];
const mockCtx = {
  llm: {
    stream(options) {
      calls.push({ provider: options.provider, model: options.model, messages: options.messages });
      if (options.provider === cfg.provider && options.model === cfg.model) {
        return makeStream('视觉模型输出的一段详细描述');
      }
      return makeStream('主模型回复');
    },
  },
};
const rewritten = await rewriteRequest(mockCtx, cfg, {
  provider: 'opencode-go',
  model: 'deepseek-v4-pro',
  messages: [imageMessage],
  system: 'sys',
  sessionId: 'sess-1',
});
assert.notEqual(rewritten, null);
assert.equal(rewritten.provider, 'opencode-go');
assert.equal(rewritten.model, 'deepseek-v4-pro');
assert.equal(rewritten.system, 'sys');
assert.equal(rewritten.messages.length, 1);
const newMsg = rewritten.messages[0];
assert.equal(newMsg.role, 'user');
assert.deepEqual(newMsg.source, { kind: 'user' });
assert.equal(newMsg.content.some((b) => b.type === 'image'), false);
assert.ok(newMsg.content.some((b) => b.type === 'text' && b.text.includes('视觉模型输出的一段详细描述')));
assert.ok(newMsg.content.some((b) => b.type === 'text' && b.text === '这是截图'));
// 原消息未被修改
assert.equal(imageMessage.content.some((b) => b.type === 'image'), true);
ok('rewriteRequest:图片块被描述替换,原消息不可变,字段保留');

// --- 缓存:同一附件第二次不再调用视觉模型 ---
const before = calls.length;
await rewriteRequest(mockCtx, cfg, { provider: 'p', model: 'm', messages: [imageMessage] });
assert.equal(calls.length, before);
ok('rewriteRequest:附件缓存命中,不重复调用视觉模型');

// --- 嵌套 tool-result 里的图片也被替换 ---
const nestedRef = { ...ref, attachmentId: 'att-nested' };
const nestedMessage = createUserMessage({
  content: [{ type: 'tool-result', toolCallId: 'tc1', content: [{ type: 'image', attachment: nestedRef }] }],
  source: { kind: 'tool', callId: 'tc1' },
});
const nestedOut = await rewriteRequest(mockCtx, cfg, { provider: 'p', model: 'm', messages: [nestedMessage] });
assert.equal(nestedOut.messages[0].content[0].type, 'tool-result');
assert.equal(nestedOut.messages[0].content[0].content.some((b) => b.type === 'image'), false);
assert.ok(nestedOut.messages[0].content[0].content.some((b) => b.type === 'text' && b.text.includes('视觉模型输出')));
ok('rewriteRequest:嵌套 tool-result 内的图片也被替换');

// --- bridgeStream:先视觉调用、再重写后的主模型调用 ---
const seq = [];
const seqCtx = {
  llm: {
    stream(options) {
      seq.push(`${options.provider}/${options.model}`);
      if (options.provider === cfg.provider && options.model === cfg.model) return makeStream('描述');
      // 重写后的主模型请求不应再含图片
      assert.equal(options.messages.some((m) => m.content.some((b) => b.type === 'image')), false);
      return makeStream('主模型回复');
    },
  },
};
const chunks = [];
const bridgeImage = createUserMessage({
  content: [{ type: 'image', attachment: { ...ref, attachmentId: 'att-bridge' } }],
  source: { kind: 'user' },
});
for await (const chunk of bridgeStream(seqCtx, cfg, {
  provider: 'opencode-go', model: 'deepseek-v4-pro', messages: [bridgeImage],
})) chunks.push(chunk);
assert.deepEqual(seq, ['opencode-go/mimo-v2.5', 'opencode-go/deepseek-v4-pro']);
assert.ok(chunks.some((c) => c.type === 'text-delta'));
ok('bridgeStream:视觉调用在前,重写后的主模型调用无图片');

// --- onLlmStream 路由判定 ---
let nextCalled = 0;
const nextSpy = () => { nextCalled += 1; return 'NEXT'; };
// 无图片 → next
assert.equal(onLlmStream(seqCtx, cfg, { provider: 'p', model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }] }, nextSpy), 'NEXT');
// 禁用 → next
assert.equal(onLlmStream(seqCtx, { ...cfg, enabled: false }, { provider: 'p', model: 'm', messages: [imageMessage] }, nextSpy), 'NEXT');
// 目标就是视觉模型 → next(放行,视觉模型自己看图)
assert.equal(onLlmStream(seqCtx, cfg, { provider: 'opencode-go', model: 'mimo-v2.5', messages: [imageMessage] }, nextSpy), 'NEXT');
// 主模型 + 图片 → 返回桥接流(不走 next)
const bridged = onLlmStream(seqCtx, cfg, { provider: 'p', model: 'm', messages: [imageMessage] }, nextSpy);
assert.notEqual(bridged, 'NEXT');
assert.equal(typeof bridged[Symbol.asyncIterator], 'function');
assert.equal(nextCalled, 3);
ok('onLlmStream:无图/禁用/视觉目标走 next,主模型含图返回桥接流');

// --- 视觉失败降级:主模型收到失败说明,不中断 ---
const failingCtx = {
  llm: {
    stream(options) {
      if (options.provider === cfg.provider && options.model === cfg.model) {
        return (async function* () {
          yield { type: 'finish', reason: { kind: 'error', failure: { message: 'rate limited', code: 'RATE_LIMIT' } } };
        })();
      }
      return makeStream('ok');
    },
  },
};
const failingImage = createUserMessage({
  content: [{ type: 'image', attachment: { ...ref, attachmentId: 'att-fail' } }],
  source: { kind: 'user' },
});
const fallback = await rewriteRequest(failingCtx, cfg, { provider: 'p', model: 'm', messages: [failingImage] });
assert.equal(fallback.messages[0].content.some((b) => b.type === 'image'), false);
assert.ok(fallback.messages[0].content.some((b) => b.type === 'text' && b.text.includes('RATE_LIMIT')));
ok('rewriteRequest:视觉失败时降级为说明文本');

// --- rewriteContent 无图片原样返回 ---
const plain = [{ type: 'text', text: 'a' }];
assert.equal(await rewriteContent(mockCtx, cfg, plain, undefined, undefined), plain);
ok('rewriteContent:无图片时原样返回(同一引用)');

console.log(`\n全部通过:${passed} 项`);
