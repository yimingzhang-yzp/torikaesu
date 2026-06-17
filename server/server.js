import Anthropic from "@anthropic-ai/sdk";
import express from "express";
import cors from "cors";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

const corsOptions =
  CORS_ORIGIN === "*"
    ? { origin: true }
    : { origin: CORS_ORIGIN.split(",").map((s) => s.trim()) };

app.use(cors(corsOptions));
app.use(express.json({ limit: "64kb" }));

const client = new Anthropic();

// ============ ラベル定義 ============
const LABELS = {
  caseType: {
    deposit: "敷金・保証金の返還請求",
    freelance: "業務委託・フリーランスの未払い報酬",
    loan: "個人間の金銭貸借（消費貸借）",
    online: "ネット取引・フリマアプリ取引トラブル",
    wage: "給与・残業代の未払い",
    damage: "物品の損害・破損賠償",
    other: "その他の金銭請求",
  },
  time: {
    lt1y: "発生から1年未満",
    "1-3y": "発生から1〜3年",
    "3-5y": "発生から3〜5年（時効に注意）",
    "5-10y": "発生から5〜10年（時効リスク高）",
    gt10y: "発生から10年以上前（時効成立の可能性大）",
  },
  evidence: {
    contract: "契約書・合意書（書面）",
    message: "メール・LINE・SMS等のメッセージ記録",
    receipt: "領収書・振込明細・銀行履歴",
    photo: "写真・録音・録画",
    witness: "第三者の証言（証人）",
    certmail: "内容証明郵便の送付実績あり",
    none: "客観的証拠なし",
  },
  defendant: {
    both: "氏名・住所ともに完全に把握している",
    company: "法人・店舗（登記情報から特定可能）",
    name: "氏名のみ判明（住所は不明）",
    neither: "氏名・住所ともに不明",
  },
  communication: {
    admit: "相手が支払い義務を認めている",
    repeated: "繰り返し催促したが応じない",
    once: "一度督促したが反応なし",
    none: "まだ請求していない",
    deny: "相手が請求自体を拒否・否定している",
  },
};

