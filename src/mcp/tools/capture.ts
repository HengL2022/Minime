import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { withDurableRuntimeDbTransaction } from "../../db/client";
import { ensureInboxItemIdentity, rejectRetryableInboxItem } from "../../db/repo";
import { atomicWritePrivate } from "../../util/atomic-file";
import { now } from "../../util/clock";
import { config } from "../../util/config";
import { envelope } from "../envelope";
import type { ToolDef } from "./registry";

export const captureTool: ToolDef = {
  name: "minime_capture",
  description:
    "Drop raw text into the inbox. The watcher classifies and files it (task / journal / interaction / note / org / person); low-confidence items go to the evening review queue. Hint `org / company record` or `person record` (or a first line `org: Name` / `person: Name`) files a resolvable identity instead of a page.",
  schema: {
    text: z.string().min(1),
    hint: z.string().optional(),
  },
  handler: async (params, ctx) => {
    const inboxDir = join(config.dataDir, "inbox");
    const ts = now().toISOString().replace(/[:.]/g, "-");
    const name = `capture-${ts}-${Math.random().toString(36).slice(2, 8)}.md`;
    const path = join(inboxDir, name);
    const body = params.hint ? `<!-- hint: ${params.hint} -->\n${params.text}` : params.text;
    const { id } = await withDurableRuntimeDbTransaction(() =>
      ensureInboxItemIdentity({
        rawPath: path,
        mime: "text/markdown",
        contentHash: createHash("sha256").update(body).digest("hex"),
        createdBy: ctx.actor,
      }),
    );
    // Publish only after the identity row commits. The watcher observes atomic rename, so it can
    // never win a file-visible/row-missing race or lose the requesting actor's provenance.
    try {
      await atomicWritePrivate(path, body);
    } catch (error) {
      await withDurableRuntimeDbTransaction(() =>
        rejectRetryableInboxItem(id, "capture source publication failed"),
      ).catch(() => {});
      throw error;
    }
    return envelope({ inbox_item_id: id }, [{ type: "inbox_item", id }]);
  },
};
