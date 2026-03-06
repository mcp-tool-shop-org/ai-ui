<p align="center">
  <img src="https://raw.githubusercontent.com/mcp-tool-shop-org/brand/main/logos/ai-ui/readme.png" alt="AI-UI" width="200" />
</p>

**Diagnostica automatizzata del design per applicazioni SPA.** AI-UI analizza la tua applicazione in esecuzione, legge la tua documentazione e ti indica esattamente quali funzionalità documentate non hanno un punto di accesso nell'interfaccia utente e quali elementi dell'interfaccia utente non sono documentati affatto.

Non fa congetture. Crea un grafo di attivazione a partire dalle interazioni reali con il browser, associa le funzionalità agli attivatori in modo deterministico e genera una mappa di design con giudizi attuabili: "da rendere visibile", "da declassare", "da mantenere", "da unire". Quindi, verifica la correzione.

## Cosa fa

```
README says "ambient soundscapes"  →  atlas extracts the feature
Probe clicks every button           →  "Audio Settings" trigger found
Diff matches feature to trigger     →  coverage: 64%
Design-map says: must-surface 0     →  all documented features are discoverable
```

AI-UI colma il divario tra le promesse della documentazione e la realtà dell'interfaccia utente.

## Installazione

```bash
git clone https://github.com/mcp-tool-shop-org/ai-ui.git
cd ai-ui
npm install
```

Richiede Node.js 20+ e un server di sviluppo in esecuzione per i comandi probe/runtime-effects.

## Guida rapida

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

L'output viene salvato in `ai-ui-output/`. Il report delle differenze ti indica cosa è stato trovato, cosa manca e cosa non è documentato.

## Comandi

| Comando | Cosa fa |
| --------- | ------------- |
| `atlas` | Analizza la documentazione (README, CHANGELOG, ecc.) per creare un catalogo delle funzionalità. |
| `probe` | Analizza l'interfaccia utente in esecuzione, registra ogni attivatore interattivo. |
| `surfaces` | Estrae gli elementi dell'interfaccia utente da una cattura WebSketch. |
| `diff` | Confronta le funzionalità del catalogo con gli attivatori rilevati. |
| `graph` | Crea un grafo di attivazione a partire dai dati rilevati, dagli elementi dell'interfaccia utente e dalle differenze. |
| `design-map` | Genera un inventario degli elementi dell'interfaccia utente, una mappa delle funzionalità, i flussi di lavoro e una proposta di architettura dell'informazione. |
| `compose` | Genera un piano di implementazione a partire dalle differenze e dal grafo. |
| `verify` | Valuta gli artefatti del processo di sviluppo (build) e fornisce un giudizio di "superato/non superato" per l'integrazione continua (CI). |
| `baseline` | Salva e confronta le baseline di verifica. |
| `pr-comment` | Genera un commento in formato Markdown pronto per una pull request (PR) a partire dagli artefatti. |
| `runtime-effects` | Simula clic sugli attivatori in un browser reale e registra gli effetti collaterali osservati. |
| `runtime-coverage` | Matrice di copertura per ogni attivatore (rilevato/visualizzato/osservato). |
| `replay-pack` | Raggruppa tutti gli artefatti in un pacchetto riproducibile. |
| `replay-diff` | Confronta due pacchetti riproducibili e mostra cosa è cambiato e perché. |
| `stage0` | Esegue il catalogo, la rilevazione e il confronto in sequenza. |
| `init-memory` | Crea file di memoria vuoti per il tracciamento delle decisioni. |

## Configurazione

Crea un file `ai-ui.config.json` nella directory principale del tuo progetto:

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

Tutti i campi sono opzionali; vengono applicati valori predefiniti sensati. Consulta `cli/src/config.mjs` per lo schema completo.

### Regole degli obiettivi

Per le applicazioni SPA in cui gli URL non cambiano, le regole basate sui percorsi sono inutili. Le regole degli obiettivi consentono di definire il successo in base agli effetti osservabili:

| Kind | Corrispondenze | Esempio |
| ------ | --------- | --------- |
| `storageWrite` | Scritture in localStorage/sessionStorage. | `{ "keyRegex": "^user\\.prefs\\." }` |
| `fetch` | Richieste HTTP per metodo/URL/codice di stato. | `{ "method": ["POST"], "urlRegex": "/api/save" }` |
| `domEffect` | Modifiche al DOM (apertura di una finestra modale, notifiche, ecc.). | `{ "textRegex": "saved" }` |
| `composite` | Combinazione di più tipi. | storage + dom per "impostazioni salvate". |

Le regole richiedono prove in fase di esecuzione (`ai-ui runtime-effects` + `ai-ui graph --with-runtime`) per generare risultati. Senza prove, gli obiettivi rimangono non valutati, evitando falsi positivi.

## Output della mappa di design

Il comando `design-map` genera quattro artefatti:

- **Inventario degli elementi dell'interfaccia utente:** tutti gli elementi interattivi raggruppati per posizione (navigazione principale, impostazioni, barra degli strumenti, inline).
- **Mappa delle funzionalità:** ogni funzionalità documentata con un punteggio di rilevabilità, i punti di accesso e l'azione consigliata.
- **Flussi di lavoro:** catene di navigazione inferite con rilevamento dei cicli e tracciamento degli obiettivi.
- **Proposta di architettura dell'informazione:** navigazione principale, navigazione secondaria, elementi da rendere visibili, elementi documentati ma non visualizzati, percorsi di conversione.

### Azioni consigliate

| Azione | Significato |
| -------- | --------- |
| `promote` | La funzionalità è documentata ma nascosta; è necessario un punto di accesso più visibile. |
| `keep` | La funzionalità è ben bilanciata: documentata e facilmente individuabile. |
| `demote` | La funzionalità è importante ma rischiosa o di basso valore: spostarla in "avanzate" o nelle "impostazioni". |
| `merge` | Nomi di funzionalità duplicati tra i percorsi: consolidare. |
| `skip` | Non è una vera funzionalità (nome simile a una frase, non supportata da dati concreti). |

## Pipeline

La sequenza completa della pipeline:

```
atlas → probe → diff → graph → design-map
                 ↓
          runtime-effects → graph --with-runtime → design-map (with goals)
                                                        ↓
                                                   replay-pack → replay-diff
```

Ogni fase legge l'output della fase precedente dalla directory `ai-ui-output/`. La pipeline è deterministica: gli stessi input producono gli stessi output.

## Integrazione con CI (Continuous Integration)

```bash
# Run pipeline + verify in CI
ai-ui stage0
ai-ui graph
ai-ui verify --strict --gate minimum --min-coverage 60

# Exit code 0 = pass, 1 = user error, 2 = runtime error
```

Utilizzare `--json` per un output leggibile dalle macchine. Utilizzare `baseline --write` per definire le soglie.

## Modello di rischio

AI-UI viene eseguito localmente contro il tuo server di sviluppo. Non:
- Invia dati a servizi esterni.
- Modifica il tuo codice sorgente o la configurazione.
- Accede a risorse al di fuori dell'URL di base configurato e dei modelli di documenti.
- Richiede l'accesso alla rete (tutte le analisi sono locali).

Il comando `runtime-effects` simula clic su pulsanti reali in un browser Playwright. Rispetta le regole di sicurezza:
- I trigger che corrispondono a modelli di blocco (delete, remove, destroy, ecc.) vengono ignorati.
- L'attributo `data-aiui-safe` può sovrascrivere le impostazioni di sicurezza per i trigger considerati sicuri.
- La modalità `--dry-run` simula il clic, senza effettuarlo.

## Test

```bash
npm test
```

772 test eseguiti utilizzando il test runner nativo di Node.js. Nessun framework di test esterno.

## Licenza

MIT — vedere [LICENSE](LICENSE).

---

Creato da [MCP Tool Shop](https://mcp-tool-shop.github.io/)
