#!/usr/bin/env bun

// W6 VLM bake-off: score 10 fictional fixture images against sealed gold captions.
// Mock path uses hash-keyed captions (Jaccard 1.0 by construction). Live path calls
// describeImage when VLM_MODEL is set and never invents scores. Cloud VLM stays rejected.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BAKEOFF_IMAGES, type BakeoffImage } from "../fixtures/parse/images";
import { describeImage } from "../src/llm/describe";
import { mockDescribe } from "../src/llm/mock-describe";
import { sha256Hex } from "../src/util/hash";

const ROOT = join(import.meta.dir, "..");
const RESULTS_DIR = join(ROOT, "docs", "benchmarks");

export interface BakeoffArgs {
  mode: "mock" | "live";
  publish: boolean;
  models: string[];
}

export interface ImageScore {
  id: string;
  title: string;
  model: string;
  gold: string;
  caption: string;
  jaccard: number;
}

export function tokenJaccard(left: string, right: string): number {
  const tokens = (text: string) => new Set(text.toLowerCase().split(/\W+/u).filter(Boolean));
  const a = tokens(left);
  const b = tokens(right);
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const token of a) if (b.has(token)) inter++;
  return inter / (a.size + b.size - inter);
}

function argValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error("vlm_bakeoff_args_invalid");
  return value;
}

export function parseBakeoffArgs(argv: readonly string[]): BakeoffArgs {
  const known = new Set(["--mode", "--models", "--publish"]);
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!known.has(token)) throw new Error("vlm_bakeoff_args_invalid");
    if (seen.has(token)) throw new Error("vlm_bakeoff_args_invalid");
    seen.add(token);
    if (token !== "--publish") i++;
  }
  const mode = argValue(argv, "mode") ?? "mock";
  if (mode !== "mock" && mode !== "live") throw new Error("vlm_bakeoff_mode_invalid");
  const modelsRaw = argValue(argv, "models");
  const models =
    mode === "mock"
      ? ["mock-hash"]
      : (modelsRaw ?? process.env.VLM_MODEL ?? "")
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean);
  if (mode === "live" && models.length === 0) throw new Error("vlm_bakeoff_model_required");
  return { mode, publish: argv.includes("--publish"), models };
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function renderBakeoffScorecard(input: {
  date: string;
  mode: "mock" | "live";
  models: string[];
  scores: ImageScore[];
}): string {
  const lines = [
    `# VLM bake-off — ${input.date}`,
    "",
    `Mode: **${input.mode}**. Images: ${BAKEOFF_IMAGES.length} fictional labeled PNG cards (bytes only; never real photos).`,
    "Gold: committed captions in `fixtures/parse/images.ts`. Metric: token Jaccard vs gold (lowercase `\\W+` tokens).",
    `Models: ${input.models.map((name) => `\`${name}\``).join(", ")}.`,
    "Cloud VLM routes stay rejected. CLIP/SigLIP stays deferred.",
    "",
  ];
  for (const model of input.models) {
    const rows = input.scores.filter((score) => score.model === model);
    const avg = mean(rows.map((row) => row.jaccard));
    lines.push(`## ${model}`);
    lines.push("");
    lines.push(`Mean Jaccard: **${avg.toFixed(3)}** (${rows.length} images).`);
    lines.push("");
    lines.push("| id | title | jaccard | caption |");
    lines.push("|---|---|---:|---|");
    for (const row of rows) {
      const caption = row.caption.replace(/\|/g, "\\|").replace(/\n/g, " ");
      lines.push(`| ${row.id} | ${row.title} | ${row.jaccard.toFixed(3)} | ${caption} |`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

async function captionFor(
  image: BakeoffImage,
  mode: "mock" | "live",
  model: string,
): Promise<string> {
  if (mode === "mock") return mockDescribe(sha256Hex(image.png));
  const { config } = await import("../src/util/config");
  (config as { mockOllama: boolean }).mockOllama = false;
  config.vlmModel = model;
  const caption = await describeImage({
    mime: "image/png",
    base64: image.png.toString("base64"),
    sha256: sha256Hex(image.png),
    tier: image.suggestedTier,
  });
  // Empty is a scored miss, not a harness abort — 1×1 fixtures often yield nothing.
  return caption ?? "";
}

export async function scoreBakeoff(args: BakeoffArgs): Promise<ImageScore[]> {
  const scores: ImageScore[] = [];
  for (const model of args.models) {
    for (const image of BAKEOFF_IMAGES) {
      const caption = await captionFor(image, args.mode, model);
      scores.push({
        id: image.id,
        title: image.title,
        model,
        gold: image.caption,
        caption,
        jaccard: tokenJaccard(image.caption, caption),
      });
    }
  }
  return scores;
}

export async function main(argv: readonly string[] = Bun.argv.slice(2)): Promise<number> {
  let args: BakeoffArgs;
  try {
    args = parseBakeoffArgs(argv);
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : "vlm_bakeoff_args_invalid"}`);
    return 2;
  }
  let scores: ImageScore[];
  try {
    scores = await scoreBakeoff(args);
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : "vlm_bakeoff_failed"}`);
    return 1;
  }
  const date = todayStr();
  const markdown = renderBakeoffScorecard({ date, mode: args.mode, models: args.models, scores });
  console.log(markdown);
  if (args.publish) {
    mkdirSync(RESULTS_DIR, { recursive: true });
    const path = join(RESULTS_DIR, `${date}-vlm-bakeoff.md`);
    writeFileSync(path, markdown);
    console.error(`scorecard: ${path}`);
  }
  if (args.mode === "mock" && scores.some((score) => score.jaccard !== 1)) {
    console.error("ERROR: mock bake-off must score 1.0 by construction");
    return 1;
  }
  return 0;
}

if (import.meta.main) process.exit(await main());
