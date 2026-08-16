/**
 * dsh-image-vision-bridge — 图片自动视觉桥接插件 (v2)
 *
 * 目标体验:用户发送的图片照常显示在聊天记录里;描述文本不会出现在聊天中,
 * 只在发给主模型的请求里把图片块悄悄替换成视觉模型(默认 mimo-v2.5)生成的
 * 文本描述,主模型(如 deepseek-v4-pro)据此回复用户。
 *
 * 实现方式:监听 `llm/stream` 水线。对任何包含图片的模型请求——
 * 会话主循环、压缩、标题生成等——只要目标不是插件配置的视觉模型路由,
 * 就把请求消息里的 image 块替换为描述文本后再实际流式调用。
 * 会话日志(聊天记录)不受影响:图片消息原样落盘、原样展示。
 *
 * 注意:若某会话自身选用的模型就是视觉模型(provider/model 与插件配置一致),
 * 插件会放行,让视觉模型直接看图。
 *
 * 挂载方式: web profile 的 cordis.patch.yml 中新增一行 loader 条目
 * (见 README.md)。修改后需重启 dsh web。
 *
 * @module dsh-image-vision-bridge
 */
import { BlockAssembler, contentHasImage, createMessage } from '@deepseek-ai/dsh-llm';

/** 稳定的 Cordis 插件名。 */
const name = 'dsh-image-vision-bridge';

/** 依赖注入声明:插件通过 ctx.llm 发起视觉模型调用,必须显式声明。 */
const inject = ['llm'];

/** 默认视觉模型路由:沿用用户已配置的 opencode-go(OpenCode Zen Go)。 */
const DEFAULT_PROVIDER = 'opencode-go';
/** 默认视觉模型:mimo-v2.5,该路由目录声明支持 text+image 输入。 */
const DEFAULT_MODEL = 'mimo-v2.5';
/** 视觉调用输出上限。 */
const DEFAULT_MAX_TOKENS = 2048;
/** 描述文本注入主模型前的长度上限(保护上下文)。 */
const DEFAULT_MAX_DESCRIPTION_CHARS = 6000;
/** 发给视觉模型的默认提示词。 */
const DEFAULT_PROMPT = [
  '请仔细观察这张图片,输出一份详细、客观的中文描述,供一个不具备视觉能力的文本模型使用。要求:',
  '1. 图片的主体内容与整体布局;',
  '2. 图片中出现的全部文字,逐字转录(不要翻译);',
  '3. 颜色、风格与显著细节;',
  '4. 图表或数据里的具体数值;',
  '5. 只描述图片中实际可见的内容,不要臆测图片之外的信息。',
].join('\n');

/**
 * 归一化配置并填充默认值。loader 传入的 config 可能是 undefined 或部分字段。
 * @param {object|undefined} config - loader 行配置。
 * @returns 完整配置。
 */
function resolveConfig(config) {
  const raw = config ?? {};
  return {
    enabled: raw.enabled !== false,
    provider: typeof raw.provider === 'string' && raw.provider.length > 0 ? raw.provider : DEFAULT_PROVIDER,
    model: typeof raw.model === 'string' && raw.model.length > 0 ? raw.model : DEFAULT_MODEL,
    maxTokens: Number.isFinite(raw.maxTokens) && raw.maxTokens > 0 ? raw.maxTokens : DEFAULT_MAX_TOKENS,
    maxDescriptionChars: Number.isFinite(raw.maxDescriptionChars) && raw.maxDescriptionChars > 0 ? raw.maxDescriptionChars : DEFAULT_MAX_DESCRIPTION_CHARS,
    prompt: typeof raw.prompt === 'string' && raw.prompt.trim().length > 0 ? raw.prompt : DEFAULT_PROMPT,
  };
}

/** 内容块数组里顶层 image 块的列表。 */
function imagesOf(content) {
  return content.filter((block) => block.type === 'image');
}

