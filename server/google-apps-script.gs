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
 * --- 診断結果PDFのメール送付について ---
 * 申し込み受信時に、前ページの診断内容（薄いモザイクで隠していた詳細）をPDF化し、
 * EMAIL_TO（info@yz-partners.co.jp）へ自動送付します。
 * この機能は GmailApp（メール送信）の権限を使うため、スクリプトを更新して
 * 再デプロイ／関数を手動実行した際に表示される承認画面で「許可」してください（初回のみ）。
 * メール件名・本文・PDFファイル名すべてに受付番号を入れるため、
 * 「トリカエス_申し込み一覧」シートの受付番号列と突合できます。
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

// 診断結果PDFの送付先メールアドレス
const EMAIL_TO = 'info@yz-partners.co.jp';

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

    // 診断内容をPDF化し、受付番号つきでメール送付する。
    // 失敗してもシートへの記録と応答は維持する（受付自体は成功扱い）。
    try {
      sendDiagnosisPdf(data);
    } catch (mailErr) {
      console.error('診断PDFのメール送付に失敗:', mailErr);
    }

    return jsonResponse({ status: 'ok', referenceId: data.referenceId });
  } catch (err) {
    console.error('Apps Script error:', err);
    return jsonResponse({ status: 'error', message: String(err) });
  }
}

