---
title: Project SILDRE
---

# Project SILDRE

SILDRE is Fjordsonics' flagship research contract: a 36-node hydrophone array deployed in
Trondheimsfjorden to track herring migration acoustically in real time. The research partner
is NTNU's Department of Marine Technology, and the contract budget is 4.2 million NOK.

## My role

I own the array geometry design and the beamforming pipeline. The signal chain runs on-node
preprocessing (band-pass 50 Hz – 8 kHz, then delay-and-sum beamforming) with classification
happening shore-side. Node firmware runs on Zephyr RTOS on an STM32H7; Tomasz owns the
firmware, I own the DSP blocks.

## Key dates

- Prototype review: passed 18 February 2026.
- Wet test with 6 nodes off Munkholmen: completed 7 May 2026, two nodes had connector
  corrosion issues (fixed with new Subconn connectors).
- Full 36-node field deployment deadline: 22 August 2026.
- Final report to the Research Council: March 2027.

## Open worries

The acoustic release mechanism is single-sourced from a vendor in Aberdeen with 11-week lead
times. If the August deployment slips, we lose the autumn herring season and the whole
timeline shifts a year.
