# トリカエス AI診断バックエンド

Claude API を使った少額訴訟の AI 診断サービス。判例知識と法令に基づいて、勝訴可能性・回収見込みを判定します。

## アーキテクチャ

```
[ブラウザ: diagnose.html] --POST /api/diagnose--> [Express server] --Anthropic SDK--> [Claude Opus 4.7]
                                                       ↑
                                              構造化出力 (JSON Schema)
                                              プロンプトキャッシング
                                              適応的思考 (adaptive thinking)
```

- **モデル**: `claude-opus-4-7`（最新最高性能。法務推論に最適）
- **思考**: `adaptive`（複雑度に応じて思考量を自動調整）
- **エフォート**: `high`（精度重視）
- **構造化出力**: JSON Schema による厳密な型付け
- **プロンプトキャッシング**: システムプロンプトは自動キャッシュされ、2回目以降の API コストが約 1/10 に

## セットアップ

### 1. Node.js のインストール

Node.js 20 以上が必要です。https://nodejs.org/ からダウンロードしてください。

確認:
```sh
node --version  # v20.x.x 以上
```

### 2. 依存パッケージのインストール

```sh
cd server
npm install
```

### 3. API キーの設定

`.env.example` をコピーして `.env` を作成：

```sh
cp .env.example .env
```

`.env` を開いて、Anthropic Console (https://console.anthropic.com/) で取得した API キーを設定：

```
ANTHROPIC_API_KEY=sk-ant-api03-xxxxxxxxxx...
PORT=3000
CORS_ORIGIN=*
```

### 4. サーバー起動

```sh
npm start
```

開発時（ファイル変更で自動再起動）:
```sh
npm run dev
```

出力例:
```
トリカエスAI診断API起動: http://localhost:3000
Health check:           GET  /api/health
Diagnose endpoint:      POST /api/diagnose
Model:                  claude-opus-4-7 (adaptive thinking, effort=high)
```

### 5. フロントエンドとの接続

`diagnose.js` 冒頭の `API_ENDPOINT` を確認します：

```javascript
const API_ENDPOINT = 'http://localhost:3000/api/diagnose';  // ローカル開発時
// 本番デプロイ時は同一オリジンの '/api/diagnose' などに変更
```

ブラウザで `index.html` を開き、診断を実行してください。バックエンドが応答していれば、結果ページに「AI診断モード」のバッジが表示されます。

## API 仕様

### `POST /api/diagnose`

**リクエストボディ:**
```json
{
  "caseType": "loan",
  "amount": 400000,
  "time": "1-3y",
  "evidence": ["message", "receipt"],
  "defendant": "both",
  "communication": "repeated"
}
```

**有効な値:**

| フィールド | 値 |
|---|---|
| `caseType` | `deposit`, `freelance`, `loan`, `online`, `wage`, `damage`, `other` |
| `amount` | 1 〜 100,000,000 の整数（円） |
| `time` | `lt1y`, `1-3y`, `3-5y`, `5-10y`, `gt10y` |
| `evidence` | 配列。要素は `contract`, `message`, `receipt`, `photo`, `witness`, `certmail`, `none` |
| `defendant` | `both`, `company`, `name`, `neither` |
| `communication` | `admit`, `repeated`, `once`, `none`, `deny` |

**レスポンス（200）:**
```json
{
  "score": 78,
  "verdict": "勝ち目あり",
  "verdictDesc": "...",
  "winRate": 0.72,
  "estimatedAmount": 278200,
  "reasons": [
    {"type": "pos", "text": "..."}
  ],
  "precedents": [
    {"meta": "...", "title": "...", "result": "..."}
  ],
  "outOfScope": false,
  "outOfScopeReason": null,
  "legalBasis": "民法587条以下（消費貸借契約）、改正民法166条（消滅時効）",
  "_meta": {
    "model": "claude-opus-4-7",
    "elapsedMs": 8234,
    "source": "ai"
  }
}
```

**エラーレスポンス:**
- `400 invalid_input`: 入力検証エラー
- `429 rate_limit`: IP 単位のレート制限超過（1分10回まで）
- `429 upstream_rate_limit`: Anthropic API のレート制限
- `422 refusal`: AI が診断を拒否
- `500 no_api_key` / `auth_error`: サーバー設定エラー
- `502 upstream_error`: Anthropic API との通信エラー

### `GET /api/health`

ヘルスチェック。フロントエンドの接続確認に使用します。

## コスト見積もり

Claude Opus 4.7 価格（2026年6月時点）:
- 入力: $5/1M トークン
- 出力: $25/1M トークン
- キャッシュ読込み: $0.50/1M トークン（約 1/10）

1回の診断あたり:
- システムプロンプト（キャッシュ後）: 約 2,000 トークン × $0.50 = $0.001
- ユーザーメッセージ（毎回）: 約 200 トークン × $5 = $0.001
- 出力: 約 1,500〜2,500 トークン × $25 = $0.04〜0.06
- **合計: 1 件あたり約 $0.04〜0.06（約 6〜9 円）**

無料診断として提供する場合、月間 1,000 件で約 6,000〜9,000 円の API コスト。

コストを抑えたい場合の選択肢：
- `model` を `claude-sonnet-4-6` に変更（コスト約 1/3、精度はやや低下）
- `effort` を `medium` に下げる
- レート制限を強化

## デプロイ

### Vercel / Netlify（サーバーレス）

`/api/diagnose.js` をプロジェクトルートに置けばそのまま動きます。Express を使わず Vercel Functions の handler 形式に書き換える必要があります。詳しくは:
- https://vercel.com/docs/functions
- https://docs.netlify.com/functions/overview/

### VPS / 自前サーバー

`pm2` などのプロセスマネージャを使うのが推奨：

```sh
npm install -g pm2
pm2 start server.js --name torikaesu-api
pm2 save
pm2 startup
```

Nginx などのリバースプロキシで HTTPS 化し、`/api/diagnose` を `localhost:3000` にプロキシしてください。

### 環境変数（本番）

| 変数 | 説明 |
|---|---|
| `ANTHROPIC_API_KEY` | 必須。Anthropic API キー |
| `PORT` | サーバーポート（デフォルト 3000） |
| `CORS_ORIGIN` | 許可するオリジン。本番では具体的なドメインを指定（例: `https://torikaesu.example.com`） |

## セキュリティ・本番運用の TODO

現在の実装は基本機能のみ。本番運用時に追加すべき項目：

- [ ] API キーの環境変数管理（AWS Secrets Manager / GCP Secret Manager など）
- [ ] レート制限を Redis ベースに（複数インスタンス対応）
- [ ] アクセスログ・監査ログの永続化
- [ ] 入力内容の機密性に応じた暗号化保存
- [ ] CORS を厳密に制限
- [ ] HTTPS 必須化
- [ ] 入力内容の長さ・形式の追加検証
- [ ] AbuseIPDB 等による悪質 IP のブロック
- [ ] エラーモニタリング（Sentry など）
- [ ] 利用統計の集計（コスト管理）

## 法務監修について

このサービスが扱う内容は法務領域です。本番運用前に弁護士・司法書士による以下のレビューを推奨：

1. システムプロンプトの法的記述の正確性
2. 「弁護士法第72条」への抵触リスクの再確認
3. 免責表示の妥当性
4. 個人情報保護法・特定商取引法対応
