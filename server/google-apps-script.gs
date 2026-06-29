/**
 * トリカエス（toB：弁護士事務所向け 訴状作成サービス）データ受信スクリプト
 *
 * --- セットアップ手順 ---
 * 1. 対象スプレッドシート（トリカエス_申し込み一覧）を開く → 拡張機能 → Apps Script
 * 2. このファイル全体を貼り付けて保存（Ctrl+S）
 * 3. デプロイ → 新しいデプロイ（または「デプロイを管理」で新バージョン）
 *      - 種類: ウェブアプリ／実行ユーザー: 自分／アクセス: 全員
 * 4. 初回は承認画面で「許可」。Gmail送信・Googleドキュメント作成・Drive の権限が必要。
 * 5. 表示された /exec URL を Vercel の GOOGLE_SHEETS_WEBHOOK に設定（既存と同じでよい）。
 *
 * --- 管理画面（admin）連携 ---
 * doGet(action=list, token=...) で案件一覧を返す。token は Script Property の
 * ADMIN_SHARED_TOKEN と照合する。設定方法:
 *   プロジェクトの設定（歯車）→ スクリプト プロパティ → ADMIN_SHARED_TOKEN を追加
 *   （Vercel の ADMIN_SHARED_TOKEN と同じ値にする）
 *
 * --- 動作 ---
 *  - action=appendIntake   : ヒアリング＋連絡先を1行追加（ステータス=訴状生成中）
 *  - action=attachComplaint: 受付番号で行を検索し、生成された訴状を紐付け。
 *                            Googleドキュメント（編集可＝Word/PDF出力可）を作成しURLを記録。
 *                            訴状PDFを EMAIL_TO へメール送付（件名・本文に受付番号）。
 */

const EMAIL_TO = 'info@yz-partners.co.jp';

const HEADER_ROW = [
  '受付番号', '受付日時', 'ステータス', '氏名', 'メール', '電話', '希望連絡方法',
  '事件類型', '請求金額', '原告氏名', '被告氏名',
  '訴状様式', '訴状DocのURL', '要確認事項', 'ヒアリング詳細(JSON)', '訴状全文',
  'IPアドレス', 'UserAgent',
];
// 列番号（1始まり）
const COL = {
  ref: 1, ts: 2, status: 3, name: 4, email: 5, phone: 6, contact: 7,
  caseType: 8, amount: 9, plaintiff: 10, defendant: 11,
  formType: 12, docUrl: 13, reviewNotes: 14, hearingJson: 15, complaintText: 16,
  ip: 17, ua: 18,
};

const LABELS = {
  caseType: {
    deposit: '敷金・保証金返還', freelance: '業務委託・フリーランス未払い', loan: '個人間貸付',
    online: 'ネット取引・フリマ', wage: '給与・残業代未払い', damage: '物品損害', other: 'その他',
  },
  preferredContact: { email: 'メール', phone: '電話', either: 'どちらでも' },
};

// ============ ルーティング ============
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse({ status: 'error', message: 'No POST data' });
    }
    const data = JSON.parse(e.postData.contents);
    const action = data.action || 'appendIntake';

    if (action === 'appendIntake') return handleAppendIntake(data);
    if (action === 'attachComplaint') return handleAttachComplaint(data);
    return jsonResponse({ status: 'error', message: 'Unknown action: ' + action });
  } catch (err) {
    console.error('doPost error:', err);
    return jsonResponse({ status: 'error', message: String(err) });
  }
}

function getSheet() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADER_ROW);
    const h = sheet.getRange(1, 1, 1, HEADER_ROW.length);
    h.setFontWeight('bold'); h.setBackground('#16182C'); h.setFontColor('#FBFAF6');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(COL.ref, 140); sheet.setColumnWidth(COL.ts, 150);
    sheet.setColumnWidth(COL.email, 220); sheet.setColumnWidth(COL.docUrl, 240);
    sheet.setColumnWidth(COL.complaintText, 320);
  }
  return sheet;
}

