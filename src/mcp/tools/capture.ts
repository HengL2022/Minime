import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { insertInboxItem } from "../../db/repo";
import { now } from "../../util/clock";
import { config } from "../../util/config";
import { envelope } from "../envelope";
import type { ToolDef } from "./registry";

export const captureTool: ToolDef = {
  name: "minime_capture",
  description:
    "Drop raw text into the inbox. The watcher classifies and files it (task / journal / interaction / note); low-confidence items go to the evening review queue.",
  schema: {
    text: z.string().min(1),
    hint: z.string().optional(),
  },
  handler: async (params, ctx) => {
    const inboxDir = join(config.dataDir, "inbox");
    await mkdir(inboxDir, { recursive: true });
    const ts = now().toISOString().replace(/[:.]/g, "-");
    const name = `capture-${ts}-${Math.random().toString(36).slice(2, 8)}.md`;
    const path = join(inboxDir, name);
    const body = params.hint ? `<!-- hint: ${params.hint} -->\n${params.text}` : params.text;
    await Bun.write(path, body);
    const { id } = await insertInboxItem({
      rawPath: path,
      mime: "text/markdown",
      createdBy: ctx.actor,
    });
    return envelope({ inbox_item_id: id, path }, [{ type: "inbox_item", id }]);
  },
};