// ============ システムプロンプト ============
const SYSTEM_PROMPT = `あなたは、日本の少額訴訟（民事訴訟法第368条以下に規定される簡易裁判所での60万円以下の金銭請求訴訟手続）に関する判例・実務に精通した法務AIアシスタントです。

# あなたの役割と立場（最重要）

ユーザーから提供される案件情報を分析し、少額訴訟における勝訴・回収の可能性を客観的に評価したうえで、**ユーザーが「自分自身で」少額訴訟を申し立てるために必要な情報を、わかりやすく整理して提示**します。

あなたは、**裁判所に提出する書類（訴状等）の作成代行・代理は行いません**。提供するのは、あくまで一般的な情報・記入例・手続きの案内です。以下を厳守してください：

- 訴状の「記入例」は、必ず**架空の氏名・金額・日付**（例：「山田太郎」「金10万円」「令和6年4月1日」）を用いた**書き方の見本**として提示する。ユーザーが入力した実際の情報（実際の金額・相手方等）を訴状の文面として勝手に当てはめて完成させてはならない。
- 各記入項目には、ユーザーが自分で記入する際の注意点（hint）を添える。
- 「あなたの代わりに書類を作成しました」といった代行・代理を示す表現は禁止。「ご自身で記入される際の参考としてください」という情報提供の立場を維持する。
- 管轄裁判所は「候補」と「考え方」を示し、**最終確認は裁判所公式サイトの管轄区域案内やユーザー自身で行う**よう必ず促す。

# 評価フレームワーク

## 1. 事件類型ごとの法的根拠と判例傾向

- **敷金返還**: 民法・借地借家法。最高裁平成17年12月16日判決（通常損耗は賃借人負担としない原則）が中心的根拠。判例の蓄積が豊富で賃借人勝訴率が比較的高い。
- **業務委託未払い**: 民法632条以下（請負）、643条以下（委任）。契約書・発注書・納品物の確認があれば認容されやすい。
- **個人間貸付**: 民法587条以下（消費貸借契約）。借用書の有無、振込履歴、一部返済の事実が立証の鍵。借用書がなくてもメッセージ記録から契約成立を認定する判例あり。
- **ネット取引**: 民法555条以下（売買）、消費者契約法、特定商取引法。取引履歴の保全が重要。
- **給与未払い**: 労働基準法24条、付加金（114条）。労基法115条により消滅時効は5年（経過措置中）。
- **物品損害**: 民法709条（不法行為）。損害額の客観的立証と因果関係の証明が課題。

## 2. 消滅時効（改正民法、2020年4月1日以降施行）

- 原則：知った時から5年、または権利行使可能時から10年（民法166条）
- 不法行為：損害・加害者を知った時から3年（民法724条）
- 賃金請求権：5年（労基法115条、経過措置あり）
- **内容証明郵便等による催告は時効中断効果あり**

## 3. 証拠の評価階層

強度の高い順：契約書 ＞ 内容証明郵便 ＞ メッセージ記録 ＞ 領収書・振込明細 ＞ 写真・録音 ＞ 第三者証言

複数の証拠の組み合わせが立証力を強化する。

## 4. 相手方特定の重要性

- 氏名+住所判明：訴状送達可能、最もスムーズ
- 法人：登記簿で完全特定容易
- 氏名のみ：住民票調査が必要（手続き複雑化、調査期間を要する）
- 両方不明：訴訟提起の前提を欠く

## 5. 60万円上限の絶対性

60万円を超える請求は少額訴訟の対象外。通常訴訟（簡裁通常または地裁）に切り替える必要がある。

## 6. 管轄裁判所の決まり方（courtGuidance の根拠）

ユーザーが「どの簡易裁判所に申し立てればよいか」を自分で判断できるよう、次のルールに基づいて**候補となる簡易裁判所**と考え方を提示する：

- **普通裁判籍（民訴4条）**：被告（相手方）の住所地を管轄する簡易裁判所。
- **義務履行地の特別裁判籍（民訴5条1号、民法484条）**：金銭の支払いを求める請求は原則として持参債務であり、**債権者（申立人＝あなた）の現在の住所地**を管轄する簡易裁判所にも提起できる。→ 申立人にとって最も利用しやすい候補になることが多い。
- **不法行為地（民訴5条9号）**：物品損害など不法行為に基づく請求では、不法行為があった地（事件発生地）の簡易裁判所も候補。
- **合意管轄（民訴11条）**：契約書に管轄裁判所の定めがある場合はそれに従う。
- 候補が複数ある場合、申立人は便利な裁判所を選べる。

**重要**：あなたは具体的な市区町村→簡易裁判所の正確な対応表を完全には保有していない。提示した裁判所名（例：「○○簡易裁判所」）は**候補・目安**であり、**必ず裁判所公式サイトの「裁判所の管轄区域」（https://www.courts.go.jp/saiban/tetuzuki/kankatu/index.html）で最終確認するよう案内**すること。地名から確信を持って言えない場合は、「お住まいの市区町村を管轄する簡易裁判所」という形で根拠（考え方）を中心に示し、断定を避ける。架空の裁判所名を作ってはならない。

## 7. 訴状の記入例（complaintSample の作り方）

事件類型に応じた**訴状の記入例（書き方の見本）**を提示する。少額訴訟の訴状の主な記載項目：

- 当事者の表示（原告・被告の氏名・住所）
- 事件名（例：「貸金返還請求事件」）
- 請求の趣旨（求める判決の結論。例：「被告は原告に対し、金○○円及びこれに対する令和○年○月○日から支払済みまで年3％の割合による金員を支払え」）
- 紛争の要点／請求の原因（いつ・誰と・どのような約束で・いくらの債権が生じ、なぜ未払いか）
- 添付書類・証拠の表示
- 少額訴訟による審理及び裁判を求める旨、本年の少額訴訟の利用回数
- 年月日、提出先の簡易裁判所名、原告の記名押印

各 field は **架空の記入例（example）** と **ご自身が記入する際の注意（hint）** をセットで示す。note では、実際の提出時には裁判所が用意する少額訴訟用の定型訴状用紙を使うとよい旨を案内する。

## 8. 手続きの流れ（procedureSteps）

申立てから判決・回収までの一般的な流れを、ユーザーが順を追って実行できるステップとして提示する（書式入手→記入→証拠準備→手数料・郵券準備→提出→期日出頭→判決・和解→必要に応じ強制執行）。事件類型に応じて要点を補足する。

## 9. 費用の目安（costs）

- **申立手数料（収入印紙）**：訴額に応じる（民事訴訟費用等に関する法律）。目安は訴額10万円ごとに概ね1,000円（例：10万円→1,000円、30万円→3,000円、60万円→6,000円程度）。請求金額から概算を示す。
- **予納郵便切手**：概ね数千円程度（裁判所・当事者数により異なる）。
- いずれも裁判所により異なるため、提出先の簡易裁判所で確認するよう案内する。

# スコアリングガイドライン

総合的に0〜100点で評価する。以下は各要因の影響の目安：

| 要因 | スコア影響 |
|---|---|
| 強力な書面証拠（契約書・内容証明）あり | +10〜+18 |
| 相手の自認・債務認諾 | +20〜+25 |
| 時効間近（5年経過） | -25〜-35 |
| 時効成立可能性高（10年以上） | -45〜-55 |
| 60万円超（対象外） | -60以下、outOfScope=true |
| 相手方完全不明 | -40 |
| 客観的証拠完全不足 | -30 |

最終分類：
- **70点以上**: "勝ち目あり"
- **45〜69点**: "十分検討の価値あり"
- **1〜44点**: "慎重な検討が必要"
- **0点または対象外**: "対象外"（outOfScope=trueの場合）

# 出力JSON仕様

必ず以下の構造でJSONを出力してください：

\`\`\`
{
  "score": 0-100の整数,
  "verdict": "勝ち目あり" | "十分検討の価値あり" | "慎重な検討が必要" | "対象外",
  "verdictDesc": 判定根拠の要約説明（100〜180字、敬語、結果保証は避ける）,
  "winRate": 0.0〜1.0の数値（推定勝率）,
  "estimatedAmount": 予想手取り額（請求額 × winRate - 2980円、最低0）,
  "reasons": [
    {"type": "pos"|"neg"|"neu", "text": 個別の判断根拠（70〜140字、敬語）}
  ],  // 4〜7件
  "precedents": [
    {
      "meta": "○○簡裁・YYYY年判決" 等の表示用ラベル,
      "title": 判例の要旨（30〜60字）,
      "result": 判決内容と本件への含意（80〜150字、敬語）
    }
  ],  // 3件
  "outOfScope": true|false,
  "outOfScopeReason": outOfScopeがtrueの場合の理由（敬語、それ以外はnull）,
  "legalBasis": 適用法令・条文の要約（30〜80字、例：「民法587条・587条の2（消費貸借契約）、改正民法166条（消滅時効）」）,
  "courtGuidance": {
    "candidates": [
      {"name": 候補となる簡易裁判所名または「お住まいの市区町村を管轄する簡易裁判所」等の表現, "basis": 管轄の根拠（例：「義務履行地（あなたの住所地）／民訴5条1号」「被告の住所地／民訴4条」）}
    ],  // 1〜3件。地名から確信できない場合は考え方中心に
    "explanation": 管轄の考え方の説明（120〜220字、敬語。金銭請求は自分の住所地の簡裁にも申し立てられることなどを案内）,
    "verifyUrl": "https://www.courts.go.jp/saiban/tetuzuki/kankatu/index.html",
    "verifyNote": 最終確認の方法（裁判所公式サイトで管轄区域を確認する旨、60〜120字、敬語）
  },
  "complaintSample": {
    "title": 記入例のタイトル（例：「貸金返還請求事件 訴状（記入例）」）,
    "intro": この記入例の説明（架空の例である旨、ご自身で記入する際の参考である旨。60〜120字、敬語）,
    "fields": [
      {"label": 記載項目名（例：請求の趣旨）, "example": 架空の記入例, "hint": ご自身が記入する際の注意（敬語）}
    ],  // 5〜8件（当事者の表示・事件名・請求の趣旨・紛争の要点/請求の原因・添付書類・少額訴訟を求める旨 等）
    "note": 補足（実際は裁判所の少額訴訟用定型訴状用紙の利用を勧める旨。60〜120字、敬語）
  },
  "procedureSteps": [
    {"title": ステップ名（例：「1. 訴状用紙と添付書類を入手する」）, "detail": 具体的な内容（70〜150字、敬語）}
  ],  // 5〜7ステップ
  "costs": {
    "stampFee": 申立手数料（収入印紙）の目安（請求金額から概算。例：「請求額○○円の場合、収入印紙 約○,000円」）,
    "postage": 予納郵便切手の目安（例：「概ね3,000〜5,000円程度」）,
    "note": 補足（裁判所により異なる旨、実費である旨。40〜100字、敬語）
  }
}
\`\`\`

# 重要な遵守事項

1. **判例の真正性**: 最高裁判例で実在するもの（例：最高裁平成17年12月16日敷金判決）は引用可能。ただし簡易裁判所の個別判決を具体的な番号付きで引用することは避け、「○○簡裁・近年の傾向」「類型上の判例蓄積では」など類型的表現にとどめてください。**架空の判決番号や事件番号を捏造することは絶対に禁止です**。

2. **結果保証の禁止**: 「必ず勝てる」「確実に回収できる」など断定的表現は使用禁止。「〜の傾向があります」「〜と評価できます」等の評価表現にとどめてください。

3. **客観性の維持**: ユーザーが入力した情報のみを根拠とし、推測で要因を追加しないでください。情報が不足している場合は「情報不足」を理由として扱ってください。

4. **60万円超の取扱い**: 請求金額が60万円を超える場合、必ず outOfScope=true、verdict="対象外" とし、outOfScopeReason で通常訴訟への切り替えを案内してください。estimatedAmount=0、winRate=0 として扱います。

5. **時効成立の可能性が高い場合**: 10年以上経過しているケースでは、時効中断措置の有無を確認した上で、現実的な勝訴可能性を率直に評価してください。

6. **敬語使用**: ユーザー向けの全テキストフィールド（verdictDesc, reasons.text, precedents.result, outOfScopeReason）は丁寧語・敬語で記述してください。

7. **JSON厳密性**: 必ず指定されたJSONスキーマに準拠してください。余分なフィールドの追加、フィールドの欠落、型の誤りは禁止です。

8. **書類作成代行の禁止**: complaintSample はあくまで架空の記入例（書き方の見本）です。ユーザーの実際の事案の事実を当てはめて「完成した訴状」を出力してはなりません。常に「ご自身で記入される際の参考」という情報提供の立場を保ってください。

9. **管轄裁判所の断定回避**: courtGuidance.candidates の裁判所名は候補・目安です。市区町村から確信を持てない場合は「お住まいの市区町村を管轄する簡易裁判所」のように考え方中心で示し、必ず公式サイトでの確認を促してください。実在しない裁判所名の創作は禁止です。

10. **対象外（60万円超）の場合**: outOfScope=true でも、courtGuidance・complaintSample・procedureSteps・costs は通常訴訟への切り替えを前提とした一般的な案内として可能な範囲で提示し、verdictDesc／outOfScopeReason で通常訴訟手続きの検討を案内してください。`;

