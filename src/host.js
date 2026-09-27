/**
 * dsh-embedder —— 把文本变成向量。
 *
 * **为什么单独一个服务**：向量库只存不算。算嵌入依赖外部推理服务（模型、显存、启动方式全都可能变），
 * 存向量依赖磁盘与索引结构 —— 两件事的变更节奏完全不同。分开之后：换嵌入模型不动库，换库不动嵌入。
 *
 * **它是可失败的**：嵌入服务没起、模型没拉、超时，都会抛错。**调用方必须决定"没有向量怎么办"** ——
 * 对记忆召回来说，答案是"这一路静默跳过，字面召回照常"。向量是增强，不是单点依赖。
 *
 * @module dsh-embedder/host
 */
import { Buffer } from 'node:buffer'

export const name = 'dsh-embedder'

/** 服务名。别的插件用 `ctx.get('embedder')` 取（未声明的可选依赖必须用 ctx.get）。 */
export const SERVICE = 'embedder'

/** 默认的嵌入服务地址：本机 Ollama。 */
const DEFAULT_BASE_URL = 'http://127.0.0.1:11434'
/** 默认模型：bge-m3 —— 1024 维，中文强，本机已有。 */
const DEFAULT_MODEL = 'bge-m3'

/**
 * 建嵌入服务。**不主动探测**：第一次 embed 时才连（懒），减少启动期的耦合；
 * 连不上就抛错，由调用方决定降级。
 *
 * @param {object} ctx 插件上下文。
 * @param {object} [raw] 配置。
 * @param {string} [raw.baseUrl] 嵌入服务地址，默认 `http://127.0.0.1:11434`（Ollama）。
 * @param {string} [raw.model] 模型名，默认 `bge-m3`。
 * @param {number} [raw.timeoutMs] 单次请求超时，默认 30000。
 * @param {number} [raw.batchSize] 单次送多少条文本，默认 16。
 * @returns {object} 服务对象。
 */
export function createEmbedder(ctx, raw = {}) {
  const baseUrl = (typeof raw.baseUrl === 'string' && raw.baseUrl !== '' ? raw.baseUrl : DEFAULT_BASE_URL).replace(/\/+$/, '')
  const model = typeof raw.model === 'string' && raw.model !== '' ? raw.model : DEFAULT_MODEL
  const timeoutMs = Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0 ? raw.timeoutMs : 30000
  const batchSize = Number.isFinite(raw.batchSize) && raw.batchSize > 0 ? Math.trunc(raw.batchSize) : 16

  /** 第一次成功之后记下维度 —— 调用方要拿它去建库，不该自己猜。 */
  let dimension = null

  const warn = (message) => {
    if (typeof ctx.logger?.warn === 'function') ctx.logger.warn('dsh-embedder: ' + message)
  }

  /**
   * 送一批文本过去，拿回向量。
   *
   * 用 Ollama 的 `/api/embed`：它一次收多条（`input` 是数组）、一次回多条（`embeddings`），
   * 比老的 `/api/embeddings`（单条）少一半往返。
   *
   * @param {string[]} texts 要嵌入的文本。
   * @returns {Promise<Float32Array[]>} 与输入等长的向量数组。
   * @throws {Error} 服务不在、模型缺失、返回形状不对、超时。
   */
  async function embed(texts) {
    if (!Array.isArray(texts) || texts.length === 0) return []
    const clean = texts.map((text) => (typeof text === 'string' ? text : String(text ?? '')))
    const out = []
    for (let start = 0; start < clean.length; start += batchSize) {
      const slice = clean.slice(start, start + batchSize)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      let response
      try {
        response = await fetch(baseUrl + '/api/embed', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, input: slice }),
          signal: controller.signal,
        })
      } catch (error) {
        // 服务没起是最常见的失败；把"去哪儿找它"写进错误里，别让人猜。
        throw new Error('dsh-embedder: 连不上嵌入服务 ' + baseUrl + '（' + (error instanceof Error ? error.message : String(error)) + '）。本机可用 `ollama serve` 起一个。')
      } finally {
        clearTimeout(timer)
      }
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new Error('dsh-embedder: 嵌入服务返回 ' + response.status + ' ' + response.statusText + (body === '' ? '' : '：' + body.slice(0, 300)))
      }
      const payload = await response.json()
      const rows = Array.isArray(payload?.embeddings) ? payload.embeddings : null
      if (rows === null || rows.length !== slice.length) {
        throw new Error('dsh-embedder: 嵌入服务回了 ' + (rows === null ? '非数组' : rows.length + ' 条') + '，期望 ' + slice.length + ' 条')
      }
      for (const row of rows) {
        if (!Array.isArray(row) || row.length === 0) {
          throw new Error('dsh-embedder: 嵌入服务回了空向量')
        }
        if (dimension === null) dimension = row.length
        else if (row.length !== dimension) {
          throw new Error('dsh-embedder: 维度变了（' + dimension + ' → ' + row.length + '）—— 换模型要当成换字段，不能混着写进同一个索引')
        }
        out.push(Float32Array.from(row))
      }
    }
    return out
  }

  /**
   * 探测服务与模型是否就绪。**可选** —— 调用方不探也能直接 embed（失败会抛）。
   * 它存在的意义是让启动期或诊断时能问一句"现在能不能用"。
   *
   * @returns {Promise<{ready: boolean, model: string, dimension: number|null, reason?: string}>}
   */
  async function info() {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 5000))
      const response = await fetch(baseUrl + '/api/tags', { signal: controller.signal })
      clearTimeout(timer)
      if (!response.ok) return { ready: false, model, dimension, reason: '服务返回 ' + response.status }
      const payload = await response.json()
      const names = (payload?.models ?? []).map((item) => String(item?.name ?? ''))
      const found = names.some((item) => item === model || item.startsWith(model + ':'))
      if (!found) return { ready: false, model, dimension, reason: '本机没有模型 ' + model + '（有：' + names.slice(0, 8).join(', ') + '）' }
      return { ready: true, model, dimension }
    } catch (error) {
      return { ready: false, model, dimension, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  return {
    baseUrl,
    model,
    /** 已经观察到的维度；一次都没成功嵌入过时为 null。 */
    get dimension() { return dimension },
    embed,
    info,
  }
}

/**
 * 插件入口。
 *
 * @param {object} ctx 插件上下文。
 * @param {object} [config] 见 {@link createEmbedder}。
 */
export function apply(ctx, config = {}) {
  const embedder = createEmbedder(ctx, config)
  if (ctx.get(SERVICE) === undefined) {
    ctx.provide(SERVICE, embedder)
  }
  // 起手探一次，只记日志不拦路：服务没起时不该让插件挂载失败（它随时可能被起起来）。
  void embedder.info().then((result) => {
    if (result.ready) {
      if (typeof ctx.logger?.info === 'function') ctx.logger.info('dsh-embedder: ' + embedder.model + ' 就绪（' + embedder.baseUrl + '）')
    } else {
      if (typeof ctx.logger?.warn === 'function') ctx.logger.warn('dsh-embedder: 暂不可用 —— ' + String(result.reason).slice(0, 200))
    }
  })
}
