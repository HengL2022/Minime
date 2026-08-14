// Sanctioned repair: two person rows are the same real human (repeated capture spellings, e.g.
// years of "Sarha"/"Sarah" fragmentation). Wraps repo.mergePersonIntoPerson — reversible by
// design (the source row is kept, only superseded, per I5 provenance).
import { mergePersonIntoPerson } from "../../src/db/repo";
import type { RepairModule } from "../repair";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function argOf(args: string[], key: string): string | undefined {
  const hit = args.find((a) => a.startsWith(`--${key}=`));
  return hit?.slice(key.length + 3);
}

const mod: RepairModule = {
  name: "merge-person",
  description:
    "Merge a duplicate person into another: move aliases/interactions/edges, supersede the source (reversible).",
  async run(args) {
    const fromId = argOf(args, "from");
    const intoId = argOf(args, "into");
    if (!fromId || !intoId || !UUID.test(fromId) || !UUID.test(intoId)) {
      throw new Error("usage: --from=<uuid> --into=<uuid>");
    }
    // mergePersonIntoPerson normalizes internally too (repo.ts) — lowercase here as well so this
    // script's own summary/ids never carry a pasted-in uppercase spelling past this boundary.
    const res = await mergePersonIntoPerson(fromId.toLowerCase(), intoId.toLowerCase());
    // read-back verification is the summary: counts and ids only
    return {
      counts: {
        edges_repointed: res.edgesRepointed,
        aliases_moved: res.aliasesMoved,
        interactions_repointed: res.interactionsRepointed,
      },
      ids: [res.fromId, res.intoId],
    };
  },
};
export default mod;
