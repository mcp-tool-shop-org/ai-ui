<p align="center">
  <img src="https://raw.githubusercontent.com/mcp-tool-shop-org/brand/main/logos/ai-ui/readme.png" alt="AI-UI" width="200" />
</p>

**Diagnostic automatisé de la conception pour les SPA.** AI-UI analyse votre application en cours d'exécution, lit votre documentation et vous indique précisément quelles fonctionnalités documentées n'ont pas de point d'entrée visible dans l'interface utilisateur, et quelles parties de l'interface utilisateur ne sont pas documentées du tout.

Il ne fait pas de suppositions. Il crée un graphe de déclencheurs à partir des interactions réelles du navigateur, associe les fonctionnalités aux déclencheurs de manière déterministe et génère une carte de conception avec des verdicts exploitables : à afficher, à déprécier, à conserver, à fusionner. Ensuite, il vérifie la correction.

## Ce qu'il fait

```
README says "ambient soundscapes"  →  atlas extracts the feature
Probe clicks every button           →  "Audio Settings" trigger found
Diff matches feature to trigger     →  coverage: 64%
Design-map says: must-surface 0     →  all documented features are discoverable
```

AI-UI comble le fossé entre les promesses de la documentation et la réalité de l'interface utilisateur.

## Installation

```bash
git clone https://github.com/mcp-tool-shop-org/ai-ui.git
cd ai-ui
npm install
```

Nécessite Node.js 20+ et un serveur de développement en cours d'exécution pour les commandes probe/runtime-effects.

## Démarrage rapide

```bash
# 1. Parse your docs into a feature catalog
ai-ui atlas

# 2. Crawl your running app
ai-ui probe

# 3. Match features to triggers
ai-ui diff

# Or run all three in sequence:
ai-ui stage0
```

La sortie se trouve dans le répertoire `ai-ui-output/`. Le rapport de différences vous indique ce qui correspond, ce qui manque et ce qui n'est pas documenté.

## Commandes

| Commande | Ce qu'elle fait |
| --------- | ------------- |
| `atlas` | Analyse de la documentation (README, CHANGELOG, etc.) pour créer un catalogue de fonctionnalités. |
| `probe` | Analyse de l'interface utilisateur en cours d'exécution, enregistrement de chaque déclencheur interactif. |
| `surfaces` | Extraction des éléments d'interface utilisateur à partir d'une capture WebSketch. |
| `diff` | Association des fonctionnalités de l'atlas aux déclencheurs de la sonde. |
| `graph` | Création d'un graphe de déclencheurs à partir de la sonde + des éléments d'interface utilisateur + des différences. |
| `design-map` | Génération d'un inventaire des éléments d'interface utilisateur, d'une carte des fonctionnalités, des flux de tâches et d'une proposition d'architecture de l'information. |
| `compose` | Génération d'un plan d'affichage à partir des différences et du graphe. |
| `verify` | Évaluation des artefacts du pipeline : verdict "réussi/échoué" pour l'intégration continue. |
| `baseline` | Sauvegarde/comparaison des bases de référence de vérification. |
| `pr-comment` | Génération d'un commentaire Markdown prêt pour une demande de fusion à partir des artefacts. |
| `runtime-effects` | Clique sur les déclencheurs dans un navigateur réel, capture des effets secondaires observés. |
| `runtime-coverage` | Matrice de couverture par déclencheur (sondé / affiché / observé). |
| `replay-pack` | Regroupement de tous les artefacts dans un paquet de relecture reproductible. |
| `replay-diff` | Comparaison de deux paquets de relecture : affichage des modifications et de leurs raisons. |
| `stage0` | Exécution de l'atlas + de la sonde + des différences dans une séquence. |
| `init-memory` | Création de fichiers mémoire vides pour le suivi des décisions. |

## Configuration

Créez un fichier `ai-ui.config.json` à la racine de votre projet :

```json
{
  "docs": { "globs": ["README.md", "CHANGELOG.md", "docs/*.md"] },
  "probe": {
    "baseUrl": "http://localhost:5173",
    "routes": ["/", "/settings", "/dashboard"]
  },
  "featureAliases": {
    "dark-mode-support": ["Theme", "Dark mode"]
  },
  "goalRules": [
    { "id": "settings_open", "label": "Open Settings", "kind": "domEffect", "dom": { "textRegex": "Settings" }, "score": 2 }
  ]
}
```

