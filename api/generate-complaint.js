// Vercel サーバーレス関数: POST /api/generate-complaint
// ヒアリング内容から、少額訴訟の訴状ドラフト（実データ入り）をAIで生成し、
// 生成結果を Google Apps Script（attachComplaint）へ送って案件行に紐付ける。
// 弁護士事務所がレビュー・提出する前提（toB）。
//
// 必要な環境変数: ANTHROPIC_API_KEY, GOOGLE_SHEETS_WEBHOOK
// 呼び出し元: 相談者の送信後にブラウザが裏で起動 ／ 管理画面の「再生成」
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();
const GOOGLE_SHEETS_WEBHOOK = (process.env.GOOGLE_SHEETS_WEBHOOK || "").trim();

// 裁判所公式の少額訴訟用 訴状様式（10種）
const COURT_FORMS = [
  "訴状（少額訴訟用・交通事故による物損・人損）",
  "訴状（少額訴訟用・貸金）",
  "訴状（少額訴訟用・売買代金）",
  "訴状（少額訴訟用・請負代金）",
  "訴状（少額訴訟用・売掛代金）",
  "訴状（少額訴訟用・賃料）",
  "訴状（少額訴訟用・マンション管理費）",
  "訴状（少額訴訟用・敷金返還）",
  "訴状（少額訴訟用・原状回復費用）",
  "訴状（少額訴訟用・汎用）",
];

const CASE_TYPE_LABELS = {
  loan: "個人間の金銭貸借（消費貸借）", deposit: "敷金・保証金の返還", freelance: "業務委託・フリーランス報酬",
  online: "ネット取引・フリマ取引", wage: "給与・残業代の未払い", damage: "物品の損害・破損賠償", other: "その他の金銭請求",
};
const TIME_LABELS = { lt1y: "1年未満", "1-3y": "1〜3年", "3-5y": "3〜5年", "5-10y": "5〜10年", gt10y: "10年以上前" };
const EVIDENCE_LABELS = { contract: "契約書・合意書・借用書", message: "メール・LINE・SMS等", receipt: "領収書・振込明細・銀行履歴", photo: "写真・録音・録画", witness: "第三者の証言", certmail: "内容証明郵便の送付実績", none: "客観的証拠なし" };
const ASSET_LABELS = { salary: "勤務先が判明（給与差押え）", bank: "取引銀行・口座が判明（預金差押え）", realestate: "不動産あり", business: "事業・店舗あり", vehicle: "自動車等の資産あり", unknown: "資産状況不明" };
const COMM_LABELS = { admit: "相手が支払い義務を認めている", repeated: "繰り返し催促したが応じない", once: "一度督促したが反応なし", none: "まだ請求していない", deny: "請求自体を拒否・否定" };

// 回答キー → 表示ラベル
const KEY_LABELS = {
  amount: "請求金額（元金）", amountBreakdown: "請求金額の内訳・算定根拠", timeline: "事実経過（時系列）",
  priorClaims: "これまでの請求・督促", time: "債権発生からの経過期間", communication: "相手方の対応",
  // loan
  loan_handoverDate: "交付日", loan_method: "交付方法", loan_purpose: "資金の交付目的", loan_dueDate: "返済期日の約定",
  loan_interest: "利息の約定", loan_iou: "借用書・契約書", loan_partial: "一部返済",
  // deposit
  dep_contractDate: "賃貸借契約日", dep_amount: "敷金・保証金額", dep_moveout: "退去日", dep_disputes: "原状回復で争いのある項目", dep_special: "特約",
  // freelance
  fl_contractDate: "契約日", fl_work: "業務内容", fl_fee: "報酬額", fl_delivery: "納品・検収", fl_doc: "契約書・発注書",
  // online
  on_date: "取引日", on_platform: "プラットフォーム", on_item: "商品・サービス", on_price: "代金", on_issue: "不履行の内容",
  // wage
  wg_period: "雇用期間", wg_unpaid: "未払い対象期間", wg_base: "基礎賃金", wg_record: "労働時間の記録", wg_type: "契約形態",
  // damage
  dm_when: "加害日時", dm_where: "加害場所", dm_how: "加害行為の態様", dm_loss: "損害の内容と算定根拠",
  // other
  ot_basis: "請求の法的根拠・経緯",
};

function fmtYen(n) { return "¥" + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ","); }

