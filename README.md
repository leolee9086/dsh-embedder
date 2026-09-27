# dsh-embedder

**DeepSeek Harness 的嵌入服务。** 把一段文本变成向量，供向量检索使用。默认走本机 [Ollama](https://ollama.com) 的 `bge-m3`（1024 维，中文强）。

## 为什么单独一个服务

**向量库只存不算。** 算嵌入依赖外部推理服务（模型、显存、启动方式都可能变），存向量依赖磁盘与索引结构 —— **两件事的变更节奏完全不同**。分开之后：换嵌入模型不动库，换库不动嵌入。

## 它是可失败的

嵌入服务没起、模型没拉、请求超时，都会**抛错**。调用方必须决定"没有向量怎么办"。

对记忆召回来说，答案是：**这一路静默跳过，字面召回照常工作**。**向量是增强，不是单点依赖** —— 这是设计里的一条硬要求，不是可选的容错。

## 用法

```js
// cordis.patch.yml（host 侧，需重启）
//   - id: embedder
//     name: "file:///D:/dev/dsh-embedder/src/host.js"

const embedder = ctx.get('embedder')

const vectors = await embedder.embed(['一句话', '另一句话'])   // Float32Array[]
console.log(vectors[0].length)          // 1024
console.log(embedder.dimension)          // 1024（第一次成功之后才知道）

const status = await embedder.info()     // { ready, model, dimension, reason? }
```

| 成员 | 说明 |
|---|---|
| `embed(texts)` | 文本数组 → 向量数组（等长）。内部按 `batchSize` 分批，一次多条往返 |
| `info()` | 探测服务与模型是否就绪。**不抛错** —— 诊断入口不该因为服务没起就炸 |
| `model` / `baseUrl` | 当前配置（诊断用） |
| `dimension` | 已观察到的维度；一次都没成功过时为 `null`（**不编造**） |

配置：`baseUrl`（默认 `http://127.0.0.1:11434`）、`model`（默认 `bge-m3`）、`timeoutMs`（默认 30000）、`batchSize`（默认 16）。

## 起服务

```bash
ollama serve          # 本机 11434
ollama list           # 看有哪些模型
ollama pull bge-m3    # 没有就拉一个
```

**维度变了要当成换字段。** 换模型时维度往往跟着变（bge-m3 是 1024，别的可能是 768 或 2048）。这一层发现维度与首次观察到的不同会**直接报错** —— 因为把不同模型的向量混着写进同一个索引，检索结果会安静地变烂，那比报错糟得多。换模型的正路是**加一个命名字段**（`bge-m3@1024` → `qwen3@2048`），两路并存、按需融合，旧数据后台回填 —— 见 [dsh-vectordb](https://github.com/leolee9086/dsh-vectordb) 的 dataset 那层。

## 测试

```bash
node test/embedder.test.js
```

测的是**调用方依赖的约定**（服务不在时怎么失败、错误里有没有可行动的信息、形状异常怎么处理），不是"模型返回的向量对不对" —— 后者要起服务、占显存，而且结论随模型变。

## 许可

MIT。

---

如果这个东西帮到了你，欢迎通过 [爱发电](https://afdian.net/a/leolee9086) 支持 —— 家里最近不太宽裕，每一份都是实在的帮助。

也欢迎看看同一系列的其他插件：[DSH 插件总览](https://github.com/leolee9086?tab=repositories)。