// ============ JSON出力スキーマ ============
const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    score: { type: "integer" },
    verdict: {
      type: "string",
      enum: ["勝ち目あり", "十分検討の価値あり", "慎重な検討が必要", "対象外"],
    },
    verdictDesc: { type: "string" },
    winRate: { type: "number" },
    estimatedAmount: { type: "integer" },
    reasons: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["pos", "neg", "neu"] },
          text: { type: "string" },
        },
        required: ["type", "text"],
        additionalProperties: false,
      },
    },
    precedents: {
      type: "array",
      items: {
        type: "object",
        properties: {
          meta: { type: "string" },
          title: { type: "string" },
          result: { type: "string" },
        },
        required: ["meta", "title", "result"],
        additionalProperties: false,
      },
    },
    outOfScope: { type: "boolean" },
    outOfScopeReason: { type: ["string", "null"] },
    legalBasis: { type: "string" },
    courtGuidance: {
      type: "object",
      properties: {
        candidates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              basis: { type: "string" },
            },
            required: ["name", "basis"],
            additionalProperties: false,
          },
        },
        explanation: { type: "string" },
        verifyUrl: { type: "string" },
        verifyNote: { type: "string" },
      },
      required: ["candidates", "explanation", "verifyUrl", "verifyNote"],
      additionalProperties: false,
    },
    complaintSample: {
      type: "object",
      properties: {
        title: { type: "string" },
        intro: { type: "string" },
        fields: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              example: { type: "string" },
              hint: { type: "string" },
            },
            required: ["label", "example", "hint"],
            additionalProperties: false,
          },
        },
        note: { type: "string" },
      },
      required: ["title", "intro", "fields", "note"],
      additionalProperties: false,
    },
    procedureSteps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          detail: { type: "string" },
        },
        required: ["title", "detail"],
        additionalProperties: false,
      },
    },
    costs: {
      type: "object",
      properties: {
        stampFee: { type: "string" },
        postage: { type: "string" },
        note: { type: "string" },
      },
      required: ["stampFee", "postage", "note"],
      additionalProperties: false,
    },
  },
  required: [
    "score",
    "verdict",
    "verdictDesc",
    "winRate",
    "estimatedAmount",
    "reasons",
    "precedents",
    "outOfScope",
    "outOfScopeReason",
    "legalBasis",
    "courtGuidance",
    "complaintSample",
    "procedureSteps",
    "costs",
  ],
  additionalProperties: false,
};

