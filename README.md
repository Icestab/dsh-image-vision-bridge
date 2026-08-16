# dsh-image-vision-bridge

[![npm version](https://img.shields.io/npm/v/dsh-image-vision-bridge)](https://www.npmjs.com/package/dsh-image-vision-bridge)

DSH 宿主插件:你发送的图片**照常显示在聊天记录里**,插件在 `llm/stream`
水线上把发给主模型的请求里的图片块悄悄替换成视觉模型 **mimo-v2.5**
(默认走你已配置的 `opencode-go` 路由,复用现有 `OPENCODE_GO_API_KEY`)
生成的**文本描述**。描述只进模型、不进聊天:DeepSeek 基于描述回复你,
聊天里看不到任何"图片解析"文本。

## 工作原理

1. 图片消息原样进入 agent、原样写入会话日志——聊天框显示的就是你发的图。
2. 主循环(以及压缩、标题生成等)发出的任何模型请求都会经过 `llm/stream`
   水线。插件检查请求消息里是否含 image 块:
   - 不含图片 → 直接放行;
   - 目标是插件配置的视觉模型本身(自己的调用,或某会话本来就选用了
     视觉模型)→ 放行,让视觉模型直接看图;
   - 其他情况 → 构造一份**重写后的请求**:消息里的 image 块(含 tool-result
     嵌套)替换为描述文本,再以这份请求实际流式调用。原请求对象与
     会话日志完全不被修改。
3. 描述结果按附件 id 在进程内缓存(重试/后续轮次不重复调用);视觉调用
   失败时降级为一段失败说明文本,不打断对话;用户取消时错误照常抛出。

## 兼容性

- 已测试环境:DeepSeek Harness `0.1.0-rc.6`(@deepseek-ai/dsh、dsh-llm 0.1.0-rc.6、cordis 4.0.1)。
- 插件依赖的公开 API:`ctx.llm.stream`、`llm/stream` 水线、`contentHasImage`/`createMessage`/`BlockAssembler`、附件 image 块。这些在 0.1.x 线内稳定;但插件会**重写进入水线的请求**(框架文档要求监听器只读不改),这是官方尚未承诺的用法,升级 dsh 前建议先在临时 profile 里冒烟测试(发一张图即可)。
- 插件不修改 dsh 安装、不写 dsh 目录、不碰会话日志;失败时按请求降级,不会影响纯文本对话。

## 安装(标准 bundle 方式)

本包声明了 `dsh.bundle`,是标准的可分发 bundle:安装时自动插入插件行,
无需手改 cordis.patch.yml。

```sh
# 本地目录 / tarball / npm / GitHub 均可:
dsh plugin --profile web add dsh-image-vision-bridge              # npm
dsh plugin --profile web add github:Icestab/dsh-image-vision-bridge#c67b4b3  # GitHub(锁定版本)
dsh plugin --profile web add ./dsh-image-vision-bridge            # 本地目录
dsh plugin --profile web add ./dsh-image-vision-bridge-0.1.0.tgz  # tarball
```

仍有两步手工操作(插件无法替用户完成):

1. **让主模型声明可接收图片**(必做):主机的 API 边界
   (`dsh-host-apiproxy`)会在图片消息进入 agent 之前用当前模型的
   `inputModalities` 做校验,主模型若不声明 image 会被直接拒绝
   (客户端提示"当前模型不支持图片")。在 DSH 设置文件
   `$DSH_HOME/settings.yaml`(也可通过 Web 界面的 Models 页维护)的
   `llm-pi-ai.providers.<路由>` 下为主模型加 `modelOverrides`
   (该文件热重载,免重启):

   ```yaml
   llm-pi-ai:
     providers:
       opencode-go:
         apiKeyEnv: OPENCODE_GO_API_KEY
         modelOverrides:
           deepseek-v4-pro:
             input: [text, image]
   ```

   插件会在请求水线上把图片换成文本描述,主模型请求里永远不会真的出现
   图片块,所以这个声明只是放行边界,不会把图片发给 deepseek。

2. 重启 `dsh web`(web profile 已禁用 HMR,必须重启才生效)。

bundle 默认配置(provider: `opencode-go`,model: `mimo-v2.5`)可被用户覆盖:
在 profile 自己的 `cordis.patch.yml` 里按行 id `image-vision-bridge` 重写
config 即可(后层胜出)。

## 安装(手工平铺方式)

不通过 `dsh plugin` 的手工装法(适合不想用 pnpm 或想直接改代码的场景):

1. 把本包目录复制到 profile 的模块解析路径(裸包名从 profile 目录沿
   node_modules 链向上查找;hoisted 布局通常是
   `$DSH_HOME/profiles/node_modules/`,扁平布局则是
   `$DSH_HOME/profiles/<name>/node_modules/`):

   ```sh
   cp -r ./dsh-image-vision-bridge "$DSH_HOME/profiles/node_modules/"
   ```

   > 注:以后若在 profile 里运行过 `dsh plugin --profile <name> add/install …`,
   > pnpm 可能清掉这个手工放置的目录,重新执行上面这条命令即可恢复。

2. 在 `$DSH_HOME/profiles/<name>/cordis.patch.yml` 中加入插件行(settings.yaml
   的 `modelOverrides` 配置仍是插件无法替用户完成的前提,见上一节):

   ```yaml
   - insert:
       - id: image-vision-bridge
         name: 'dsh-image-vision-bridge'
         config:
           provider: opencode-go
           model: mimo-v2.5
   ```

3. 同样需要上面的 settings.yaml `modelOverrides` 配置,然后重启 `dsh web`。

## 配置

| 键 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | `false` 时完全透传,不做桥接 |
| `provider` | `opencode-go` | 视觉模型所在 LLM 路由(必须已注册,即 settings.yaml 里 `llm-pi-ai.providers` 已配置) |
| `model` | `mimo-v2.5` | 视觉模型 id |
| `maxTokens` | `2048` | 视觉调用最大输出 token |
| `maxDescriptionChars` | `6000` | 注入主模型前的描述长度上限 |
| `prompt` | 内置中文提示词 | 发给视觉模型的指令(用户原文会自动拼在前面) |

示例(自定义):

```yaml
- insert:
    - id: image-vision-bridge
      name: 'dsh-image-vision-bridge'
      config:
        model: mimo-v2.5
        maxTokens: 4096
        prompt: 'Describe this image in English, including all visible text.'
```

## 自测

```sh
cd "$DSH_HOME/profiles"
node node_modules/dsh-image-vision-bridge/test/transform.test.mjs
```
