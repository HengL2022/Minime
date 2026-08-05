// Amazon Bedrock provider (IAM auth): Claude on Bedrock via the official wrapper SDK,
// which handles SigV4 signing. Resident MCP processes require a dedicated Bedrock-scoped
// credential so an S3/restic credential is never inherited by the MCP authority boundary.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import AnthropicBedrock from "@anthropic-ai/bedrock-sdk";
import { config } from "../util/config";
import type { FetchFn, LlmProvider } from "./types";

export function hasAwsCredentials(): boolean {
  if (process.env.MINIME_RUNTIME_CHILD === "1") {
    return Boolean(
      process.env.BEDROCK_AWS_ACCESS_KEY_ID &&
        process.env.BEDROCK_AWS_SECRET_ACCESS_KEY &&
        process.env.BEDROCK_AWS_REGION,
    );
  }
  return Boolean(
    (process.env.BEDROCK_AWS_ACCESS_KEY_ID && process.env.BEDROCK_AWS_SECRET_ACCESS_KEY) ||
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
      "CLASSIFY_PROVIDER=bedrock requires Bedrock-scoped AWS IAM credentials. Resident serve " +
        "uses BEDROCK_AWS_ACCESS_KEY_ID/BEDROCK_AWS_SECRET_ACCESS_KEY/BEDROCK_AWS_REGION; " +
        "one-shot commands may also use the standard AWS provider chain.",
    );
  }
  const model = config.bedrockModel;
  const access = process.env.BEDROCK_AWS_ACCESS_KEY_ID;
  const secret = process.env.BEDROCK_AWS_SECRET_ACCESS_KEY;
  const session = process.env.BEDROCK_AWS_SESSION_TOKEN;
  const region = process.env.BEDROCK_AWS_REGION ?? process.env.AWS_REGION;
  const client =
    access && secret
      ? new AnthropicBedrock({
          awsAccessKey: access,
          awsSecretKey: secret,
          ...(session ? { awsSessionToken: session } : {}),
          awsRegion: region,
          ...(fetchFn ? { fetch: fetchFn } : {}),
        })
      : new AnthropicBedrock({
          awsRegion: region,
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