// ============ 入力検証 ============
function validateInput(body) {
  const { caseType, amount, time, evidence, defendant, communication, location } = body || {};
  if (!caseType || !LABELS.caseType[caseType]) return "事件類型が無効です";
  if (typeof amount !== "number" || amount <= 0 || amount > 100_000_000)
    return "請求金額が無効です";
  if (!time || !LABELS.time[time]) return "経過期間が無効です";
  if (evidence && !Array.isArray(evidence)) return "証拠の形式が無効です";
  if (evidence) {
    for (const ev of evidence) {
      if (!LABELS.evidence[ev]) return `証拠の種類が無効です: ${ev}`;
    }
  }
  if (!defendant || !LABELS.defendant[defendant])
    return "相手方情報が無効です";
  if (!communication || !LABELS.communication[communication])
    return "交渉履歴が無効です";
  // location は任意。指定がある場合のみ型を検証する。
  if (location !== undefined && location !== null) {
    if (typeof location !== "object" || Array.isArray(location))
      return "所在地情報の形式が無効です";
    for (const key of ["plaintiff", "defendant", "incident"]) {
      const v = location[key];
      if (v !== undefined && v !== null && typeof v !== "string")
        return "所在地情報の形式が無効です";
      if (typeof v === "string" && v.length > 100)
        return "所在地情報が長すぎます";
    }
  }
  return null;
}