function buildUserMessage(a) {
  a = a || {};
  const lines = [];
  lines.push("【事件類型】" + (CASE_TYPE_LABELS[a.caseType] || a.caseType || "不明"));
  if (typeof a.amount === "number") lines.push("【請求金額（元金）】" + fmtYen(a.amount) + (a.amount > 600000 ? "（※60万円超：少額訴訟の対象外。通常訴訟を前提に案内）" : ""));

  // 原告
  if (a.plaintiff) lines.push("【原告（申立人）】氏名: " + (a.plaintiff.name || "【要確認】") + " ／ 住所: " + (a.plaintiff.address || "【要確認】") + " ／ 電話: " + (a.plaintiff.phone || "未入力"));
  // 被告
  if (a.defendantInfo) {
    const d = a.defendantInfo;
    lines.push("【被告（相手方）】区分: " + (d.kind || "不明") + " ／ 氏名・商号: " + (d.name || "【要確認】") + (d.rep ? " ／ 代表者: " + d.rep : "") + " ／ 住所: " + (d.address || "【要確認】"));
  }
  // 遅延損害金
  if (a.delayDamages) lines.push("【遅延損害金】利率: " + (a.delayDamages.rate || "未指定") + (a.delayDamages.startDate ? " ／ 起算日の希望: " + a.delayDamages.startDate : ""));
  // 管轄は原告・被告の住所（不法行為は加害場所）から判断する
  lines.push("【管轄の判断材料】上記の原告・被告の住所（物品損害など不法行為の場合は加害があった場所）から、提出先の簡易裁判所を判断してください。");
  // 証拠
  if (Array.isArray(a.evidence)) lines.push("【保有する証拠】" + (a.evidence.map((e) => EVIDENCE_LABELS[e] || e).join("、") || "なし"));
  // 資産
  if (Array.isArray(a.counterpartyAssets)) lines.push("【相手方の資産状況】" + (a.counterpartyAssets.map((e) => ASSET_LABELS[e] || e).join("、") || "不明"));
  if (a.communication) lines.push("【相手方の対応】" + (COMM_LABELS[a.communication] || a.communication));
  if (a.time) lines.push("【経過期間】" + (TIME_LABELS[a.time] || a.time));

  // その他のキー（内訳・経緯・類型別項目など）
  const skip = { caseType: 1, amount: 1, plaintiff: 1, defendantInfo: 1, delayDamages: 1, location: 1, evidence: 1, counterpartyAssets: 1, communication: 1, time: 1 };
  Object.keys(a).forEach(function (k) {
    if (skip[k]) return;
    const v = a[k];
    if (v === null || v === undefined || v === "") return;
    const label = KEY_LABELS[k] || k;
    if (typeof v === "object") {
      lines.push("【" + label + "】" + JSON.stringify(v));
    } else {
      lines.push("【" + label + "】" + v);
    }
  });

  return "以下のヒアリング情報をもとに、日本の少額訴訟（簡易裁判所・60万円以下）の訴状ドラフトを、指定のJSONスキーマに厳密に従って作成してください。提供された実際の氏名・金額・日付をそのまま用いて構いません（弁護士がレビュー・提出します）。情報が不足・不明な箇所は推測で埋めず、文中に「【要確認：…】」と明示し、reviewNotes に列挙してください。\n\n" + lines.join("\n") + "\n\nJSONを出力してください。";
}

