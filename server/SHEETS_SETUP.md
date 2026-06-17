# Google スプレッドシート連携セットアップ手順

申し込みフォームの送信内容を、Google スプレッドシートに自動転記する設定手順です。

対象スプレッドシート:
https://docs.google.com/spreadsheets/d/1ndHRmqJIF0BErf4iPKHuaq9QiF2S3ulzWTiZIGscfhU/edit

## 全体像

```
[ブラウザ: apply.html]
   ↓ POST /api/apply
[Express サーバー (このフォルダ)]
   ↓ ① applications.json にローカル保存（バックアップ）
   ↓ ② Google Apps Script Web App に転送
[Apps Script]
   ↓ スプレッドシートに1行追記
[Google スプレッドシート]
```

ローカル JSON 保存（①）と Sheets 転送（②）は並行して行われます。Sheets 側で問題が起きてもローカル保存は確実に行われ、ユーザーへの応答も遅延しません。

---

## ステップ 1: Apps Script を作成

### 1-1. スプレッドシートを開く

[対象スプレッドシート](https://docs.google.com/spreadsheets/d/1ndHRmqJIF0BErf4iPKHuaq9QiF2S3ulzWTiZIGscfhU/edit) を開きます。

### 1-2. Apps Script エディタを開く

メニューから **拡張機能 → Apps Script** をクリックします。新しいタブで Apps Script エディタが開きます。

### 1-3. コードを貼り付け

エディタ画面に最初から `function myFunction() {}` などのテンプレートコードが表示されているはずです。これを全て削除し、`server/google-apps-script.gs` の内容を全てコピーして貼り付けます。

### 1-4. プロジェクト名を設定（任意）

画面上部の「無題のプロジェクト」をクリックして、`トリカエス申し込み受信` などに変更します（任意）。

### 1-5. 保存

`Ctrl + S`（Mac は `Cmd + S`）で保存します。

---

## ステップ 2: Web App としてデプロイ

### 2-1. デプロイダイアログを開く

エディタ右上の **デプロイ** ボタン → **新しいデプロイ** をクリックします。

### 2-2. 種類を選択

「種類を選択」の歯車アイコン ⚙ をクリックし、**ウェブアプリ** を選択します。

### 2-3. 設定

| 項目 | 値 |
|---|---|
| 説明 | `トリカエス申し込み受信 v1`（任意） |
| 実行ユーザー | **自分**（あなたのGoogleアカウント） |
| アクセスできるユーザー | **全員** |

> ⚠ 「全員」を選んでも、URL は推測困難な長いランダム文字列なので、URL を知る人だけがアクセス可能です。さらに堅牢にしたい場合は、Apps Script 側で共有シークレットの検証を追加できます（後述「セキュリティ強化（任意）」参照）。

### 2-4. デプロイ実行

**デプロイ** をクリックすると、初回のみアクセス権限の承認が求められます。

1. **アクセスを承認**
2. Google アカウントを選択
3. 「このアプリは Google で確認されていません」と警告が出たら **詳細** → **（プロジェクト名）に移動（安全ではないページ）** をクリック
4. 「アクセスを許可」をクリック

### 2-5. URL をコピー

デプロイ完了後、**ウェブアプリ URL** が表示されます:

```
https://script.google.com/macros/s/AKfycbxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/exec
```

このURLを **コピー** ボタンで複製してください。

---

## ステップ 3: サーバーに URL を設定

### 3-1. `.env` を編集

`server/.env` をテキストエディタで開きます。以下の行を見つけて URL を設定:

```
# 既存
ANTHROPIC_API_KEY=sk-ant-api03-...
PORT=3000
CORS_ORIGIN=*

# 追加（Apps Script のURL）
GOOGLE_SHEETS_WEBHOOK=https://script.google.com/macros/s/AKfycbxxxxxxxxxxxxxxxxxxx/exec
```

### 3-2. サーバー再起動

サーバーを起動中のターミナルで `Ctrl + C` で停止し、再起動:

```sh
cd C:\Users\kiyok\マイクロ訴訟サービス\server
npm start
```

起動ログに以下の行が追加されていることを確認:

```
Google Sheets:          連携有効
```

---

## ステップ 4: 動作確認

### 4-1. Apps Script から直接テスト

Apps Script エディタで、関数選択ドロップダウンから `testAppendRow` を選択し、▷ 実行ボタンをクリック。スプレッドシートに 1 行追加されれば Apps Script 側は正常です。

### 4-2. サーバー経由でテスト

サーバーが起動している状態で、別のターミナルから:

```sh
cd C:\Users\kiyok\マイクロ訴訟サービス\server
node -e "
fetch('http://localhost:3000/api/apply', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({
    email: 'test@example.com',
    name: 'サーバー経由テスト',
    preferredContact: 'email',
    diagnosisAnswers: { caseType: 'loan', amount: 400000 },
    diagnosisResult: { score: 75, verdict: '勝ち目あり', estimatedAmount: 290200 }
  })
}).then(r => r.json()).then(console.log);
"
```

スプレッドシートに行が追加され、サーバーのログに `Google Sheets forwarded:` が表示されれば成功です。

### 4-3. 実際のフロー

ブラウザで `index.html` → 診断 → 結果 → 「この内容で手続きを始める」 → フォーム入力 → 送信。
スプレッドシートに行が追加されれば、エンドツーエンドで動作しています。

---

## トラブルシューティング

### スプレッドシートに反映されない場合

1. サーバーログに `Google Sheets forwarding error:` が出ているか確認
2. `.env` の `GOOGLE_SHEETS_WEBHOOK` のスペルとURLを確認
3. URL を直接ブラウザで開き、`Service is running.` と表示されるか確認
4. Apps Script エディタで `testAppendRow` を実行して、Apps Script 単体で動くか確認

### Apps Script を更新したら反映されない

Apps Script のコードを変更した場合、**再デプロイが必要** です。

- **既存の URL を維持したい場合**: デプロイ → デプロイを管理 → 鉛筆アイコン（編集） → バージョンを「新しいバージョン」に変更 → デプロイ
- **新規 URL に変える場合**: デプロイ → 新しいデプロイ（URL が変わるので `.env` も更新）

### 「Google で確認されていません」警告

これは Apps Script の通常動作です。Google Cloud プロジェクトに紐付けて確認済みアプリにする方法もありますが、社内ツールとして使う分には警告を承諾してそのまま使って問題ありません。

---

## セキュリティ強化（任意）

URL のみで認証する現状は、URL が漏洩すると第三者が偽データを送信できます。本番運用前に共有シークレットを追加することを推奨。

### Apps Script 側に追加

```javascript
const SHARED_SECRET = 'your-random-secret-string-here';  // 32文字以上のランダム文字列

function doPost(e) {
  if (e.parameter.secret !== SHARED_SECRET) {
    return jsonResponse({ status: 'unauthorized' });
  }
  // ... 既存のロジック
}
```

### サーバー側 (.env) に追加

```
GOOGLE_SHEETS_SECRET=your-random-secret-string-here
```

### サーバー側（server.js）の forwardToGoogleSheets を修正

```javascript
const url = GOOGLE_SHEETS_WEBHOOK + (process.env.GOOGLE_SHEETS_SECRET
  ? '?secret=' + encodeURIComponent(process.env.GOOGLE_SHEETS_SECRET)
  : '');
const resp = await fetch(url, { ... });
```

---

## データの取り扱い

- スプレッドシートには、申し込み者の個人情報（氏名・メール・電話・診断内容）が記録されます
- スプレッドシートの **共有設定** を確認し、必要最小限の権限者のみに編集権を付与してください
- スプレッドシートのバックアップは Google が自動取得しますが、定期的なエクスポート（CSV ダウンロード）を推奨
- 個人情報保護法・プライバシーポリシーとの整合性を確認してください