// ============ ヒアリング受付（行追加） ============
function handleAppendIntake(data) {
  const sheet = getSheet();
  const ans = data.diagnosisAnswers || {};
  const plaintiffName = (ans.plaintiff && ans.plaintiff.name) || '';
  const defendantName = (ans.defendantInfo && ans.defendantInfo.name) || '';

  const row = [];
  row[COL.ref - 1] = data.referenceId || '';
  row[COL.ts - 1] = data.timestamp ? new Date(data.timestamp) : new Date();
  row[COL.status - 1] = data.status || '訴状生成中';
  row[COL.name - 1] = data.name || '';
  row[COL.email - 1] = data.email || '';
  row[COL.phone - 1] = data.phone || '';
  row[COL.contact - 1] = LABELS.preferredContact[data.preferredContact] || data.preferredContact || '';
  row[COL.caseType - 1] = LABELS.caseType[ans.caseType] || ans.caseType || '';
  row[COL.amount - 1] = typeof ans.amount === 'number' ? ans.amount : '';
  row[COL.plaintiff - 1] = plaintiffName;
  row[COL.defendant - 1] = defendantName;
  row[COL.formType - 1] = '';
  row[COL.docUrl - 1] = '';
  row[COL.reviewNotes - 1] = '';
  row[COL.hearingJson - 1] = JSON.stringify(ans);
  row[COL.complaintText - 1] = '';
  row[COL.ip - 1] = data.ip || '';
  row[COL.ua - 1] = data.userAgent || '';
  for (var i = 0; i < HEADER_ROW.length; i++) if (row[i] === undefined) row[i] = '';

  sheet.appendRow(row);
  return jsonResponse({ status: 'ok', referenceId: data.referenceId });
}

// ============ 訴状の紐付け（行更新＋Doc作成＋メール） ============
function handleAttachComplaint(data) {
  const sheet = getSheet();
  const ref = data.referenceId;
  const c = data.complaint || {};
  const rowIdx = findRowByRef(sheet, ref);
  if (rowIdx < 0) return jsonResponse({ status: 'error', message: '受付番号が見つかりません: ' + ref });

  // Googleドキュメントを作成（編集可＝Word/PDF出力可能）
  var docUrl = '';
  try { docUrl = createComplaintDoc(ref, c); } catch (docErr) { console.error('Doc作成失敗:', docErr); }

  sheet.getRange(rowIdx, COL.status).setValue('作成済み');
  sheet.getRange(rowIdx, COL.formType).setValue(c.formType || '');
  sheet.getRange(rowIdx, COL.docUrl).setValue(docUrl);
  sheet.getRange(rowIdx, COL.reviewNotes).setValue((c.reviewNotes || []).join('\n'));
  sheet.getRange(rowIdx, COL.complaintText).setValue(c.fullComplaintText || '');

  // 訴状PDFをメール送付（受付番号つき）。失敗しても紐付けは成立。
  try { sendComplaintEmail(ref, c, docUrl); } catch (mailErr) { console.error('訴状メール送付失敗:', mailErr); }

  return jsonResponse({ status: 'ok', referenceId: ref, docUrl: docUrl });
}

function findRowByRef(sheet, ref) {
  const last = sheet.getLastRow();
  if (last < 2) return -1;
  const vals = sheet.getRange(2, COL.ref, last - 1, 1).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0]) === String(ref)) return i + 2;
  }
  return -1;
}

function createComplaintDoc(ref, c) {
  const doc = DocumentApp.create('訴状_' + ref);
  const body = doc.getBody();
  body.setText(c.fullComplaintText || '（訴状本文が空です）');
  if (c.reviewNotes && c.reviewNotes.length) {
    body.appendParagraph('');
    body.appendParagraph('────────────');
    body.appendParagraph('【弁護士確認用メモ（提出前に削除してください）】').setBold(true);
    c.reviewNotes.forEach(function (n) { body.appendListItem(n); });
  }
  doc.saveAndClose();
  return DriveApp.getFileById(doc.getId()).getUrl();
}

