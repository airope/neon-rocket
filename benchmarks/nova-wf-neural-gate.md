# Décision du gate neuronal NOVA-WF

## Verdict

**Gate fermé — ne pas engager une phase neuronale dans cette release.**

## Éléments observés

- Campagne de développement des paramètres par défaut contre NOVA 2 : 6 victoires sur 20 matchs, zéro timeout (`nova-wf-vs-nova2-development-seeded-20.json`).
- Optimisation `(1 + λ)` : trois générations et quatre enfants par génération (`nova-wf-optimization-development.json`).
- Deux mutations ont remplacé leur parent, dont une à la troisième génération. La recherche heuristique n'a donc pas atteint un plateau démontré.
- Champion expérimental `a0f81ee5886b1da2` contre NOVA 2 sur les seeds de validation disjointes `600000+` : 13 victoires sur 40, zéro timeout (`nova-wf-optimized-vs-nova2-validation-40.json`).
- Champion expérimental contre paramètres Wildfire par défaut sur les mêmes scénarios appariés `650000+` : 20–20, zéro timeout (`nova-wf-optimized-vs-default-validation-40.json`).

## Interprétation

La mutation finale progresse sur son petit ensemble de développement, mais ne démontre aucun avantage hors échantillon contre Wildfire par défaut. L'écart contre NOVA 2 demeure important. Ces résultats indiquent surtout un budget d'optimisation trop petit et une variance de sélection élevée ; ils ne démontrent pas une limite intrinsèque de l'architecture heuristique.

L'ajout d'un contrôleur neuronal introduirait un pipeline d'entraînement, de versionnement, d'inférence et de reproductibilité sans preuve que cette complexité est nécessaire. Il rendrait également plus difficile l'attribution des progrès alors que le protocole seedé vient seulement d'être corrigé.

## Conditions de réouverture

Réexaminer le gate uniquement après :

1. plusieurs cycles évolutionnaires supplémentaires sur des seeds de développement fixes ;
2. absence répétée de promotion sur plusieurs générations consécutives ;
3. validation sur des seeds disjointes montrant un plafond stable ;
4. confirmation que les erreurs dominantes ne sont plus corrigeables par les états, trajectoires, interceptions ou mécaniques existants ;
5. définition préalable d'un baseline neuronal reproductible et d'un gate de promotion identique à celui du contrôleur heuristique.
