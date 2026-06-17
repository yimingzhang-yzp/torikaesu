/**
 * トリカエス申し込みデータ受信スクリプト
 *
 * --- セットアップ手順 ---
 * 1. 対象スプレッドシートを開く:
 *    https://docs.google.com/spreadsheets/d/1ndHRmqJIF0BErf4iPKHuaq9QiF2S3ulzWTiZIGscfhU/edit
 * 2. メニュー: 拡張機能 → Apps Script
 * 3. このファイル全体（このコメント含む）を貼り付けて保存（Ctrl+S）
 * 4. デプロイ → 新しいデプロイ
 *      - 種類: 「ウェブアプリ」を選択
 *      - 説明: 任意
 *      - 実行ユーザー: 「自分」
 *      - アクセスできるユーザー: 「全員」（URLを知る人のみアクセス可能）
 * 5. 「デプロイ」→「アクセスを承認」→Googleアカウントを選択→「詳細」→「（プロジェクト名）に移動」→「許可」
 * 6. 表示されたURL（https://script.google.com/macros/s/AKfycb.../exec）をコピー
 * 7. サーバーの .env に GOOGLE_SHEETS_WEBHOOK= として貼り付けて保存
 * 8. サーバーを再起動
 *
 * --- 詳細手順は server/SHEETS_SETUP.md を参照 ---
 */

const HEADER_ROW = [
  '受付番号',
  '受付日時',
  '氏名',
  'メール',
  '電話',
  '希望連絡方法',
  'ご質問・ご要望',
  '事件類型',
  '請求金額',
  '経過期間',
  '保有証拠',
  '相手方情報',
  '交渉履歴',
  'AI診断スコア',
  'AI判定',
  '予想手取り額',
  '勝率',
  '適用法令',
  'IPアドレス',
  'UserAgent',
];

const LABELS = {
  caseType: {
    deposit: '敷金・保証金返還',
    freelance: '業務委託・フリーランス未払い',
    loan: '個人間貸付',
    online: 'ネット取引・フリマ',
    wage: '給与・残業代未払い',
    damage: '物品損害',
    other: 'その他',
  },
  time: {
    lt1y: '1年未満',
    '1-3y': '1〜3年',
    '3-5y': '3〜5年',
    '5-10y': '5〜10年',
    gt10y: '10年以上',
  },
  evidence: {
    contract: '契約書',
    message: 'メッセージ',
    receipt: '領収書・振込',
    photo: '写真・録音',
    witness: '証人',
    certmail: '内容証明',
    none: 'なし',
  },
  defendant: {
    both: '氏名+住所判明',
    company: '法人・店舗',
    name: '氏名のみ',
    neither: '不明',
  },
  communication: {
    admit: '相手自認',
    repeated: '繰り返し催促',
    once: '一度督促',
    none: '未請求',
    deny: '相手否認',
  },
  preferredContact: {
    email: 'メール',
    phone: '電話',
    either: 'どちらでも',
  },
};

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse({ status: 'error', message: 'No POST data' });
    }

    const data = JSON.parse(e.postData.contents);
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];

    // ヘッダー行がなければ作成
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(HEADER_ROW);
      const headerRange = sheet.getRange(1, 1, 1, HEADER_ROW.length);
      headerRange.setFontWeight('bold');
      headerRange.setBackground('#16182C');
      headerRange.setFontColor('#FBFAF6');
      sheet.setFrozenRows(1);

      // 列幅を自動調整しやすいよう、適当な初期幅を設定
      sheet.setColumnWidth(1, 140); // 受付番号
      sheet.setColumnWidth(2, 160); // 受付日時
      sheet.setColumnWidth(4, 220); // メール
      sheet.setColumnWidth(7, 280); // 備考
    }

    const ans = data.diagnosisAnswers || {};
    const res = data.diagnosisResult || {};

    const evList = (ans.evidence || [])
      .map(function (ev) { return LABELS.evidence[ev] || ev; })
      .join('、');

    const row = [
      data.referenceId || '',
      data.timestamp ? new Date(data.timestamp) : new Date(),
      data.name || '',
      data.email || '',
      data.phone || '',
      LABELS.preferredContact[data.preferredContact] || data.preferredContact || '',
      data.notes || '',
      LABELS.caseType[ans.caseType] || ans.caseType || '',
      typeof ans.amount === 'number' ? ans.amount : '',
      LABELS.time[ans.time] || ans.time || '',
      evList,
      LABELS.defendant[ans.defendant] || ans.defendant || '',
      LABELS.communication[ans.communication] || ans.communication || '',
      typeof res.score === 'number' ? res.score : '',
      res.verdict || '',
      typeof res.estimatedAmount === 'number' ? res.estimatedAmount : '',
      typeof res.winRate === 'number' ? res.winRate : '',
      res.legalBasis || '',
      data.ip || '',
      data.userAgent || '',
    ];

    sheet.appendRow(row);

    return jsonResponse({ status: 'ok', referenceId: data.referenceId });
  } catch (err) {
    console.error('Apps Script error:', err);
    return jsonResponse({ status: 'error', message: String(err) });
  }
}

function doGet() {
  return ContentService
    .createTextOutput('Service is running. POST申し込みデータを受信します。')
    .setMimeType(ContentService.MimeType.TEXT);
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * 動作確認用テスト関数（Apps Scriptエディタから手動実行）
 * 実行前にこの関数を選択してから「実行」ボタンを押す
 */
function testAppendRow() {
  const mockEvent = {
    postData: {
      contents: JSON.stringify({
        referenceId: 'app_test123',
        timestamp: new Date().toISOString(),
        name: 'テスト 太郎',
        email: 'test@example.com',
        phone: '090-1234-5678',
        preferredContact: 'email',
        notes: 'Apps Scriptテスト用エントリ',
        diagnosisAnswers: {
          caseType: 'loan',
          amount: 400000,
          time: '1-3y',
          evidence: ['message', 'receipt'],
          defendant: 'both',
          communication: 'repeated',
        },
        diagnosisResult: {
          score: 75,
          verdict: '勝ち目あり',
          estimatedAmount: 290200,
          winRate: 0.75,
          legalBasis: '民法587条以下（消費貸借契約）',
        },
        ip: '127.0.0.1',
        userAgent: 'AppsScript-Test',
      }),
    },
  };
  const result = doPost(mockEvent);
  console.log(result.getContent());
}
