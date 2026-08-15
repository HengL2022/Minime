# VLM bake-off — 2026-08-15

Mode: **live**. Images: 10 fictional labeled PNG cards (bytes only; never real photos).
Gold: committed captions in `fixtures/parse/images.ts`. Metric: token Jaccard vs gold (lowercase `\W+` tokens).
Models: `moondream`, `llava:7b`.
Cloud VLM routes stay rejected. CLIP/SigLIP stays deferred.

## moondream

Mean Jaccard: **0.000** (10 images).

| id | title | jaccard | caption |
|---|---|---:|---|
| harbor-pier | Harbor pier at dusk | 0.000 |  |
| cafe-receipt | Cafe receipt | 0.000 |  |
| whiteboard-array | Whiteboard hydrophone array | 0.000 |  |
| wetlab-tray | Wet-lab tray labels | 0.000 |  |
| nyckelharpa-table | Nyckelharpa on a table | 0.000 |  |
| biscuit-whippet | Biscuit the whippet | 0.000 |  |
| nidelva-run | Nidelva river run | 0.000 |  |
| sildre-crate | SILDRE node crate | 0.000 |  |
| bakery-window | Cinnamon-bun bakery window | 0.000 |  |
| passport-visa | Passport visa stamp | 0.000 |  |

## llava:7b

Mean Jaccard: **0.140** (10 images).

| id | title | jaccard | caption |
|---|---|---:|---|
| harbor-pier | Harbor pier at dusk | 0.244 | The image shows a sign with text that reads "Harbor Pier Dusk" and "Coiled Rope on the Dock." Below the text, there is a graphic of a rope coiled on a dock. The style of the image is reminiscent of a digital or virtual sign, possibly from a video game or a virtual environment. The text "Fictional Capture" is visible, indicating that the image is not a real-world photograph but rather a representation of a scene. |
| cafe-receipt | Cafe receipt | 0.147 | The image shows a receipt from a cafe. The date on the receipt is 2021-03-12. The total amount paid is 12.12. The receipt also indicates that the payment was made at 12:45 PM. |
| whiteboard-array | Whiteboard hydrophone array | 0.119 | The image appears to be a screenshot of a digital display or a digital representation of a physical object, possibly a sign or a label. It features a whiteboard with text and a graphic element. The text on the whiteboard reads "WHITEBOARD" at the top, followed by "36 Nodes Hydrophone Array" in a smaller font. Below this, there is a list of numbers: "36 37 38 39 40 41 42 43 44 45 46 47 48 49 5 |
| wetlab-tray | Wet-lab tray labels | 0.177 | The image shows a sign with text that reads "Wet-lab tray herring otolith labels Fictional capture." The sign is green and white, and it appears to be a label or a sign for a product or service related to a wet lab. The text suggests that the sign is for a product that is used in a wet lab setting, possibly for organizing or labeling samples. The term "herring otolith labels" indicates that the product is likely related to marine biology or ecology, as otoliths are structures in the inner ear of fish that help them maintain balance. The term |
| nyckelharpa-table | Nyckelharpa on a table | 0.103 | The image appears to be a digital or printed receipt. It lists the following items:  1. BIRCH TABLE RESIN BOW 2. FICIONAL CAPTURE  The total amount is $10. The date on the receipt is not fully visible, but it seems to be from the 15th of a month. The merchant's name is not fully visible, but it appears to be "NYKEL HARPPA." The receipt also includes a note that says "FICIONAL CAPTURE." |
| biscuit-whippet | Biscuit the whippet | 0.043 | The image appears to be a digital or printed receipt. It lists the following items:  1. Biscuit 2. Whipped cream 3. Funnel cake 4. Funnel cake 5. Funnel cake 6. Funnel cake 7. Funnel cake 8. Funnel cake 9. Funnel cake 10. Funnel cake 11. Funnel cake 12. Funnel cake 13. Funnel cake 14. Funnel cake 15. Funnel cake 16. Funnel cake 17. Funnel |
| nidelva-run | Nidelva river run | 0.129 | The image appears to be a screenshot of a digital interface, possibly a webpage or a mobile application. It features a navigation bar at the top with the text "NIDELVA RUN" and a sub-menu item "FROSTNADOS SPINE." Below this, there is a section titled "Fictional capture" with a placeholder image of a book cover. The book cover is labeled "FROSTNADOS SPINE" and has a subtitle "FROSTNADOS SPINE." The image is a placeholder, commonly used in design mockups or in software development to represent |
| sildre-crate | SILDRE node crate | 0.143 | The image shows a digital display with text and a barcode. The text on the display reads "SILDE NODe 007" and "Foam Hydrophone USB." Below the text, there is a barcode and a QR code. The barcode is scannable and likely contains information about the product or the order. The QR code is also scannable and typically contains a link to more information about the product or the order. The image has a watermark that says "Fictional capture," indicating that this is a staged or fictional image and not a real photograph |
| bakery-window | Cinnamon-bun bakery window | 0.121 | The image shows a digital display with a red background and white text. The text is a mix of English and what appears to be a fictional language, possibly from a video game or a fictional setting. The English text reads "BAKERY WINDOW" and "BAKLAND CINNAMON BUNS." Below this, there is a list of items with their respective quantities and prices, which are not fully visible. The items listed are "BAKLAND CINNAMON BUNS" and "BAKLAND CINNAMON BUNS." The price for each |
| passport-visa | Passport visa stamp | 0.170 | The image shows a digital display of a travel document, specifically a "PASSPORT VISA" for a trip to Japan. The document is dated April 20, 2021, and is from Tokyo, Japan. It is a fictional capture image, as indicated by the text "Fictional capture image" at the bottom. The document includes a barcode and a QR code, which are typical features of a real passport. The text "JAPAN APRIL 20, 2021 TOKYO" is prominently displayed, along with the name " |