// ===== 診断結果のPDF生成＆メール送付 =====

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function yen(n) {
  if (typeof n !== 'number' || isNaN(n)) return '';
  return '¥' + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// 診断内容（前ページで薄いモザイクで隠していた詳細を含む）をHTMLとして組み立てる
function buildDiagnosisHtml(data) {
  var ans = data.diagnosisAnswers || {};
  var res = data.diagnosisResult || {};
  var p = [];

  p.push('<html><head><meta charset="utf-8"><style>');
  p.push('body{font-family:"Noto Sans JP",sans-serif;color:#16182C;font-size:12px;line-height:1.7;margin:24px;}');
  p.push('h1{font-size:20px;margin:0 0 4px;}');
  p.push('h2{font-size:14px;border-left:4px solid #0FB888;padding-left:8px;margin:20px 0 8px;}');
  p.push('.ref{font-size:13px;font-weight:bold;background:#16182C;color:#fff;display:inline-block;padding:4px 10px;border-radius:4px;margin:6px 0;}');
  p.push('.meta{color:#666;font-size:11px;}');
  p.push('table{border-collapse:collapse;width:100%;margin:4px 0;}');
  p.push('td,th{border:1px solid #ddd;padding:5px 8px;text-align:left;vertical-align:top;font-size:11px;}');
  p.push('th{background:#f3f3f0;width:30%;}');
  p.push('.score{font-size:20px;font-weight:bold;color:#0FB888;}');
  p.push('.verdict{font-size:15px;font-weight:bold;}');
  p.push('ul{margin:4px 0;padding-left:18px;}');
  p.push('.box{border:1px solid #ddd;border-radius:6px;padding:8px 10px;margin:6px 0;}');
  p.push('.label{font-weight:bold;color:#16182C;}');
  p.push('.hint{color:#666;font-size:10px;}');
  p.push('.example{white-space:pre-wrap;background:#fafafa;border:1px solid #eee;padding:6px;border-radius:4px;font-size:11px;}');
  p.push('.disclaimer{color:#888;font-size:10px;margin-top:18px;border-top:1px solid #ddd;padding-top:8px;}');
  p.push('</style></head><body>');

  p.push('<h1>トリカエス AI診断結果</h1>');
  p.push('<div class="ref">受付番号: ' + esc(data.referenceId) + '</div>');
  p.push('<div class="meta">受付日時: ' + esc(data.timestamp) + '</div>');

  p.push('<h2>お申込者情報</h2><table>');
  p.push('<tr><th>お名前</th><td>' + esc(data.name || '（未入力）') + '</td></tr>');
  p.push('<tr><th>メール</th><td>' + esc(data.email) + '</td></tr>');
  p.push('<tr><th>電話</th><td>' + esc(data.phone || '（未入力）') + '</td></tr>');
  p.push('<tr><th>希望連絡方法</th><td>' + esc(LABELS.preferredContact[data.preferredContact] || data.preferredContact || '') + '</td></tr>');
  if (data.notes) p.push('<tr><th>ご質問・ご要望</th><td>' + esc(data.notes) + '</td></tr>');
  p.push('</table>');

  p.push('<h2>ご入力内容</h2><table>');
  p.push('<tr><th>事件類型</th><td>' + esc(LABELS.caseType[ans.caseType] || ans.caseType || '') + '</td></tr>');
  p.push('<tr><th>請求金額</th><td>' + esc(typeof ans.amount === 'number' ? yen(ans.amount) : '') + '</td></tr>');
  p.push('<tr><th>経過期間</th><td>' + esc(LABELS.time[ans.time] || ans.time || '') + '</td></tr>');
  var evList = (ans.evidence || []).map(function (ev) { return LABELS.evidence[ev] || ev; }).join('、');
  p.push('<tr><th>保有証拠</th><td>' + esc(evList) + '</td></tr>');
  p.push('<tr><th>相手方情報</th><td>' + esc(LABELS.defendant[ans.defendant] || ans.defendant || '') + '</td></tr>');
  p.push('<tr><th>交渉履歴</th><td>' + esc(LABELS.communication[ans.communication] || ans.communication || '') + '</td></tr>');
  p.push('</table>');

  p.push('<h2>診断サマリ</h2>');
  p.push('<p class="verdict">判定: ' + esc(res.verdict || '') + '　<span class="score">' + esc(typeof res.score === 'number' ? res.score : '') + '点</span></p>');
  if (res.verdictDesc) p.push('<p>' + esc(res.verdictDesc) + '</p>');
  p.push('<table>');
  if (typeof res.winRate === 'number') p.push('<tr><th>推定勝率</th><td>' + Math.round(res.winRate * 100) + '%</td></tr>');
  if (typeof res.estimatedAmount === 'number') p.push('<tr><th>予想手取り額</th><td>' + esc(yen(res.estimatedAmount)) + '</td></tr>');
  if (res.legalBasis) p.push('<tr><th>適用法令・根拠</th><td>' + esc(res.legalBasis) + '</td></tr>');
  p.push('</table>');

  if (res.reasons && res.reasons.length) {
    p.push('<h2>AI判断の根拠</h2><ul>');
    res.reasons.forEach(function (r) { p.push('<li>' + esc(r.text) + '</li>'); });
    p.push('</ul>');
  }

  if (res.precedents && res.precedents.length) {
    p.push('<h2>類似の判例</h2>');
    res.precedents.forEach(function (pr) {
      p.push('<div class="box"><div class="label">' + esc(pr.title) + '</div>');
      p.push('<div class="meta">' + esc(pr.meta) + '</div>');
      p.push('<div>' + esc(pr.result) + '</div>');
      if (pr.caseNumber) p.push('<div class="meta">事件番号: ' + esc(pr.caseNumber) + '</div>');
      p.push('</div>');
    });
  }

  var court = res.courtGuidance;
  if (court) {
    p.push('<h2>提出先となる管轄の簡易裁判所</h2>');
    (court.candidates || []).forEach(function (c) {
      p.push('<div class="box"><div class="label">' + esc(c.name) + '</div><div class="meta">' + esc(c.basis) + '</div></div>');
    });
    if (court.explanation) p.push('<p>' + esc(court.explanation) + '</p>');
    if (court.verifyNote) p.push('<p class="meta">' + esc(court.verifyNote) + '</p>');
    p.push('<p class="meta">管轄区域の確認: https://www.courts.go.jp/saiban/tetuzuki/kankatu/index.html<br>');
    p.push('全国の裁判所所在地一覧: https://www.courts.go.jp/vc-files/courts/2024/databook2024/db2024_ex3.pdf</p>');
  }

  var cs = res.complaintSample;
  if (cs) {
    p.push('<h2>訴状の記入例</h2>');
    if (cs.recommendedForm) p.push('<p><span class="label">おすすめの訴状様式: </span>' + esc(cs.recommendedForm) + '</p>');
    if (cs.intro) p.push('<p>' + esc(cs.intro) + '</p>');
    (cs.fields || []).forEach(function (f) {
      p.push('<div class="box"><div class="label">' + esc(f.label) + '</div>');
      p.push('<div class="example">' + esc(f.example) + '</div>');
      if (f.hint) p.push('<div class="hint">記入のポイント: ' + esc(f.hint) + '</div>');
      p.push('</div>');
    });
    if (cs.note) p.push('<p class="meta">' + esc(cs.note) + '</p>');
    p.push('<p class="meta">訴状書式の入手: https://www.courts.go.jp/saiban/syosiki/syosiki_syogaku_sosyou/index.html</p>');
  }

  if (res.procedureSteps && res.procedureSteps.length) {
    p.push('<h2>申立てから回収までの流れ</h2>');
    res.procedureSteps.forEach(function (s) {
      p.push('<div class="box"><div class="label">' + esc(s.title) + '</div><div>' + esc(s.detail) + '</div></div>');
    });
  }

  var costs = res.costs;
  if (costs) {
    p.push('<h2>費用の目安</h2><table>');
    if (costs.stampFee) p.push('<tr><th>申立手数料（収入印紙）</th><td>' + esc(costs.stampFee) + '</td></tr>');
    if (costs.postage) p.push('<tr><th>予納郵便切手</th><td>' + esc(costs.postage) + '</td></tr>');
    p.push('</table>');
    if (costs.note) p.push('<p class="meta">' + esc(costs.note) + '</p>');
  }

  p.push('<div class="disclaimer">※ 本診断結果は、過去の判例傾向とご入力情報をもとにAIが算出・整理した一般的な参考情報であり、個別の法律相談・法的代理ではありません。実際の訴訟結果を保証するものではありません。</div>');
  p.push('</body></html>');
  return p.join('');
}

// 診断内容PDFを受付番号つきで EMAIL_TO へ送付する
function sendDiagnosisPdf(data) {
  var ref = data.referenceId || 'noref';
  var fileName = 'トリカエス診断_' + ref;
  var html = buildDiagnosisHtml(data);
  var pdf = Utilities.newBlob(html, 'text/html', fileName + '.html')
    .getAs('application/pdf')
    .setName(fileName + '.pdf');

  var ans = data.diagnosisAnswers || {};
  var amountText = (ans && typeof ans.amount === 'number') ? yen(ans.amount) : '';
  var subject = '【トリカエス】AI診断結果 受付番号 ' + ref;
  var body = [
    'トリカエスの利用申し込みを受け付けました。',
    '',
    '受付番号: ' + ref,
    '受付日時: ' + (data.timestamp || ''),
    'お名前: ' + (data.name || '（未入力）'),
    'メール: ' + (data.email || ''),
    '電話: ' + (data.phone || '（未入力）'),
    '希望連絡方法: ' + (LABELS.preferredContact[data.preferredContact] || data.preferredContact || ''),
    '事件類型: ' + (LABELS.caseType[ans.caseType] || ans.caseType || ''),
    '請求金額: ' + amountText,
    '',
    '※ 診断内容の詳細を添付PDF（' + fileName + '.pdf）にまとめています。',
    '※ 上記の受付番号は「トリカエス_申し込み一覧」スプレッドシートの受付番号列と突合できます。'
  ].join('\n');

  GmailApp.sendEmail(EMAIL_TO, subject, body, {
    name: 'トリカエス',
    attachments: [pdf]
  });
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

/**
 * メール送付だけを直接テストする関数（エラーを握りつぶさず、そのまま表示する）
 * エディタで「testSendEmail」を選び「実行」を押す。
 * 失敗した場合は実行ログに原因（エラー内容）がそのまま出る。
 */
function testSendEmail() {
  const data = {
    referenceId: 'app_emailtest',
    timestamp: new Date().toISOString(),
    name: 'テスト 太郎',
    email: 'test@example.com',
    phone: '090-1234-5678',
    preferredContact: 'email',
    notes: 'メール送付テスト',
    diagnosisAnswers: {
      caseType: 'loan', amount: 400000, time: '1-3y',
      evidence: ['message', 'receipt'], defendant: 'both', communication: 'repeated',
    },
    diagnosisResult: {
      score: 75, verdict: '勝ち目あり', verdictDesc: 'テスト用の判定説明です。',
      estimatedAmount: 290200, winRate: 0.75,
      legalBasis: '民法587条以下（消費貸借契約）',
      reasons: [{ type: 'pos', text: 'テスト根拠1' }, { type: 'neg', text: 'テスト根拠2' }],
      precedents: [{ meta: '類型上の傾向', title: 'テスト判例', result: 'テスト結果', caseNumber: '特定の公開判例番号なし（類型的傾向）' }],
      courtGuidance: { candidates: [{ name: 'お住まいの市区町村を管轄する簡易裁判所', basis: '義務履行地' }], explanation: 'テスト説明', verifyUrl: '', verifyNote: 'テスト確認' },
      complaintSample: { title: 'テスト訴状', intro: 'テスト導入', recommendedForm: '訴状（少額訴訟用・貸金）', fields: [{ label: '請求の趣旨', example: '金〇〇円を支払え', hint: 'テスト' }], note: 'テスト注記' },
      procedureSteps: [{ title: '1. テスト', detail: 'テスト手順' }],
      costs: { stampFee: '約3,000円', postage: '約4,000円', note: 'テスト' },
    },
  };
  sendDiagnosisPdf(data);
  console.log('sendDiagnosisPdf を実行しました。' + EMAIL_TO + ' の受信箱（迷惑メールも）をご確認ください。');
}
