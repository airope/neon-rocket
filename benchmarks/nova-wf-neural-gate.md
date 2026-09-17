# NOVA-WF neural-controller gate decision

## Verdict

**Gate closed — do not start a neural-controller phase in this release.**

## Recorded observations

- Development campaign with default parameters against NOVA 2: 6 wins in 20 matches, zero timeouts (`nova-wf-vs-nova2-development-seeded-20.json`).
- `(1 + λ)` optimization: three generations with four offspring per generation (`nova-wf-optimization-development.json`).
- Two mutations replaced their parent, including one in the third generation. The heuristic search therefore had not demonstrated a plateau.
- Experimental champion `a0f81ee5886b1da2` against NOVA 2 on disjoint validation seeds `600000+`: 13 wins in 40 matches, zero timeouts (`nova-wf-optimized-vs-nova2-validation-40.json`).
- Experimental champion against default Wildfire parameters on the same paired scenarios `650000+`: 20–20, zero timeouts (`nova-wf-optimized-vs-default-validation-40.json`).

## Interpretation

The final mutation improves on its small development set but does not demonstrate an out-of-sample advantage over default Wildfire. The gap against NOVA 2 remains substantial. These results primarily suggest an insufficient optimization budget and high selection variance; they do not demonstrate an inherent limit of the heuristic architecture.

Adding a neural controller would introduce a training, versioning, inference and reproducibility pipeline without evidence that this complexity is necessary. It would also make improvements harder to attribute when the seeded protocol had only just been corrected.

## Conditions for reopening

Reconsider the gate only after:

1. several additional evolutionary cycles on fixed development seeds;
2. repeated absence of promotion across consecutive generations;
3. validation on disjoint seeds showing a stable performance ceiling;
4. confirmation that the dominant errors can no longer be corrected through existing states, trajectories, interception logic or mechanics;
5. advance definition of a reproducible neural baseline and a promotion gate identical to the heuristic controller's.