const SYSTEM_PROMPT = `あなたは、日本の少額訴訟（民事訴訟法第368条以下、簡易裁判所での60万円以下の金銭請求）の実務に精通した法務AIアシスタントです。弁護士事務所が運営するサービスの一部として、提供されたヒアリング情報から**訴状のドラフト**を作成します。最終的なレビュー・修正・提出は弁護士が行い、責任を負います。

# 役割と方針
- 提供された当事者の実名・住所・金額・日付などの**実データをそのまま用いて、提出可能な水準に近い訴状ドラフトを作成**してください（toC向けの「架空例にとどめる」制約は適用しません）。
- 情報が不足・不明・曖昧な箇所は、**推測や創作で埋めてはいけません**。本文中に「【要確認：(必要な情報)】」と明記し、reviewNotes にも具体的に列挙してください（弁護士が補完します）。
- 事件類型に応じて、裁判所公式の少額訴訟用訴状様式（次の10種類）から最適な1つを formType に選んでください。専用様式がない類型（給与・残業代等）は「訴状（少額訴訟用・汎用）」を選びます。
  ${COURT_FORMS.join(" / ")}
- 訴状の構成（fullComplaintText）は、次の項目を含む体裁で作成してください：表題（訴状）、提出先簡易裁判所名、作成年月日、原告・被告の表示（住所・氏名）、事件名、訴訟物の価額・貼用印紙額（分かる範囲、不明は【要確認】）、請求の趣旨、請求の原因（時系列の事実と法的根拠）、添付書類、少額訴訟による審理及び裁判を求める旨と本年の利用回数（不明なら【要確認：本年の少額訴訟利用回数】）。
- 請求の趣旨では、遅延損害金の利率・起算日の希望を反映してください（指定がなければ年3%（法定利率）を用い、reviewNotesに明記）。
- 60万円を超える場合は、少額訴訟の対象外である旨を reviewNotes と本文の冒頭注記に明示し、通常訴訟を前提とした訴状として作成してください。
- 管轄の簡易裁判所（courtName）は、金銭請求が原則持参債務であること（民訴5条1号・民法484条：債権者の住所地にも提起可）等の考え方に基づき候補を示し、断定できない場合は「お住まいの市区町村を管轄する簡易裁判所」と表現し reviewNotes で公式サイト確認を促してください。実在しない裁判所名を創作しないこと。

# 厳守事項
1. 事実・数値・固有名詞の捏造禁止。提供データにないものは【要確認】とする。
2. 法令・条文は正確に。判例の事件番号を創作しない。
3. 出力は指定JSONスキーマに厳密準拠（フィールドの過不足・型誤りを禁止）。
4. 本文は日本語の丁寧な書面体で、裁判所提出を想定した体裁にする。
5. これはドラフトであり、最終確認・提出責任は弁護士にある旨を前提に作成する。`;

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    formType: { type: "string", enum: COURT_FORMS },
    formReason: { type: "string" },
    courtName: { type: "string" },
    courtBasis: { type: "string" },
    caseName: { type: "string" },
    plaintiff: { type: "string" },
    defendant: { type: "string" },
    claimStatement: { type: "string" },
    claimCause: { type: "string" },
    evidenceList: { type: "array", items: { type: "string" } },
    suitMatter: { type: "string" },
    reviewNotes: { type: "array", items: { type: "string" } },
    fullComplaintText: { type: "string" },
  },
  required: ["formType", "formReason", "courtName", "courtBasis", "caseName", "plaintiff", "defendant", "claimStatement", "claimCause", "evidenceList", "suitMatter", "reviewNotes", "fullComplaintText"],
  additionalProperties: false,
};

async function forwardToGoogleSheets(payload) {
  if (!GOOGLE_SHEETS_WEBHOOK) return false;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12000);
  try {
    const resp = await fetch(GOOGLE_SHEETS_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!resp.ok) { console.warn(`Sheets attachComplaint failed: HTTP ${resp.status}`); return false; }
    let body; try { body = await resp.json(); } catch (_) { body = null; }
    return !!(body && body.status === "ok");
  } catch (err) {
    clearTimeout(timeoutId);
    console.warn(`Sheets attachComplaint error: ${err.message}`);
    return false;
  }
}

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed", message: "POSTのみ対応しています。" });
  }
  const { referenceId, diagnosisAnswers } = req.body || {};
  if (!referenceId || !diagnosisAnswers) {
    return res.status(400).json({ error: "invalid_input", message: "referenceId と diagnosisAnswers が必要です。" });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "no_api_key", message: "サーバー側でAPI設定が完了していません。" });
  }

  try {
    const userMessage = buildUserMessage(diagnosisAnswers);
    const startedAt = Date.now();
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 8000,
      cache_control: { type: "ephemeral" },
      thinking: { type: "adaptive" },
      output_config: { effort: "medium", format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });
    const elapsedMs = Date.now() - startedAt;

    if (response.stop_reason === "refusal") {
      console.warn("Refusal:", response.stop_details);
      return res.status(422).json({ error: "refusal", message: "AIが訴状の生成を行えませんでした。" });
    }
    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock) throw new Error("No text content in response");
    const complaint = JSON.parse(textBlock.text);

    console.log(`[${new Date().toISOString()}] COMPLAINT ${referenceId} form=${complaint.formType} elapsed=${elapsedMs}ms`);

    // GAS へ紐付け（行更新＋Doc作成＋メール）。失敗しても生成結果は返す（管理画面で再生成可能）。
    const attached = await forwardToGoogleSheets({ action: "attachComplaint", referenceId, complaint });

    return res.status(200).json({ status: "ok", referenceId, attached, complaint });
  } catch (error) {
    console.error("Complaint generation error:", error);
    if (error instanceof Anthropic.RateLimitError) return res.status(429).json({ error: "upstream_rate_limit", message: "AIが混雑しています。時間をおいて再度お試しください。" });
    if (error instanceof Anthropic.AuthenticationError) return res.status(500).json({ error: "auth_error", message: "サーバー側の認証設定に問題があります。" });
    if (error instanceof Anthropic.APIError) return res.status(502).json({ error: "upstream_error", message: `AIとの通信に失敗しました（${error.status || "unknown"}）。` });
    return res.status(500).json({ error: "internal_error", message: "訴状の生成に失敗しました。" });
  }
}