// ============ ユーザーメッセージ生成 ============
function buildUserMessage(data) {
  const evList = (data.evidence || [])
    .map((e) => LABELS.evidence[e])
    .filter(Boolean);

  const loc = data.location || {};
  const fmtLoc = (v) => (typeof v === "string" && v.trim() ? v.trim() : "未入力");

  return `以下の少額訴訟案件についてAI診断と手続き情報の提示をお願いします。指定されたJSONスキーマに厳密に従って結果を出力してください。

【事件類型】${LABELS.caseType[data.caseType]}
【請求金額】${data.amount.toLocaleString("ja-JP")}円
【経過期間】${LABELS.time[data.time]}
【保有する証拠】${evList.length > 0 ? evList.join("、") : "なし／不明"}
【相手方情報】${LABELS.defendant[data.defendant]}
【交渉履歴】${LABELS.communication[data.communication]}
【申立人（あなた）の所在地】${fmtLoc(loc.plaintiff)}
【相手方の所在地】${fmtLoc(loc.defendant)}
【事件発生地】${fmtLoc(loc.incident)}

評価フレームワークに基づき、勝訴可能性・回収見込み・類似判例傾向・適用法令を分析してください。あわせて、ユーザーがご自身で申立てを進められるよう、管轄裁判所の候補と考え方（courtGuidance）、事件類型に応じた訴状の記入例（complaintSample）、手続きの流れ（procedureSteps）、費用の目安（costs）を提示してください。所在地が「未入力」の項目は断定せず、考え方を中心に案内してください。JSONを出力してください。`;
}

// ============ 簡易レート制限（IP単位） ============
const rateLimitMap = new Map();
const RL_WINDOW_MS = 60 * 1000;
const RL_MAX = 10;

function checkRateLimit(ip) {
  const now = Date.now();
  const entries = (rateLimitMap.get(ip) || []).filter(
    (t) => now - t < RL_WINDOW_MS,
  );
  if (entries.length >= RL_MAX) return false;
  entries.push(now);
  rateLimitMap.set(ip, entries);
  return true;
}

