// Optional image-describe call site. Local Ollama (or the hash-keyed mock) only.
// Cloud VLM routes are rejected before provider construction. Audit never stores
// bytes or captions — counts and routing metadata only.

import { config } from "../util/config";
import { describeProviderForTier } from "./index";
import { mockDescribe } from "./mock-describe";

export const DESCRIBE_PROMPT =
  "Describe this personal capture image in 2-4 factual sentences. " +
  "Do not guess identities. If it looks like a receipt, say so and list " +
  "merchant, date, and total when visible.";

export async function describeImage(input: {
  mime: string;
  base64: string;
  sha256: string;
  tier: 1 | 2;
}): Promise<string | null> {
  if (config.mockOllama) return mockDescribe(input.sha256);
  const provider = describeProviderForTier(input.tier);
  if (!provider.describe) return null;
  const caption = await provider.describe(
    { mime: input.mime, base64: input.base64, sha256: input.sha256 },
    DESCRIBE_PROMPT,
  );
  const trimmed = caption.trim();
  return trimmed.length > 0 ? trimmed : null;
}
