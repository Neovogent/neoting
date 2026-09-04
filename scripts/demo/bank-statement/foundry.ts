// Test-artifact generator — the Foundry (Azure AI Foundry) Anthropic shim.
//
// Deliberately dependency-free: `fetch` is in Node 22's standard library, and
// adding an SDK for one POST is on the root CLAUDE.md's stop-and-ask list.
//
// Credentials come from the environment, never from this file (root CLAUDE.md:
// "No secrets in the diff"). `source ~/.claude-foundry.env` sets them.

/** Deployed on this resource. `claude-fable-5-1` is NOT — it 404s DeploymentNotFound. */
export const FABLE = 'claude-fable-5';

export interface FoundryRequest {
  readonly model: string;
  readonly system?: string;
  readonly prompt: string;
  readonly maxTokens: number;
}

/**
 * One call, returning the concatenated `text` blocks.
 *
 * ⚠ The response may open with `thinking` blocks, so `content[0]` is not
 * reliably the answer — the text blocks are filtered out by type.
 */
export async function askFoundry(request: FoundryRequest): Promise<string> {
  const base = requireEnv('ANTHROPIC_FOUNDRY_BASE_URL');
  const key = requireEnv('ANTHROPIC_FOUNDRY_API_KEY');

  const response = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: request.model,
      max_tokens: request.maxTokens,
      ...(request.system === undefined ? {} : { system: request.system }),
      messages: [{ role: 'user', content: request.prompt }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Foundry ${response.status} ${response.statusText}: ${(await response.text()).slice(0, 600)}`);
  }

  const body = (await response.json()) as { content?: { type?: string; text?: string }[] };
  const text = (body.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
  if (text.trim() === '') throw new Error('Foundry returned no text block.');
  return text;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set. Run: source ~/.claude-foundry.env`);
  }
  return value;
}

/**
 * Model output is a BOUNDARY (root CLAUDE.md), so it is parsed, never trusted.
 * Strips a ```json fence if the model wrapped its answer in one.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced?.[1] ?? trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) throw new Error('No JSON object found in the response.');
  return JSON.parse(candidate.slice(start, end + 1));
}