// 定期的に古いエントリをクリーンアップ
setInterval(() => {
  const now = Date.now();
  for (const [ip, entries] of rateLimitMap.entries()) {
    const fresh = entries.filter((t) => now - t < RL_WINDOW_MS);
    if (fresh.length === 0) rateLimitMap.delete(ip);
    else rateLimitMap.set(ip, fresh);
  }
}, 5 * 60 * 1000);

// ============ ヘルスチェック ============
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    model: "claude-opus-4-7",
    apiKeyConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
  });
});

// ============ 診断エンドポイント ============
app.post("/api/diagnose", async (req, res) => {
  const ip = req.ip || req.headers["x-forwarded-for"] || "unknown";

  if (!checkRateLimit(ip)) {
    return res.status(429).json({
      error: "rate_limit",
      message:
        "リクエストが多すぎます。1分後に再度お試しください（1分あたり10回まで）。",
    });
  }

  const validationError = validateInput(req.body);
  if (validationError) {
    return res.status(400).json({ error: "invalid_input", message: validationError });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({
      error: "no_api_key",
      message:
        "サーバー側でAPI設定が完了していません。管理者にお問い合わせください。",
    });
  }

  try {
    const userMessage = buildUserMessage(req.body);
    const startedAt = Date.now();

    const response = await client.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 6000,
      cache_control: { type: "ephemeral" },
      thinking: { type: "adaptive" },
      output_config: {
        effort: "high",
        format: {
          type: "json_schema",
          schema: OUTPUT_SCHEMA,
        },
      },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });

    const elapsedMs = Date.now() - startedAt;

    if (response.stop_reason === "refusal") {
      console.warn("Claude refused the request:", response.stop_details);
      return res.status(422).json({
        error: "refusal",
        message:
          "ご入力内容について、AIが診断を行えませんでした。内容を見直してお試しください。",
      });
    }

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock) {
      throw new Error("No text content in Claude response");
    }

    const result = JSON.parse(textBlock.text);
    result._meta = {
      model: response.model,
      elapsedMs,
      source: "ai",
    };

    const usage = response.usage;
    console.log(
      `[${new Date().toISOString()}] OK ip=${ip} elapsed=${elapsedMs}ms ` +
        `cache_read=${usage.cache_read_input_tokens || 0} ` +
        `cache_write=${usage.cache_creation_input_tokens || 0} ` +
        `input=${usage.input_tokens} output=${usage.output_tokens}`,
    );

    res.json(result);
  } catch (error) {
    console.error("Diagnosis error:", error);

    if (error instanceof Anthropic.RateLimitError) {
      return res.status(429).json({
        error: "upstream_rate_limit",
        message:
          "AI診断サービスが一時的に混雑しています。少し時間をおいて再度お試しください。",
      });
    }
    if (error instanceof Anthropic.AuthenticationError) {
      return res.status(500).json({
        error: "auth_error",
        message: "サーバー側の認証設定に問題があります。管理者にお問い合わせください。",
      });
    }
    if (error instanceof Anthropic.APIError) {
      return res.status(502).json({
        error: "upstream_error",
        message: `AI診断サービスとの通信に失敗しました（${error.status || "unknown"}）。`,
      });
    }
    res.status(500).json({
      error: "internal_error",
      message: "診断処理に失敗しました。しばらく時間をおいて再度お試しください。",
    });
  }
});

// ============ 申し込み受付エンドポイント ============
const APPLICATIONS_FILE = path.join(__dirname, "applications.json");
const GOOGLE_SHEETS_WEBHOOK = (process.env.GOOGLE_SHEETS_WEBHOOK || "").trim();
const GOOGLE_SHEETS_TIMEOUT_MS = 10000;

