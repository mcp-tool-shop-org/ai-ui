<p align="center">
  <img src="https://raw.githubusercontent.com/mcp-tool-shop-org/brand/main/logos/ai-ui/readme.png" alt="AI-UI" width="200" />
</p>

**SPA向け自動設計診断ツール**。AI-UIは、動作中のアプリケーションをクロールし、ドキュメントを読み込み、どのドキュメント化された機能が発見可能なUIのエントリーポイントを持っていないか、そしてどのUI要素が全くドキュメント化されていないかを正確に示します。

これは推測ではありません。実際のブラウザの操作からトリガーグラフを構築し、機能をトリガーと決定的に照合し、実行可能な判断を含む設計マップを作成します。その後、修正内容を確認します。

## 機能概要

```
README says "ambient soundscapes"  →  atlas extracts the feature
Probe clicks every button           →  "Audio Settings" trigger found
Diff matches feature to trigger     →  coverage: 64%
Design-map says: must-surface 0     →  all documented features are discoverable
```

AI-UIは、ドキュメントの約束とUIの現実との間のギャップを埋めます。

## インストール

```bash
git clone https://github.com/mcp-tool-shop-org/ai-ui.git
cd ai-ui
npm install
```

Node.js 20以上と、probe/runtime-effectsコマンドを実行するための動作中の開発サーバーが必要です。

## クイックスタート

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

出力は`ai-ui-output/`に保存されます。差分レポートには、一致した項目、不足している項目、およびドキュメント化されていない項目が表示されます。

## コマンド

| コマンド | 機能概要 |
| --------- | ------------- |
| `atlas` | ドキュメント（README、CHANGELOGなど）を機能カタログに変換 |
| `probe` | 動作中のUIをクロールし、すべてのインタラクティブなトリガーを記録 |
| `surfaces` | WebSketchのキャプチャからUI要素を抽出 |
| `diff` | atlasの機能とprobeのトリガーを照合 |
| `graph` | probe、UI要素、および差分からトリガーグラフを構築 |
| `design-map` | UI要素のインベントリ、機能マップ、タスクフロー、および情報アーキテクチャの提案を生成 |
| `compose` | 差分とグラフからUI表示計画を生成 |
| `verify` | パイプラインの成果物を評価し、CI用の合格/不合格の判断を行う |
| `baseline` | 検証のベースラインを保存/比較 |
| `pr-comment` | 成果物からPR対応のMarkdownコメントを生成 |
| `runtime-effects` | 実際のブラウザでトリガーをクリックし、観察された副作用をキャプチャ |
| `runtime-coverage` | トリガーごとのカバレッジマトリックス（probe対象 / UI表示 / 観察済み） |
| `replay-pack` | すべての成果物を再現可能なリプレイパックにまとめ |
| `replay-diff` | 2つのリプレイパックを比較し、変更点とその理由を表示 |
| `stage0` | atlas、probe、および差分を順番に実行 |
| `init-memory` | 意思決定の追跡のための空のメモリファイルを作成 |

## 設定

プロジェクトのルートディレクトリに`ai-ui.config.json`を作成します。

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

すべてのフィールドはオプションであり、適切なデフォルト値が適用されます。完全なスキーマについては、`cli/src/config.mjs`を参照してください。

### 目標ルール

URLが変わらないSPAでは、ルートベースの目標は役に立ちません。目標ルールを使用すると、観察可能な効果として成功を定義できます。

| Kind | 一致するもの | 例 |
| ------ | --------- | --------- |
| `storageWrite` | localStorage/sessionStorageへの書き込み | `{ "keyRegex": "^user\\.prefs\\." }` |
| `fetch` | HTTPリクエスト（メソッド/URL/ステータス別） | `{ "method": ["POST"], "urlRegex": "/api/save" }` |
| `domEffect` | DOMの変更（モーダルの表示、トーストなど） | `{ "textRegex": "saved" }` |
| `composite` | 複数の種類のAND条件 | 「設定が保存された」場合、storage + dom |

ルールは、目標を評価するために、実行時の証拠（`ai-ui runtime-effects` + `ai-ui graph --with-runtime`）が必要です。証拠がない場合、目標は評価されず、誤った結果は表示されません。

## 設計マップの出力

`design-map`コマンドは、次の4つの成果物を生成します。

- **UI要素のインベントリ**：場所（プライマリナビゲーション、設定、ツールバー、インライン）ごとにグループ化されたすべてのインタラクティブな要素
- **機能マップ**：ドキュメント化された各機能について、発見可能性のスコア、エントリーポイント、および推奨されるアクション
- **タスクフロー**：ループ検出と目標追跡機能を持つ、推測されたナビゲーションシーケンス
- **情報アーキテクチャの提案**：プライマリナビゲーション、セカンダリナビゲーション、UI表示が必要な要素、ドキュメント化されていないUI要素、コンバージョンパス

### 推奨されるアクション

| アクション | 意味 |
| -------- | --------- |
| `promote` | 機能はドキュメント化されているが、見つけにくい。より発見しやすいエントリーポイントが必要です。 |
| `keep` | 機能はバランスが取れており、ドキュメントが整備されており、発見しやすい。 |
| `demote` | 機能は目立つが、リスクが高いか、または価値が低い場合、詳細設定または設定画面へ移動する。 |
| `merge` | 異なるルートで同じ機能名が使用されている場合、統合する。 |
| `skip` | これは実際の機能ではない（文のような名前で、具体的な根拠がない）。 |

## パイプライン

パイプライン全体のシーケンス：

```
atlas → probe → diff → graph → design-map
                 ↓
          runtime-effects → graph --with-runtime → design-map (with goals)
                                                        ↓
                                                   replay-pack → replay-diff
```

各ステージは、前のステージの出力を `ai-ui-output/` から読み込みます。このパイプラインは決定論的であり、同じ入力からは常に同じ出力が得られます。

## CI連携

```bash
# Run pipeline + verify in CI
ai-ui stage0
ai-ui graph
ai-ui verify --strict --gate minimum --min-coverage 60

# Exit code 0 = pass, 1 = user error, 2 = runtime error
```

機械可読な出力には `--json` オプションを使用します。閾値を固定するには、`baseline --write` コマンドを使用します。

## 脅威モデル

AI-UI は、ローカルでご自身の開発サーバーに対して実行されます。AI-UI は以下の操作を行いません。
- 外部サービスへのデータ送信
- ソースコードまたは設定の変更
- 設定された `baseUrl` およびドキュメントの glob 範囲外へのアクセス
- ネットワークアクセス（すべての分析はローカルで行われます）

`runtime-effects` コマンドは、Playwright ブラウザで実際のボタンをクリックします。安全規則を遵守します。
- 拒否パターンに一致するトリガー（削除、除去、破棄など）はスキップされます。
- `data-aiui-safe` 属性を使用することで、安全であることがわかっているトリガーに対して安全性を上書きできます。
- `--dry-run` モードでは、クリックする代わりにマウスオーバーを行います。

## テスト

```bash
npm test
```

Node.js のネイティブテストランナーを使用した 772 件のテスト。外部のテストフレームワークは使用していません。

## ライセンス

MIT — [LICENSE](LICENSE) を参照してください。

---

[MCP Tool Shop](https://mcp-tool-shop.github.io/) によって作成されました。
