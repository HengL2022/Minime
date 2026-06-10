// Every tool returns this envelope (spec §8, I7): data + sources + staleness + gaps,
// so agent answers can cite and disclose rather than confabulate.

import { now } from "../util/clock";

export interface SourceRef {
  type: string;
  id: string;
  title?: string;
  updated_at?: Date | string;
  created_by?: string;
  derived?: boolean;
}

export interface Envelope<T = unknown> {
  data: T;
  sources: SourceRef[];
  staleness?: string;
  gaps?: string[];
}

export function envelope<T>(
  data: T,
  sources: SourceRef[] = [],
  opts?: { staleness?: string; gaps?: string[] },
): Envelope<T> {
  const env: Envelope<T> = { data, sources };
  if (opts?.staleness) env.staleness = opts.staleness;
  if (opts?.gaps?.length) env.gaps = opts.gaps;
  return env;
}

export function stalenessOf(
  newest: Date | string | null | undefined,
  what = "newest matching item",
): string | undefined {
  if (!newest) return undefined;
  const ageDays = Math.floor((now().getTime() - new Date(newest).getTime()) / 86_400_000);
  return ageDays > 30 ? `${what} is ${ageDays} days old` : undefined;
}

// Structured refusals (spec §8): { code, message }
export class ToolError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