async function forwardToGoogleSheets(entry) {
  if (!GOOGLE_SHEETS_WEBHOOK) return;
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    GOOGLE_SHEETS_TIMEOUT_MS,
  );
  try {
    const resp = await fetch(GOOGLE_SHEETS_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!resp.ok) {
      console.warn(
        `Google Sheets forwarding failed: HTTP ${resp.status} (ref=${entry.referenceId})`,
      );
      return;
    }
    let body;
    try {
      body = await resp.json();
    } catch (_) {
      body = null;
    }
    if (body && body.status === "ok") {
      console.log(
        `Google Sheets forwarded: ${entry.referenceId}`,
      );
    } else {
      console.warn(
        `Google Sheets forwarded but response unexpected: ${entry.referenceId} body=${JSON.stringify(body)}`,
      );
    }
  } catch (err) {
    clearTimeout(timeoutId);
    console.warn(
      `Google Sheets forwarding error (ref=${entry.referenceId}): ${err.message}`,
    );
  }
}

function validateEmailServer(email) {
  if (!email || typeof email !== "string") return false;
  if (email.length > 200) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function sanitizeString(value, maxLength) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, maxLength);
}

async function appendApplication(entry) {
  let existing = [];
  try {
    const data = await fs.readFile(APPLICATIONS_FILE, "utf-8");
    existing = JSON.parse(data);
    if (!Array.isArray(existing)) existing = [];
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn("applications.json読み込み失敗、新規作成します:", err.message);
    }
    existing = [];
  }
  existing.push(entry);
  await fs.writeFile(APPLICATIONS_FILE, JSON.stringify(existing, null, 2), "utf-8");
}

app.post("/api/apply", async (req, res) => {
  const ip = req.ip || req.headers["x-forwarded-for"] || "unknown";

  if (!checkRateLimit(ip)) {
    return res.status(429).json({
      error: "rate_limit",
      message:
        "リクエストが多すぎます。しばらく時間をおいて再度お試しください。",
    });
  }

  const {
    email,
    name,
    phone,
    preferredContact,
    notes,
    diagnosisResult,
    diagnosisAnswers,
  } = req.body || {};

  if (!validateEmailServer(email)) {
    return res.status(400).json({
      error: "invalid_email",
      message: "有効なメールアドレスをご入力ください。",
    });
  }

  const validContact = ["email", "phone", "either"];
  const contact = validContact.includes(preferredContact)
    ? preferredContact
    : "email";

  const referenceId =
    "app_" + crypto.randomBytes(6).toString("hex");

  const entry = {
    referenceId,
    timestamp: new Date().toISOString(),
    ip,
    email: email.trim().toLowerCase(),
    name: sanitizeString(name, 100),
    phone: sanitizeString(phone, 30),
    preferredContact: contact,
    notes: sanitizeString(notes, 2000),
    diagnosisResult: diagnosisResult || null,
    diagnosisAnswers: diagnosisAnswers || null,
    userAgent: sanitizeString(req.headers["user-agent"], 300),
  };

  try {
    await appendApplication(entry);
    console.log(
      `[${new Date().toISOString()}] APPLICATION ${referenceId} ` +
        `email=${entry.email} preferred=${contact} ` +
        `caseType=${(diagnosisAnswers && diagnosisAnswers.caseType) || "—"} ` +
        `amount=${(diagnosisAnswers && diagnosisAnswers.amount) || "—"}`,
    );

    // Google Sheets への転送はファイアアンドフォーゲット（ユーザー応答を遅延させない）
    forwardToGoogleSheets(entry).catch((err) => {
      console.error("Sheets forward unexpected error:", err);
    });

    res.json({ status: "ok", referenceId });
  } catch (err) {
    console.error("申し込み保存失敗:", err);
    res.status(500).json({
      error: "storage_error",
      message:
        "送信処理に失敗しました。お手数ですがメールで再度ご連絡ください。",
    });
  }
});

// ============ 起動 ============
app.listen(PORT, () => {
  console.log(`トリカエスAI診断API起動: http://localhost:${PORT}`);
  console.log(`Health check:           GET  /api/health`);
  console.log(`Diagnose endpoint:      POST /api/diagnose`);
  console.log(`Apply endpoint:         POST /api/apply`);
  console.log(`Applications saved to:  ${APPLICATIONS_FILE}`);
  console.log(
    `Google Sheets:          ${GOOGLE_SHEETS_WEBHOOK ? "連携有効" : "未設定（SHEETS_SETUP.md参照）"}`,
  );
  console.log(
    `Model:                  claude-opus-4-7 (adaptive thinking, effort=high)`,
  );
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn(
      "\n⚠ WARNING: ANTHROPIC_API_KEY is not set. /api/diagnose will return 500.",
    );
  }
});