function sendComplaintEmail(ref, c, docUrl) {
  const fileName = '訴状_' + ref;
  const lines = [
    '訴状ドラフトが作成されました（受付番号: ' + ref + '）。',
    '',
    '事件名: ' + (c.caseName || ''),
    '訴状様式: ' + (c.formType || ''),
    '管轄裁判所（候補）: ' + (c.courtName || ''),
    '編集用Googleドキュメント: ' + (docUrl || '（作成失敗）'),
    '',
    '【弁護士確認事項】',
  ];
  (c.reviewNotes || []).forEach(function (n) { lines.push('・' + n); });
  lines.push('');
  lines.push('────────── 訴状全文 ──────────');
  lines.push(c.fullComplaintText || '');
  lines.push('');
  lines.push('※ 受付番号は「トリカエス_申し込み一覧」シートと突合できます。これはAIによるドラフトです。弁護士のレビュー・修正・提出が前提です。');

  const opts = { name: 'トリカエス' };
  // Doc から PDF を生成して添付（可能な場合）
  try {
    if (docUrl) {
      var id = docUrl.match(/[-\w]{25,}/);
      if (id) {
        var pdf = DriveApp.getFileById(id[0]).getAs('application/pdf').setName(fileName + '.pdf');
        opts.attachments = [pdf];
      }
    }
  } catch (e) { console.warn('PDF添付失敗:', e); }

  GmailApp.sendEmail(EMAIL_TO, '【トリカエス】訴状ドラフト作成 受付番号 ' + ref, lines.join('\n'), opts);
}

// ============ 管理画面用：一覧取得 ============
function doGet(e) {
  const params = (e && e.parameter) || {};
  if (params.action === 'list') {
    const token = PropertiesService.getScriptProperties().getProperty('ADMIN_SHARED_TOKEN');
    if (!token || params.token !== token) {
      return jsonResponse({ status: 'error', message: 'unauthorized' });
    }
    return jsonResponse({ status: 'ok', items: listAll() });
  }
  return ContentService.createTextOutput('Service is running.').setMimeType(ContentService.MimeType.TEXT);
}

function listAll() {
  const sheet = getSheet();
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const data = sheet.getRange(2, 1, last - 1, HEADER_ROW.length).getValues();
  const out = [];
  for (var i = 0; i < data.length; i++) {
    const r = data[i];
    out.push({
      referenceId: r[COL.ref - 1], timestamp: r[COL.ts - 1], status: r[COL.status - 1],
      name: r[COL.name - 1], email: r[COL.email - 1], phone: r[COL.phone - 1], contact: r[COL.contact - 1],
      caseType: r[COL.caseType - 1], amount: r[COL.amount - 1],
      plaintiff: r[COL.plaintiff - 1], defendant: r[COL.defendant - 1],
      formType: r[COL.formType - 1], docUrl: r[COL.docUrl - 1],
      reviewNotes: r[COL.reviewNotes - 1], complaintText: r[COL.complaintText - 1],
      hearingJson: r[COL.hearingJson - 1],
    });
  }
  out.reverse(); // 新しい順
  return out;
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ============ 動作確認用テスト ============
function testFlow() {
  var ref = 'app_test' + Math.floor(Date.now() / 1000);
  handleAppendIntake({
    referenceId: ref, timestamp: new Date().toISOString(), name: 'テスト太郎',
    email: 'test@example.com', phone: '090-0000-0000', preferredContact: 'email',
    diagnosisAnswers: { caseType: 'loan', amount: 300000, plaintiff: { name: '山田太郎' }, defendantInfo: { name: '佐藤次郎' } },
  });
  handleAttachComplaint({
    referenceId: ref,
    complaint: {
      formType: '訴状（少額訴訟用・貸金）', caseName: '貸金返還請求事件', courtName: '東京簡易裁判所',
      reviewNotes: ['本年の少額訴訟利用回数を確認'],
      fullComplaintText: '訴状\n\n原告 山田太郎\n被告 佐藤次郎\n\n請求の趣旨\n1 被告は原告に対し金300,000円を支払え。\n...',
    },
  });
  console.log('testFlow 完了: ' + ref + ' / ' + EMAIL_TO + ' にメールが届くか、シートに行が追加されたかを確認');
}
