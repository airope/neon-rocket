# Gallery provenance

These are genuine, unaltered Chrome page captures of the [public solo demo](https://airope.github.io/neon-rocket/), not concept art, composite scenes or multiplayer screenshots. The recorded browser run began on 2026-09-17 and passed 42 checks across all three solo opponents. See [verification and limitations](../VERIFICATION.md).

| Published image | Original QA capture | What it shows |
| --- | --- | --- |
| `solo-gameplay.png` | `public-browser/solo-3-moving.png` | Active solo play against NOVA-WF; diagnostics in the associated QA report identify the native RocketSim engine |
| `demo-lobby.png` | `public-browser/solo-3-lobby.png` | Public demo lobby before opponent selection; the visible default is NOVA 1, despite the QA sequence filename |

Both images were visually inspected before inclusion. They contain only the game page: no browser chrome, account information, local filesystem paths, credentials or private room codes. The lobby pilot field contains the generic default “Pilote.” No gameplay state or UI text has been edited. No animation has been synthesized from separate states.

SHA-256 of the published files (identical to the originals):

```text
9190f4801764beed733dc00c9a872ff7ce56112604386ad508febc10285b2905  solo-gameplay.png
54b4b3a1619571a4c58b08ad824b9345f52a14b7b8512e86a80926cc6d5b0810  demo-lobby.png
```

The gameplay image documents native solo presentation and movement, not native goal-scoring or online hosting. Two-client local multiplayer has separate QA evidence; it is not a feature hosted by the public GitHub Pages demo.
