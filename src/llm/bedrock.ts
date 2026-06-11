// Amazon Bedrock provider (IAM auth): Claude on Bedrock via the official wrapper SDK,
// which handles SigV4 signing from standard AWS env credentials
// (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN / AWS_REGION).

import AnthropicBedrock from "@anthropic-ai/bedrock-sdk";
import { config } from "../util/config";
import type { FetchFn, LlmProvider } from "./types";

export function bedrockProvider(fetchFn?: FetchFn): LlmProvider {
  if (!config.bedrockModel) {
    throw new Error(
      "CLASSIFY_PROVIDER=bedrock requires BEDROCK_MODEL in .env (a Bedrock model id or " +
        "inference-profile, e.g. us.anthropic.claude-haiku-4-5-20251001-v1:0 — ids vary by " +
        "region/account, so there is no guessable default)",
    );
  }
  if (!process.env.AWS_ACCESS_KEY_ID && !process.env.AWS_PROFILE) {
    throw new Error(
      "CLASSIFY_PROVIDER=bedrock requires AWS credentials (AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY and AWS_REGION)",
    );
  }
  const model = config.bedrockModel;
  const client = new AnthropicBedrock({
    awsRegion: process.env.AWS_REGION,
    ...(fetchFn ? { fetch: fetchFn } : {}),
  });
  return {
    name: "bedrock",
    model,
    isCloud: true,
    async completeJson(prompt: string): Promise<string> {
      const msg = await client.messages.create({
        model,
        max_tokens: 512,
        messages: [{ role: "user", content: prompt }],
      });
      const block = msg.content.find((b) => b.type === "text");
      return block && block.type === "text" ? block.text : "";
    },
  };
}
