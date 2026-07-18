// Sanctioned repair: org mistyped as… actually a person (or vice-versa cleanup entry point).
// Wraps repo.retypeOrgToPerson — reversible by design (org is retired, never deleted).
import { retypeOrgToPerson } from "../../src/db/repo";
import type { RepairModule } from "../repair";

function argOf(args: string[], key: string): string | undefined {
  const hit = args.find((a) => a.startsWith(`--${key}=`));
  return hit?.slice(key.length + 3);
}

const mod: RepairModule = {
  name: "retype-org-to-person",
  description:
    "Retype a mistyped org row into a person: repoint edges, retire the org (reversible).",
  async run(args) {
    const orgId = argOf(args, "org-id");
    if (!orgId) throw new Error("usage: --org-id=<uuid> [--relation=<r>] [--reason=<text>]");
    const res = await retypeOrgToPerson(orgId, {
      relation: argOf(args, "relation") ?? null,
      reason: argOf(args, "reason") ?? "repair:retype-org-to-person",
    });
    // read-back verification is the summary: counts and ids only
    return {
      person_id: res.personId,
      org_id: res.orgId,
      created: String(res.created),
      edges_repointed: res.edgesRepointed,
    };
  },
};
export default mod;