Tous les champs sont facultatifs ; des valeurs par défaut raisonnables sont appliquées. Consultez `cli/src/config.mjs` pour le schéma complet.

### Règles de but

Pour les SPA où les URL ne changent pas, les objectifs basés sur les routes sont inutiles. Les règles de but vous permettent de définir le succès en termes d'effets observables :

| Kind | Correspondances | Exemple |
| ------ | --------- | --------- |
| `storageWrite` | Écritures dans localStorage/sessionStorage | `{ "keyRegex": "^user\\.prefs\\." }` |
| `fetch` | Requêtes HTTP par méthode/URL/statut | `{ "method": ["POST"], "urlRegex": "/api/save" }` |
| `domEffect` | Mutations du DOM (ouverture de modal, notification, etc.) | `{ "textRegex": "saved" }` |
| `composite` | Combinaison de plusieurs types | stockage + DOM pour "paramètres enregistrés" |

Les règles nécessitent des preuves d'exécution (`ai-ui runtime-effects` + `ai-ui graph --with-runtime`) pour produire des correspondances de but. Sans preuve, les objectifs restent non évalués, ce qui évite les faux positifs.

## Sortie de la carte de conception

La commande `design-map` génère quatre artefacts :

- **Inventaire des éléments d'interface utilisateur** : chaque élément interactif regroupé par emplacement (navigation principale, paramètres, barre d'outils, intégré).
- **Carte des fonctionnalités** : chaque fonctionnalité documentée avec un score de découvrabilité, des points d'entrée et une action recommandée.
- **Flux de tâches** : chaînes de navigation inférées avec détection des boucles et suivi des objectifs.
- **Proposition d'architecture de l'information** : navigation principale, navigation secondaire, éléments à afficher, éléments documentés mais non affichés, chemins de conversion.

### Actions recommandées

| Action | Signification |
| -------- | --------- |
| `promote` | La fonctionnalité est documentée mais difficile à trouver ; elle nécessite un point d'entrée plus visible. |
| `keep` | La fonctionnalité est bien équilibrée : elle est documentée et facile à découvrir. |
| `demote` | La fonctionnalité est importante mais présente des risques ou a une faible valeur : déplacer vers les paramètres avancés. |
| `merge` | Noms de fonctionnalités dupliqués entre les différentes sections : consolider. |
| `skip` | Ce n'est pas une véritable fonctionnalité (nom qui ressemble à une phrase, concept abstrait). |

## Pipeline

La séquence complète du pipeline :

```
atlas → probe → diff → graph → design-map
                 ↓
          runtime-effects → graph --with-runtime → design-map (with goals)
                                                        ↓
                                                   replay-pack → replay-diff
```

Chaque étape lit la sortie de l'étape précédente à partir du répertoire `ai-ui-output/`. Le pipeline est déterministe : les mêmes entrées produisent les mêmes sorties.

## Intégration continue (CI)

```bash
# Run pipeline + verify in CI
ai-ui stage0
ai-ui graph
ai-ui verify --strict --gate minimum --min-coverage 60

# Exit code 0 = pass, 1 = user error, 2 = runtime error
```

Utilisez `--json` pour une sortie lisible par machine. Utilisez `baseline --write` pour fixer les seuils.

## Modèle de menace

L'interface AI-UI s'exécute localement contre votre serveur de développement. Elle ne :
- Envoie de données à des services externes.
- Modifie votre code source ou votre configuration.
- Accède à quoi que ce soit en dehors de l'URL de base configurée et des répertoires de documentation.
- Nécessite un accès réseau (toute l'analyse est locale).

La commande `runtime-effects` simule des clics sur de vrais boutons dans un navigateur Playwright. Elle respecte les règles de sécurité :
- Les déclenchements correspondant aux motifs de blocage (supprimer, effacer, détruire, etc.) sont ignorés.
- L'attribut `data-aiui-safe` peut remplacer les règles de sécurité pour les déclenchements connus comme sûrs.
- Le mode `--dry-run` effectue une simulation de survol au lieu de cliquer.

## Tests

```bash
npm test
```

772 tests utilisant le moteur de test natif de Node.js. Aucun framework de test externe.

## Licence

MIT — voir [LICENSE](LICENSE).

---

Créé par [MCP Tool Shop](https://mcp-tool-shop.github.io/)
