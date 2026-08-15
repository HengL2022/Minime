# VLM bake-off — 2026-08-15

Mode: **mock**. Images: 10 fictional 1×1 PNG fixtures (bytes only; never real photos).
Gold: committed captions in `fixtures/parse/images.ts`. Metric: token Jaccard vs gold (lowercase `\W+` tokens).
Models: `mock-hash`.
Cloud VLM routes stay rejected. CLIP/SigLIP stays deferred.

## mock-hash

Mean Jaccard: **1.000** (10 images).

| id | title | jaccard | caption |
|---|---|---:|---|
| harbor-pier | Harbor pier at dusk | 1.000 | A fictional harbor pier at dusk with coiled rope on the dock. |
| cafe-receipt | Cafe receipt | 1.000 | A fictional cafe receipt dated 2026-03-12 totaling 12.40 for tea and a bun. |
| whiteboard-array | Whiteboard hydrophone array | 1.000 | A fictional whiteboard sketch of a 36-node hydrophone array with labeled cables and a Trondheim fjord bathymetry outline. |
| wetlab-tray | Wet-lab tray labels | 1.000 | A fictional wet-lab tray with printed sample labels for herring otoliths and a dated run sheet. |
| nyckelharpa-table | Nyckelharpa on a table | 1.000 | A fictional three-row nyckelharpa lying on a birch table beside a resin bow and a Byss-Calle tune sheet. |
| biscuit-whippet | Biscuit the whippet | 1.000 | A fictional fawn whippet named Biscuit wearing a mustard wool jumper on a sofa. |
| nidelva-run | Nidelva river run | 1.000 | A fictional winter morning run along the Nidelva with frost on the path and the Nidaros spire in the distance. |
| sildre-crate | SILDRE node crate | 1.000 | A fictional wooden crate stenciled SILDRE NODE 07 with a foam-packed hydrophone and a firmware USB stick. |
| bakery-window | Cinnamon-bun bakery window | 1.000 | A fictional bakery window on Bakklandet showing cinnamon buns and a handwritten ranking card. |
| passport-visa | Passport visa stamp | 1.000 | A fictional passport page with a Japan visa stamp dated April 2025 and a Takayama entry mark. |

