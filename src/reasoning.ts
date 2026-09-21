import OpenAI from 'openai'
import { config } from './config.js'

const client = new OpenAI({
  apiKey: config.servApiKey || 'missing',
  baseURL: 'https://inference-api.openserv.ai/v1'
})

// SERV requires a system message on every request.
const SYSTEM = `You are Ledgerly's treasury analyst. You are given a proposed money movement and the policy verdict already computed by a deterministic guardrail engine. Explain in 2-3 plain sentences why the action is reasonable or not, and flag any risk. Never override the verdict.`

export interface AskOptions {
  maxTokens?: number
  /** Turns on SERV Shadow Agent: the answer is validated against this hint and regenerated if it falls short. */
  shadowHint?: string
}

/** Why the last call failed, so a bad key or model name is visible instead of silently ignored. */
export let lastError: string | null = null

/**
 * SERV features are switched on by adding `serv_*` tools to the request (docs.openserv.ai/serv-reasoning/tools).
 * Prompt Guard is always on: payee names and memos are user-typed text that ends up in the prompt.
 * Kronos and Multipath are left off. Kronos rewrites the prompt, which could break our strict JSON reply format.
 */
function servTools(shadowHint?: string): OpenAI.Chat.Completions.ChatCompletionTool[] {
  const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [{ type: 'function', function: { name: 'serv_prompt_guard' } }]
  if (shadowHint) {
    tools.push({
      type: 'function',
      function: {
        name: 'serv_shadow_agent',
        parameters: {
          type: 'object',
          properties: {
            hint: { type: 'string', default: shadowHint },
            max_iterations: { type: 'integer', default: 3 }
          }
        }
      }
    })
  }
  return tools
}

/** Raw SERV Reasoning call. Returns null when no key is set or the API fails (see `lastError`). */
export async function ask(system: string, user: string, opts: AskOptions = {}): Promise<string | null> {
  if (!config.servApiKey) return null
  try {
    const res = await client.chat.completions.create({
      model: config.servModel,
      max_completion_tokens: opts.maxTokens ?? 300,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      tools: servTools(opts.shadowHint)
    })
    lastError = null
    return res.choices[0]?.message?.content?.trim() || null
  } catch (err) {
    // Deliberately no retry without Prompt Guard: a blocked prompt must not be resent unprotected.
    lastError = (err as Error).message
    console.error('SERV reasoning call failed:', lastError)
    return null
  }
}

/** Ask SERV Reasoning to explain a decision; falls back to the raw context if unavailable. */
export async function explain(context: string): Promise<string> {
  if (!config.servApiKey) return `(no SERV_API_KEY set) ${context}`
  return (await ask(SYSTEM, context)) ?? `${context} (reasoning unavailable: ${lastError ?? 'empty reply'})`
}
