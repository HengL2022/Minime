// Sanctioned repair: flag leftover extract-minted orgs whose names match a
// known person (Fix A class). Flag-only — never retype, merge, or delete.
// Owner later runs retype-org-to-person on confirmed phantoms.
import { flagExtractPersonNamedOrgs } from "../../src/db/repo";
import type { RepairModule } from "../repair";

const mod: RepairModule = {
  name: "sweep-extract-person-orgs",
  description:
    "Flag extract-minted orgs whose names match a known person (exact, first token, or possessive). Flag-only.",
  async run() {
    const result = await flagExtractPersonNamedOrgs();
    return { counts: { orgs_flagged: result.flagged }, ids: result.ids };
  },
};
export default mod;
