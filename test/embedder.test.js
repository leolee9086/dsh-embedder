// test/embedder.test.js —— 嵌入服务的行为契约。
//
// 这里刻意**不**测试"真模型返回的向量对不对" —— 那要起 Ollama、要占显存、而且结论会随模型变。
// 要测的是**调用方依赖的那些约定**：服务不在时怎么失败、错误里有没有可行动的信息、
// 空输入与形状异常怎么处理。这些是记忆召回做降级判断的依据，跟用哪个模型无关。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createEmbedder } from '../src/host.js'

/** 最小的宿主上下文。 */
function fakeCtx() {
  const logs = []
  return { logs, logger: { info: (m) => logs.push('info: ' + m), warn: (m) => logs.push('warn: ' + m) } }
}

// 一个几乎不可能有服务的端口：用来模拟"嵌入服务没起"。比 mock fetch 更真实 ——
// 走的是真的连接失败路径，报错文本也是调用方真会看到的那句。
const DEAD_URL = 'http://127.0.0.1:59987'

test('服务不在时：embed 抛错，且错误里说清去哪儿找它', async () => {
  const embedder = createEmbedder(fakeCtx(), { baseUrl: DEAD_URL, model: 'bge-m3', timeoutMs: 3000 })
  await assert.rejects(
    () => embedder.embed(['一句话']),
    (error) => {
      assert.match(error.message, /连不上嵌入服务/)
      assert.match(error.message, /59987/, '错误里要带实际地址')
      assert.match(error.message, /ollama serve/, '错误里要给出可行动的提示')
      return true
    },
  )
})

test('服务不在时：info() 不抛，回 ready:false 与原因', async () => {
  const embedder = createEmbedder(fakeCtx(), { baseUrl: DEAD_URL, timeoutMs: 3000 })
  const result = await embedder.info()
  assert.equal(result.ready, false)
  assert.equal(result.model, 'bge-m3')
  assert.equal(result.dimension, null, '一次都没成功嵌入过时维度是 null，不能编一个')
  assert.ok(typeof result.reason === 'string' && result.reason.length > 0, '要给出原因，便于诊断')
})

test('空输入直接回空数组，不去连服务', async () => {
  const embedder = createEmbedder(fakeCtx(), { baseUrl: DEAD_URL, timeoutMs: 3000 })
  assert.deepEqual(await embedder.embed([]), [])
  // 传进来的不是数组也一样按"没有输入"处理。
  assert.deepEqual(await embedder.embed(undefined), [])
})

test('默认值是 Ollama + bge-m3（本机已拉过的那个模型）', () => {
  const embedder = createEmbedder(fakeCtx(), {})
  assert.equal(embedder.baseUrl, 'http://127.0.0.1:11434')
  assert.equal(embedder.model, 'bge-m3')
  assert.equal(embedder.dimension, null)
})

test('地址末尾的斜杠会被去掉（拼路径时不出现双斜杠）', () => {
  const embedder = createEmbedder(fakeCtx(), { baseUrl: 'http://127.0.0.1:11434///' })
  assert.equal(embedder.baseUrl, 'http://127.0.0.1:11434')
})
