// @ts-check
/**
 * Thin Ollama HTTP client — JSON-in/JSON-out.
 * Offline only: calls localhost, no network egress.
 */

const DEFAULT_BASE = 'http://localhost:11434';

/**
 * Check whether Ollama is reachable.
 * @returns {Promise<boolean>}
 */
export async function checkOllamaAvailable() {
  try {
    const res = await fetch(`${DEFAULT_BASE}/api/tags`, {
      method: 'GET',
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Check whether a specific model is available locally.
 * @param {string} model
 * @returns {Promise<boolean>}
 */
export async function checkModelAvailable(model) {
  try {
    const res = await fetch(`${DEFAULT_BASE}/api/tags`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return false;
    const data = await res.json();
    const names = (data.models || []).map(m => m.name);
    // Match "qwen2.5:14b" against "qwen2.5:14b" or "qwen2.5:14b-instruct-q4_K_M"
    return names.some(n => n === model || n.startsWith(model));
  } catch {
    return false;
  }
}

/**
 * Query Ollama and parse the response as JSON.
 *
 * @param {string} prompt  - Full prompt (system + user context)
 * @param {{ model?: string, timeout?: number, temperature?: number, verbose?: boolean }} [opts]
 * @returns {Promise<Record<string, any>>} Parsed JSON from model output
 */
export async function queryOllama(prompt, opts = {}) {
  const model = opts.model || 'qwen2.5:14b';
  const timeout = opts.timeout || 60000;
  const temperature = opts.temperature ?? 0;

  const body = {
    model,
    prompt,
    stream: false,
    format: 'json',
    options: {
      temperature,
      num_predict: 2048,
    },
  };

  if (opts.verbose) {
    console.error(`  [ollama] model=${model} temperature=${temperature} timeout=${timeout}ms`);
  }

  let res;
  try {
    res = await fetch(`${DEFAULT_BASE}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new OllamaError(
        'OLLAMA_TIMEOUT',
        `Ollama request timed out after ${timeout}ms`,
        `Try a smaller model or increase --timeout. Model: ${model}`
      );
    }
    throw new OllamaError(
      'OLLAMA_CONNECT',
      `Cannot connect to Ollama at ${DEFAULT_BASE}: ${err.message}`,
      'Is Ollama running? Start it with: ollama serve'
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '(no body)');
    throw new OllamaError(
      'OLLAMA_HTTP',
      `Ollama returned HTTP ${res.status}: ${text.slice(0, 200)}`,
      res.status === 404
        ? `Model "${model}" not found. Pull it with: ollama pull ${model}`
        : 'Check Ollama logs for details.'
    );
  }

  const envelope = await res.json();
  const raw = envelope.response;

  if (!raw || typeof raw !== 'string') {
    throw new OllamaError(
      'OLLAMA_EMPTY',
      'Ollama returned an empty response',
      'The model may have hit a length limit. Try a shorter prompt or larger num_predict.'
    );
  }

  // Parse JSON from model output
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (parseErr) {
    // Try to extract JSON from markdown code blocks
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        parsed = JSON.parse(jsonMatch[1].trim());
      } catch {
        throw new OllamaError(
          'OLLAMA_PARSE',
          `Model output is not valid JSON: ${parseErr.message}`,
          `Raw output (first 500 chars): ${raw.slice(0, 500)}`
        );
      }
    } else {
      throw new OllamaError(
        'OLLAMA_PARSE',
        `Model output is not valid JSON: ${parseErr.message}`,
        `Raw output (first 500 chars): ${raw.slice(0, 500)}`
      );
    }
  }

  if (opts.verbose) {
    const tokens = envelope.eval_count || '?';
    const durationMs = envelope.total_duration ? Math.round(envelope.total_duration / 1e6) : '?';
    console.error(`  [ollama] done: ${tokens} tokens in ${durationMs}ms`);
  }

  return parsed;
}

/**
 * Query Ollama with an image (multimodal/vision models like LLaVA).
 * Uses the same /api/generate endpoint with the `images` field.
 *
 * @param {string} prompt  - Text prompt describing what to analyze
 * @param {string} imageBase64 - Base64-encoded image (no data: prefix)
 * @param {{ model?: string, timeout?: number, temperature?: number, verbose?: boolean }} [opts]
 * @returns {Promise<Record<string, any>>} Parsed JSON from model output
 */
export async function queryOllamaVision(prompt, imageBase64, opts = {}) {
  const model = opts.model || 'llava:13b';
  const timeout = opts.timeout || 90000;
  const temperature = opts.temperature ?? 0;

  const body = {
    model,
    prompt,
    images: [imageBase64],
    stream: false,
    format: 'json',
    options: {
      temperature,
      num_predict: 1024,
    },
  };

  if (opts.verbose) {
    console.error(`  [ollama-vision] model=${model} img=${(imageBase64.length / 1024).toFixed(0)}KB timeout=${timeout}ms`);
  }

  let res;
  try {
    res = await fetch(`${DEFAULT_BASE}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new OllamaError(
        'OLLAMA_TIMEOUT',
        `Vision request timed out after ${timeout}ms`,
        `Try reducing image size or increasing timeout. Model: ${model}`
      );
    }
    throw new OllamaError(
      'OLLAMA_CONNECT',
      `Cannot connect to Ollama at ${DEFAULT_BASE}: ${err.message}`,
      'Is Ollama running? Start it with: ollama serve'
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '(no body)');
    throw new OllamaError(
      'OLLAMA_HTTP',
      `Ollama returned HTTP ${res.status}: ${text.slice(0, 200)}`,
      res.status === 404
        ? `Model "${model}" not found. Pull it with: ollama pull ${model}`
        : 'Check Ollama logs for details.'
    );
  }

  const envelope = await res.json();
  const raw = envelope.response;

  if (!raw || typeof raw !== 'string') {
    throw new OllamaError(
      'OLLAMA_EMPTY',
      'Vision model returned an empty response',
      'The model may have hit a length limit or the image was too large.'
    );
  }

  // Parse JSON from model output
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (parseErr) {
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        parsed = JSON.parse(jsonMatch[1].trim());
      } catch {
        throw new OllamaError(
          'OLLAMA_PARSE',
          `Vision model output is not valid JSON: ${parseErr.message}`,
          `Raw output (first 500 chars): ${raw.slice(0, 500)}`
        );
      }
    } else {
      throw new OllamaError(
        'OLLAMA_PARSE',
        `Vision model output is not valid JSON: ${parseErr.message}`,
        `Raw output (first 500 chars): ${raw.slice(0, 500)}`
      );
    }
  }

  if (opts.verbose) {
    const tokens = envelope.eval_count || '?';
    const durationMs = envelope.total_duration ? Math.round(envelope.total_duration / 1e6) : '?';
    console.error(`  [ollama-vision] done: ${tokens} tokens in ${durationMs}ms`);
  }

  return parsed;
}

/**
 * Structured error for Ollama failures.
 */
export class OllamaError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {string} hint
   */
  constructor(code, message, hint) {
    super(message);
    this.name = 'OllamaError';
    this.code = code;
    this.hint = hint;
  }
}