/** 内容块数组里 text 块的拼接文本。 */
function textOf(content) {
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/** 图片的可读标签。 */
function imageLabel(ref, index) {
  const title = ref.name && ref.name.length > 0 ? ref.name : ref.mediaType;
  return `图片${index}:${title} (${ref.mediaType}, ${ref.width}x${ref.height})`;
}

/** 截断描述文本。 */
function clipDescription(text, maxChars) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…[已截断,共 ${text.length} 字符]`;
}

/**
 * 缓存:attachmentId 列表(按顺序拼接)→ 描述文本或失败标记 { error }。
 * 图片附件内容寻址且不可变,进程内缓存可以避免重试/后续轮次反复调用视觉模型。
 */
const descriptionCache = new Map();

/** 组装一批图片的缓存键。 */
function cacheKeyOf(images) {
  return images.map((block) => block.attachment.attachmentId).join('|');
}

/**
 * 调用视觉模型描述一批图片。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文(提供 ctx.llm)。
 * @param {object} config - 已归一化配置。
 * @param {Array} content - 含 image 块的内容块数组(图片之外附带其中的文本)。
 * @param {string} sessionId - 发起步骤的会话 id,仅作归属标记。
 * @param {AbortSignal} signal - 当前请求的取消信号。
 * @returns {Promise<string>} 描述文本。
 */
async function describeImages(ctx, config, content, sessionId, signal) {
  const images = imagesOf(content);
  const userText = textOf(content);
  const prompt = [userText, config.prompt].filter((s) => s.length > 0).join('\n\n');
  const assembler = new BlockAssembler();
  const stream = ctx.llm.stream({
    provider: config.provider,
    model: config.model,
    messages: [{ role: 'user', content: [...images, { type: 'text', text: prompt }] }],
    maxTokens: config.maxTokens,
    sessionId,
    signal,
  });
  for await (const chunk of stream) {
    signal?.throwIfAborted();
    assembler.push(chunk);
  }
  const finish = assembler.finish;
  if (finish.kind !== 'stop') {
    const detail = finish.kind === 'error' ? `${finish.failure.code}: ${finish.failure.message}` : finish.kind;
    throw new Error(`视觉模型调用未正常结束 (${detail})`);
  }
  const description = assembler.blocks()
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
  if (description.length === 0) throw new Error('视觉模型未返回任何文本');
  return description;
}

/**
 * 取一批图片的描述(带缓存与失败降级)。
 * @returns {Promise<{text?: string, error?: string}>}
 */
async function descriptionFor(ctx, config, images, sessionId, signal) {
  const key = cacheKeyOf(images);
  let outcome = descriptionCache.get(key);
  if (outcome === undefined) {
    try {
      outcome = { text: await describeImages(ctx, config, images, sessionId, signal) };
    } catch (error) {
      if (signal?.aborted) throw error;
      outcome = { error: error instanceof Error ? error.message : String(error) };
    }
    descriptionCache.set(key, outcome);
  }
  return outcome;
}

/** 生成替换 image 块的描述文本块内容(模型可见)。 */
function imageBlockText(images, outcome, config) {
  const labels = images.map((img, i) => imageLabel(img.attachment, i + 1)).join('\n');
  if (outcome.error !== undefined) {
    return `[本条消息包含图片:${labels}\n视觉模型 ${config.model} 分析失败(${outcome.error}),无法获取图片内容,请向用户说明并请求重试]`;
  }
  return `[本条消息包含图片,图片内容描述如下(由视觉模型 ${config.model} 生成,原图见聊天记录):\n${labels}]\n\n${clipDescription(outcome.text, config.maxDescriptionChars)}`;
}

/**
 * 递归改写内容块:把(顶层或 tool-result 嵌套内的)image 块替换为描述文本块。
 * @returns {Promise<Array>} 新内容块数组;不含图片时原样返回。
 */
async function rewriteContent(ctx, config, blocks, sessionId, signal) {
  // 先处理嵌套(tool-result 的 content 里也可能带图片)。
  const processed = [];
  let sawNestedChange = false;
  for (const block of blocks) {
    if (block.type === 'tool-result') {
      const nested = await rewriteContent(ctx, config, block.content, sessionId, signal);
      if (nested !== block.content) sawNestedChange = true;
      processed.push({ ...block, content: nested });
      continue;
    }
    processed.push(block);
  }
  const images = imagesOf(processed);
  if (images.length === 0) return sawNestedChange ? processed : blocks;
  const outcome = await descriptionFor(ctx, config, images, sessionId, signal);
  const textBlock = { type: 'text', text: imageBlockText(images, outcome, config) };
  const result = [];
  let inserted = false;
  for (const block of processed) {
    if (block.type === 'image') {
      if (!inserted) {
        result.push(textBlock);
        inserted = true;
      }
      continue;
    }
    result.push(block);
  }
  return result;
}

/**
 * 构造重写后的请求:逐条消息把 image 块替换为描述文本(原请求不修改)。
 * @returns {Promise<object>} 新的 GenerateOptions。
 */
async function rewriteRequest(ctx, config, options) {
  const messages = await Promise.all(options.messages.map(async (message) => {
    if (!contentHasImage(message.content)) return message;
    const content = await rewriteContent(ctx, config, message.content, options.sessionId, options.signal);
    return createMessage({ role: message.role, content, source: message.source });
  }));
  return { ...options, messages };
}

/** 桥接后的实际模型流:先完成描述替换,再流式调用重写后的请求。 */
async function* bridgeStream(ctx, config, options) {
  const rewritten = await rewriteRequest(ctx, config, options);
  yield* ctx.llm.stream(rewritten);
}

/** `llm/stream` 水线处理器。 */
function onLlmStream(ctx, config, options, next) {
  if (!config.enabled) return next();
  const hasImages = options.messages.some((message) => contentHasImage(message.content));
  if (!hasImages) return next();
  // 目标就是视觉模型本身(插件自己的调用,或会话本身选用了视觉模型):放行。
  if (options.provider === config.provider && options.model === config.model) return next();
  return bridgeStream(ctx, config, options);
}

/** Cordis 插件入口。 */
function apply(ctx, config) {
  const resolved = resolveConfig(config);
  // 根上下文监听器能收到所有模型的 llm/stream 调用。
  ctx.on('llm/stream', (options, next) => onLlmStream(ctx, resolved, options, next));
}

/** 测试钩子:暴露内部逻辑供离线自测(生产路径不使用)。 */
const internals = {
  bridgeStream,
  cacheKeyOf,
  clipDescription,
  describeImages,
  descriptionFor,
  imageBlockText,
  imagesOf,
  onLlmStream,
  resolveConfig,
  rewriteContent,
  rewriteRequest,
  textOf,
};

export { apply, inject, internals, name };
export { DEFAULT_MAX_DESCRIPTION_CHARS, DEFAULT_MAX_TOKENS, DEFAULT_MODEL, DEFAULT_PROMPT, DEFAULT_PROVIDER };
