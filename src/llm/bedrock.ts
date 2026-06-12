// Amazon Bedrock provider (IAM auth): Claude on Bedrock via the official wrapper SDK,
// which handles SigV4 signing from standard AWS env credentials
// (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN / AWS_REGION).

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import AnthropicBedrock from "@anthropic-ai/bedrock-sdk";
import { config } from "../util/config";
import type { FetchFn, LlmProvider } from "./types";

export function hasAwsCredentials(): boolean {
  return Boolean(
    process.env.AWS_ACCESS_KEY_ID ||
      process.env.AWS_PROFILE ||
      existsSync(join(homedir(), ".aws", "credentials")), // SDK default chain reads ini files
  );
}

export function bedrockProvider(fetchFn?: FetchFn): LlmProvider {
  if (!config.bedrockModel) {
    throw new Error(
      "CLASSIFY_PROVIDER=bedrock requires BEDROCK_MODEL in .env (a Bedrock model id or " +
        "inference-profile, e.g. us.anthropic.claude-opus-4-8 — ids vary by " +
        "region/account, so there is no guessable default)",
    );
  }
  if (!hasAwsCredentials()) {
    throw new Error(
      "CLASSIFY_PROVIDER=bedrock requires AWS IAM credentials: env vars " +
        "(AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY + AWS_REGION) or ~/.aws/credentials (aws configure)",
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
        // classify outputs are tiny, but the skill optimizer returns a whole skill file
        // in one JSON object — 512 truncated those mid-string (SkillOpt cat30, 2026-06-12)
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      });
      const block = msg.content.find((b) => b.type === "text");
      return block && block.type === "text" ? block.text : "";
    },
  };
}
