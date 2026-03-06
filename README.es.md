<p align="center">
  <img src="https://raw.githubusercontent.com/mcp-tool-shop-org/brand/main/logos/ai-ui/readme.png" alt="AI-UI" width="200" />
</p>

**Diagnóstico automatizado del diseño para SPAs.** AI-UI analiza su aplicación en ejecución, lee su documentación y le indica exactamente qué funciones documentadas no tienen un punto de entrada visible en la interfaz de usuario, y qué elementos de la interfaz de usuario no están documentados en absoluto.

No hace conjeturas. Crea un grafo de activación a partir de interacciones reales del navegador, asocia las funciones a los activadores de forma determinista y genera un mapa de diseño con veredictos que se pueden ejecutar: "debe mostrarse", "reducir importancia", "mantener", "fusionar". Luego, verifica la corrección.

## ¿Qué hace?

```
README says "ambient soundscapes"  →  atlas extracts the feature
Probe clicks every button           →  "Audio Settings" trigger found
Diff matches feature to trigger     →  coverage: 64%
Design-map says: must-surface 0     →  all documented features are discoverable
```

AI-UI cierra la brecha entre las promesas de la documentación y la realidad de la interfaz de usuario.

## Instalación

```bash
git clone https://github.com/mcp-tool-shop-org/ai-ui.git
cd ai-ui
npm install
```

Requiere Node.js 20+ y un servidor de desarrollo en ejecución para los comandos de "probe/runtime-effects".

## Comienzo rápido

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

La salida se guarda en `ai-ui-output/`. El informe de diferencias le indica qué elementos se encontraron, qué elementos faltan y qué elementos no están documentados.

## Comandos

| Comando | ¿Qué hace? |
| --------- | ------------- |
| `atlas` | Analiza la documentación (README, CHANGELOG, etc.) para crear un catálogo de funciones. |
| `probe` | Analiza la interfaz de usuario en ejecución y registra cada activador interactivo. |
| `surfaces` | Extrae los elementos de la interfaz de usuario de una captura de WebSketch. |
| `diff` | Asocia las funciones del catálogo con los activadores detectados. |
| `graph` | Crea un grafo de activación a partir de la información obtenida con el "probe", los elementos de la interfaz de usuario y las diferencias. |
| `design-map` | Genera un inventario de elementos de la interfaz de usuario, un mapa de funciones, flujos de tareas y una propuesta de arquitectura de la información. |
| `compose` | Genera un plan de implementación a partir de las diferencias y el grafo. |
| `verify` | Evalúa los artefactos del proceso de desarrollo: veredicto de "aprobado/fallido" para la integración continua. |
| `baseline` | Guarda y compara los puntos de referencia de verificación. |
| `pr-comment` | Genera un comentario en formato Markdown listo para una solicitud de extracción (pull request) a partir de los artefactos. |
| `runtime-effects` | Simula clics en activadores en un navegador real y registra los efectos secundarios observados. |
| `runtime-coverage` | Matriz de cobertura por activador (probado/mostrado/observado). |
| `replay-pack` | Agrupa todos los artefactos en un paquete reproducible. |
| `replay-diff` | Compara dos paquetes reproducibles: muestra qué ha cambiado y por qué. |
| `stage0` | Ejecuta el catálogo, el "probe" y la comparación de diferencias en secuencia. |
| `init-memory` | Crea archivos de memoria vacíos para el seguimiento de las decisiones. |

## Configuración

Cree un archivo `ai-ui.config.json` en la raíz de su proyecto:

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

Todos los campos son opcionales; se aplican valores predeterminados. Consulte `cli/src/config.mjs` para ver el esquema completo.

### Reglas de objetivos

Para SPAs donde las URL no cambian, las reglas basadas en rutas son inútiles. Las reglas de objetivos le permiten definir el éxito como efectos observables:

| Kind | Coincidencias | Ejemplo |
| ------ | --------- | --------- |
| `storageWrite` | Escrituras en localStorage/sessionStorage. | `{ "keyRegex": "^user\\.prefs\\." }` |
| `fetch` | Solicitudes HTTP por método/URL/código de estado. | `{ "method": ["POST"], "urlRegex": "/api/save" }` |
| `domEffect` | Mutaciones del DOM (apertura de modales, notificaciones, etc.). | `{ "textRegex": "saved" }` |
| `composite` | Combinación de múltiples tipos. | Escrituras + mutaciones del DOM para "configuración guardada". |

Las reglas requieren evidencia en tiempo de ejecución (`ai-ui runtime-effects` + `ai-ui graph --with-runtime`) para generar coincidencias con los objetivos. Sin evidencia, los objetivos permanecen sin evaluar; no hay falsos positivos.

## Salida del mapa de diseño

El comando `design-map` genera cuatro artefactos:

- **Inventario de elementos de la interfaz de usuario**: cada elemento interactivo agrupado por ubicación (navegación principal, configuración, barra de herramientas, en línea).
- **Mapa de funciones**: cada función documentada con una puntuación de descubribilidad, puntos de entrada y acción recomendada.
- **Flujos de tareas**: cadenas de navegación inferidas con detección de bucles y seguimiento de objetivos.
- **Propuesta de arquitectura de la información**: navegación principal, navegación secundaria, elementos que deben mostrarse, elementos documentados que no se muestran, rutas de conversión.

### Acciones recomendadas

| Acción | Significado |
| -------- | --------- |
| `promote` | La función está documentada pero está oculta; necesita un punto de entrada más visible. |
| `keep` | La funcionalidad está bien equilibrada: está documentada y es fácil de descubrir. |
| `demote` | La funcionalidad es destacada pero arriesgada o de bajo valor: trasladarla a la sección de opciones avanzadas/configuración. |
| `merge` | Nombres de funcionalidades duplicados en diferentes rutas: consolidar. |
| `skip` | No es una funcionalidad real (nombre similar a una frase, sin base sólida). |

## Pipeline (Proceso)

La secuencia completa del proceso:

```
atlas → probe → diff → graph → design-map
                 ↓
          runtime-effects → graph --with-runtime → design-map (with goals)
                                                        ↓
                                                   replay-pack → replay-diff
```

Cada etapa lee la salida de la etapa anterior desde el directorio `ai-ui-output/`. El proceso es determinista: las mismas entradas producen las mismas salidas.

## Integración con CI (Integración Continua)

```bash
# Run pipeline + verify in CI
ai-ui stage0
ai-ui graph
ai-ui verify --strict --gate minimum --min-coverage 60

# Exit code 0 = pass, 1 = user error, 2 = runtime error
```

Utilice `--json` para obtener una salida legible por máquinas. Utilice `baseline --write` para fijar los umbrales.

## Modelo de amenazas

AI-UI se ejecuta localmente contra su servidor de desarrollo. No:
- Envía datos a servicios externos.
- Modifica su código fuente o configuración.
- Accede a nada fuera de la `baseUrl` configurada y los patrones de archivos.
- Requiere acceso a la red (todo el análisis se realiza localmente).

El comando `runtime-effects` simula clics en botones reales en un navegador Playwright. Respeta las reglas de seguridad:
- Se omiten los disparadores que coinciden con los patrones de denegación (eliminar, borrar, destruir, etc.).
- El atributo `data-aiui-safe` puede anular la seguridad para los disparadores que se consideran seguros.
- El modo `--dry-run` simula el movimiento del cursor en lugar de realizar clics.

## Pruebas

```bash
npm test
```

772 pruebas utilizando el ejecutor de pruebas nativo de Node.js. No se utiliza ningún marco de pruebas externo.

## Licencia

MIT: consulte [LICENSE](LICENSE).

---

Creado por [MCP Tool Shop](https://mcp-tool-shop.github.io/)
