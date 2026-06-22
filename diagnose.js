(function () {
  'use strict';

  // ============================================
  // 設定
  // ============================================
  // バックエンドAPIのエンドポイント。空文字なら直接ヒューリスティック診断を使用。
  // 本番（同一オリジンのVercelサーバーレス関数）: '/api/diagnose'
  // ローカルでExpressサーバー（server/）を使う場合: 'http://localhost:3000/api/diagnose'
  //   （または `vercel dev` で静的配信とAPIを同一オリジンで起動）
  const API_ENDPOINT = '/api/diagnose';

  // APIタイムアウト（ミリ秒）
  const API_TIMEOUT_MS = 45000;

  // ============================================
  // 定数
  // ============================================
  const STEPS = ['welcome', 'q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'loading', 'result'];
  const Q_STEPS = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7'];
  const ARC_LENGTH = 251.33;
  const SERVICE_FEE = 2980;

  // 裁判所公式の固定参照URL（AIに生成させず、ここで一元管理してURL誤りを防ぐ）
  const COURT_KANKATSU_URL = 'https://www.courts.go.jp/saiban/tetuzuki/kankatu/index.html';
  const COURT_LOCATION_PDF_URL = 'https://www.courts.go.jp/vc-files/courts/2024/databook2024/db2024_ex3.pdf';
  const SHOJO_FORM_LIST_URL = 'https://www.courts.go.jp/saiban/syosiki/syosiki_syogaku_sosyou/index.html';
  const HANREI_SEARCH_URL = 'https://www.courts.go.jp/app/hanrei_jp/search1';

  const state = {
    currentIdx: 0,
    answers: {},
    lastResult: null,
  };

  // ============================================
  // ヒューリスティック（フォールバック）用データ
  // ============================================
  const caseTypeFallback = {
    deposit:   { score: 12, reason: '敷金返還請求は判例の蓄積が豊富で、賃借人勝訴率が高い類型です' },
    freelance: { score: 8,  reason: '業務委託の未払い報酬は、契約の証跡があれば認められやすい類型です' },
    loan:      { score: 0,  reason: '個人間貸付は証拠の質によって結果が大きく変わる類型です' },
    online:    { score: -2, reason: 'ネット取引は、相手方の特定と取引履歴の保全が結果を左右します' },
    wage:      { score: 12, reason: '未払い賃金は労働基準法上の強い保護があり、勝訴率が高い類型です' },
    damage:    { score: -3, reason: '物品損害は、損害額の客観的な立証が課題となる類型です' },
    other:     { score: -5, reason: 'その他の類型は、個別の事実関係に応じた慎重な判断が必要です' },
  };

  const timeFallback = {
    'lt1y':  { score: 15,  reason: '発生から日が浅く、時効の問題は生じません' },
    '1-3y':  { score: 10,  reason: '時効までに十分な余裕があり、迅速な対応が可能です' },
    '3-5y':  { score: 0,   reason: '時効に近づきつつあるため、早めの提訴が望まれます' },
    '5-10y': { score: -30, reason: '消滅時効（原則5年）の援用リスクがあります' },
    'gt10y': { score: -55, reason: '時効が成立している可能性が高く、訴訟提起は困難な状況です' },
  };

  const evidenceFallback = {
    contract: { score: 16, reason: '契約書・合意書があり、請求の根拠が文書で明確になっています' },
    message:  { score: 12, reason: 'メッセージ記録があり、相手とのやり取りが客観的に立証できます' },
    receipt:  { score: 10, reason: '領収書・振込明細により、金銭の流れが追跡可能です' },
    photo:    { score: 5,  reason: '写真・録音が補足的な証拠として機能します' },
    witness:  { score: 5,  reason: '第三者の証言が補強材料として活用できる見込みです' },
    certmail: { score: 10, reason: '内容証明郵便により、請求の事実と時期が公的に記録されています' },
    none:     { score: -32, reason: '客観的証拠が不足しています。手元のメッセージ・振込履歴等を再度ご確認ください' },
  };

  const defendantFallback = {
    'both':    { score: 12,  reason: '相手方の情報が完全に把握できており、訴状の送達がスムーズに進みます' },
    'company': { score: 14,  reason: '法人・店舗が相手であり、登記情報から所在を特定しやすい状況です' },
    'name':    { score: -10, reason: '住所が不明な場合、住民票の取得等の調査が必要となります' },
    'neither': { score: -42, reason: '相手方の特定が訴訟提起の前提として必要です' },
  };

  const commFallback = {
    'admit':    { score: 22,  reason: '相手が支払い義務を認めており、勝訴・回収の可能性が大きく高まります' },
    'repeated': { score: 6,   reason: '繰り返し請求した記録は、相手の悪意・遅滞の立証に有利に働きます' },
    'once':     { score: 0,   reason: '事前の催告があり、訴訟提起の前提条件が整っています' },
    'none':     { score: -6,  reason: '訴訟前に内容証明郵便での催告を行うことが推奨されます' },
    'deny':     { score: -12, reason: '相手が請求を否定しており、争点が生じる可能性があります' },
  };

  const fallbackPrecedents = {
    deposit: [
      { meta: '最高裁判例（敷金・通常損耗）', title: '通常損耗の控除を否定し敷金返還を命じた事例の蓄積あり', result: '最高裁平成17年12月16日判決を踏まえ、通常使用による損耗は賃借人負担としない原則が定着しています。簡裁レベルでも同様の判断が積み重ねられています', caseNumber: '最高裁平成17年12月16日 第二小法廷判決（平成16年（受）第1573号）' },
      { meta: '類型上の傾向（特約の無効）', title: '敷引特約・原状回復特約の一部無効を判断する事例', result: '消費者契約法第10条に基づき、過大な敷引特約の一部を無効とする判断が複数報告されています' },
    ],
    freelance: [
      { meta: '類型上の傾向（業務委託）', title: '納品物の確認と発注記録から報酬請求を認容', result: 'メール・LINE等で発注内容と納品が確認できる場合、口頭契約でも報酬請求が認められやすい傾向にあります' },
      { meta: '類型上の傾向（成果物検収）', title: '検収後の代金支払い義務を肯定', result: '成果物の検収を経た案件で、後から瑕疵を理由とした支払拒否を退ける判断が一般的です' },
    ],
    loan: [
      { meta: '類型上の傾向（個人間貸付）', title: '借用書なしでもメッセージ記録から契約成立を認定', result: 'LINEでの貸付の合意と振込履歴が揃っていれば、借用書がなくても消費貸借契約の成立が認定される事例があります' },
      { meta: '類型上の傾向（一部返済の効果）', title: '一部返済の事実が当初の貸付契約を裏付ける', result: '一部返済の事実は、当初の貸付契約の存在を強く裏付ける証拠となります' },
    ],
    online: [
      { meta: '類型上の傾向（ネット取引）', title: 'プラットフォームの取引履歴から債務不履行を認定', result: 'フリマアプリ等のアカウント情報と取引履歴が保全されていれば、代金返還請求が認められる傾向にあります' },
      { meta: '類型上の傾向（商品瑕疵）', title: '商品説明と実物の差異から契約解除を認める', result: '出品時の写真・説明文と実物との相違が立証されれば、契約解除と代金返還が認められやすい傾向にあります' },
    ],
    wage: [
      { meta: '類型上の傾向（未払い賃金）', title: '労働時間記録から未払い賃金の支払いを命令', result: 'タイムカードや業務メール等から労働時間が立証できれば、未払いの基本給・残業代の支払いが命じられる傾向にあります' },
      { meta: '類型上の傾向（付加金）', title: '労基法114条の付加金請求も認められる事例', result: '使用者の悪質性が認められる場合、未払い額と同額の付加金が加算されることもあります' },
    ],
    damage: [
      { meta: '類型上の傾向（物品損害）', title: '加害行為の特定と損害額の立証で賠償命令', result: '監視カメラや目撃証言で加害行為が特定でき、修理費用等の損害額が客観的に立証できれば、相当額の賠償が認められます' },
    ],
    other: [
      { meta: '類型上の傾向（金銭請求一般）', title: '請求権の根拠と事実関係の整理で認容判決', result: '請求の性質と証拠次第で判断が大きく異なる類型です。事実関係と法的構成を明確に整理することが重要となります' },
    ],
  };

  // ============================================
  // フォールバック用：事件類型別の訴状記入例データ
  // ============================================
  const caseComplaintFallback = {
    deposit:   { caseName: '敷金返還請求事件',          form: '訴状（少額訴訟用・敷金返還）', origin: '原告は令和〇年〇月〇日、被告との間で建物賃貸借契約を締結し、敷金として金〇〇円を預け入れた。原告は令和〇年〇月〇日に当該物件を明け渡したが、被告は通常損耗分まで原状回復費用として控除し、敷金を返還しない。' },
    freelance: { caseName: '請負代金（報酬）請求事件',  form: '訴状（少額訴訟用・請負代金）', origin: '原告は令和〇年〇月〇日、被告からウェブサイト制作業務を代金〇〇円で受託し、令和〇年〇月〇日に成果物を納品して検収を受けた。しかし被告は支払期日を過ぎても報酬を支払わない。' },
    loan:      { caseName: '貸金返還請求事件',          form: '訴状（少額訴訟用・貸金）',     origin: '原告は令和〇年〇月〇日、被告に対し金〇〇円を、返済期日を令和〇年〇月〇日と定めて貸し付けた。しかし被告は返済期日を過ぎても返済しない。' },
    online:    { caseName: '売買代金返還請求事件',      form: '訴状（少額訴訟用・売買代金）', origin: '原告は令和〇年〇月〇日、フリマアプリを通じて被告から商品を代金〇〇円で購入し代金を支払ったが、商品が引き渡されない（または説明と著しく異なる）。原告は返金を求めたが、被告はこれに応じない。' },
    wage:      { caseName: '未払賃金請求事件',          form: '訴状（少額訴訟用・汎用）',     origin: '原告は被告に雇用されて勤務したが、令和〇年〇月分の賃金〇〇円が支払期日を経過しても支払われていない。' },
    damage:    { caseName: '損害賠償請求事件',          form: '訴状（少額訴訟用・汎用）',     origin: '被告は令和〇年〇月〇日、原告所有の物品を破損させた。その修理に要する費用は金〇〇円であり、原告は被告に対し損害賠償を請求したが、被告は支払わない。' },
    other:     { caseName: '金銭請求事件',              form: '訴状（少額訴訟用・汎用）',     origin: '原告は被告に対し、金〇〇円の支払を求める債権を有しているが、被告は支払期日を経過しても支払わない。' },
  };

  function buildFallbackComplaint(caseType) {
    const c = caseComplaintFallback[caseType] || caseComplaintFallback.other;
    return {
      title: c.caseName + '　訴状（記入例）',
      intro: '以下は「' + c.caseName + '」を例にした訴状の書き方の見本です。氏名・金額・日付はすべて伏せた架空の見本（金〇〇円・令和〇年〇月〇日）ですので、ご自身の事案の実際の数字に置き換えてご記入ください。',
      recommendedForm: c.form,
      fields: [
        { label: '当事者の表示', example: '原告　山田　太郎（住所・連絡先）／被告　佐藤　次郎（住所）', hint: 'ご自身（原告）と相手方（被告）の氏名・住所を正確に記載します。相手方が法人の場合は商号と代表者名を記載します。' },
        { label: '事件名', example: c.caseName, hint: '請求の内容に応じた事件名を記載します。記入例の表現をそのまま使えることが多いです。' },
        { label: '請求の趣旨', example: '1　被告は原告に対し、金〇〇円及びこれに対する令和〇年〇月〇日から支払済みまで年3パーセントの割合による金員を支払え。\n2　訴訟費用は被告の負担とする。\nとの判決並びに仮執行の宣言を求める。', hint: '求める判決の結論を書きます。金額・起算日はご自身の事案の数字に置き換えてください。' },
        { label: '紛争の要点（請求の原因）', example: c.origin, hint: 'いつ・誰と・どのような約束で・いくらの債権が生じ、なぜ支払われていないのかを、時系列で簡潔に記載します。' },
        { label: '添付書類・証拠', example: '契約書写し　1通、振込明細写し　1通、催告書（内容証明郵便）写し　1通　など', hint: 'お手元の証拠（契約書・メッセージ・振込明細等）を一覧にします。証拠説明書を併せて作成すると分かりやすくなります。' },
        { label: '少額訴訟による審理を求める旨', example: '本件は少額訴訟による審理及び裁判を求めます。本年、少額訴訟による審理を求めるのは　〇　回目です。', hint: '少額訴訟を希望する旨と、その年の利用回数（同一裁判所で年10回まで）を記載します。' },
        { label: '日付・提出先・署名', example: '令和〇年〇月〇日　　○○簡易裁判所　御中　　原告　山田　太郎　㊞', hint: '作成日、提出先の簡易裁判所名、ご自身の記名押印を記載します。提出先は前項の管轄裁判所の案内をご確認ください。' },
      ],
      note: '実際の提出時は、裁判所が用意している「少額訴訟」用の定型訴状用紙（上記のおすすめ様式）を利用すると記入しやすくなります。用紙は提出先の簡易裁判所の窓口や裁判所公式サイトで入手できます。',
    };
  }

  function buildFallbackCourt(answers) {
    const loc = answers.location || {};
    const p = (loc.plaintiff || '').trim();
    const d = (loc.defendant || '').trim();
    const inc = (loc.incident || '').trim();

    const candidates = [];
    candidates.push({
      name: p ? (p + 'を管轄する簡易裁判所') : 'お住まいの市区町村を管轄する簡易裁判所',
      basis: '義務履行地（あなたの住所地）／民事訴訟法5条1号・民法484条',
    });
    if (d) {
      candidates.push({
        name: d + 'を管轄する簡易裁判所',
        basis: '相手方の住所地（普通裁判籍）／民事訴訟法4条',
      });
    }
    if (answers.caseType === 'damage' && inc) {
      candidates.push({
        name: inc + 'を管轄する簡易裁判所',
        basis: '不法行為地／民事訴訟法5条9号',
      });
    }

    return {
      candidates: candidates,
      explanation: '金銭の支払を求める請求は、原則として持参債務（民法484条）にあたるため、相手方の住所地だけでなく、ご自身（債権者）の住所地を管轄する簡易裁判所にも申し立てることができます（民事訴訟法5条1号）。複数の候補がある場合、ご自身が通いやすい裁判所を選べます。',
      verifyUrl: 'https://www.courts.go.jp/saiban/tetuzuki/kankatu/index.html',
      verifyNote: '具体的な提出先は、上記の裁判所公式サイト「裁判所の管轄区域」で、住所（市区町村）から担当の簡易裁判所をご確認ください。',
    };
  }

  function buildFallbackProcedure() {
    return [
      { title: '1. 訴状用紙・添付書類を入手する', detail: '管轄の簡易裁判所の窓口、または裁判所公式サイトから「少額訴訟」用の訴状用紙と記載例を入手します。' },
      { title: '2. 訴状を記入する', detail: '上の記入例を参考に、当事者・請求の趣旨・紛争の要点などをご自身の事案に合わせて記入します。' },
      { title: '3. 証拠書類を準備する', detail: '契約書・メッセージ・振込明細などの証拠の写しを揃え、必要に応じて証拠説明書を作成します。正本・写しの部数にご注意ください。' },
      { title: '4. 手数料と郵便切手を準備する', detail: '請求額に応じた収入印紙（申立手数料）と、予納郵便切手を準備します（下記「費用の目安」参照）。' },
      { title: '5. 簡易裁判所へ提出する', detail: '管轄の簡易裁判所の窓口または郵送で訴状一式を提出します。受付で内容の確認を受けられます。' },
      { title: '6. 審理期日に出頭する', detail: '裁判所から期日呼出状が届きます。少額訴訟は原則として1回の期日で審理が行われます。証拠を持参して臨みます。' },
      { title: '7. 判決・和解、必要なら強制執行', detail: '判決または和解で結論が出ます。相手方が支払わない場合は、判決等を債務名義として強制執行を検討できます。' },
    ];
  }

  function computeStampFee(amount) {
    // 訴額10万円までごとに1,000円（民事訴訟費用等に関する法律・別表第一の目安）
    if (!amount || amount <= 0) return 1000;
    return Math.ceil(amount / 100000) * 1000;
  }

  function buildFallbackCosts(amount) {
    const fee = computeStampFee(amount || 0);
    const amtLabel = amount ? ('請求額 ' + amount.toLocaleString('ja-JP') + '円の場合、') : '';
    return {
      stampFee: amtLabel + '申立手数料（収入印紙）は概ね ' + fee.toLocaleString('ja-JP') + '円程度（訴額10万円ごとに約1,000円が目安）',
      postage: '予納郵便切手は概ね3,000〜5,000円程度（裁判所・当事者数により異なります）',
      note: 'いずれも目安です。正確な金額・切手の内訳は、提出先の簡易裁判所でご確認ください。',
    };
  }

  // ============================================
  // ナビゲーション
  // ============================================
  function getCurrentStep() {
    return STEPS[state.currentIdx];
  }

  function getStepEl(name) {
    return document.querySelector('.diag-step[data-step="' + name + '"]');
  }

  function showStep(name) {
    document.querySelectorAll('.diag-step').forEach(function (el) { el.classList.remove('active'); });
    const target = getStepEl(name);
    if (!target) return;
    target.classList.add('active');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    updateProgress();
  }

  function updateProgress() {
    const step = getCurrentStep();
    const wrap = document.getElementById('progressWrap');
    if (Q_STEPS.indexOf(step) === -1) {
      wrap.style.opacity = '0';
      wrap.style.pointerEvents = 'none';
      wrap.style.maxHeight = '0';
      wrap.style.marginBottom = '0';
      wrap.style.overflow = 'hidden';
    } else {
      wrap.style.opacity = '1';
      wrap.style.pointerEvents = 'auto';
      wrap.style.maxHeight = '';
      wrap.style.marginBottom = '';
      wrap.style.overflow = '';
      const qNum = Q_STEPS.indexOf(step) + 1;
      document.getElementById('stepCounter').textContent = 'STEP ' + qNum + ' / ' + Q_STEPS.length;
      document.getElementById('progressBar').style.width = (qNum / Q_STEPS.length) * 100 + '%';
    }
  }

  // ============================================
  // オプション選択
  // ============================================
  function isMultiSelect(stepEl) {
    return stepEl.querySelector('[data-multi]') !== null;
  }

  function checkCanProceed() {
    const stepEl = getStepEl(getCurrentStep());
    if (!stepEl) return;
    const nextBtn = stepEl.querySelector('[data-action="next"]');
    if (!nextBtn) return;

    const question = stepEl.dataset.question;
    if (!question) return;

    let hasAnswer;
    if (question === 'location') {
      const loc = state.answers.location;
      hasAnswer = !!(loc && typeof loc.plaintiff === 'string' && loc.plaintiff.trim().length > 0);
    } else {
      const ans = state.answers[question];
      hasAnswer = Array.isArray(ans) ? ans.length > 0 : (ans !== null && ans !== undefined && ans !== '');
    }
    nextBtn.disabled = !hasAnswer;
  }

  function handleOptionClick(btn) {
    const stepEl = btn.closest('.diag-step');
    if (!stepEl) return;
    const question = stepEl.dataset.question;
    const value = btn.dataset.value;
    const multi = isMultiSelect(stepEl);

    if (multi) {
      if (!Array.isArray(state.answers[question])) state.answers[question] = [];
      const arr = state.answers[question];

      if (value === 'none') {
        state.answers[question] = arr.includes('none') ? [] : ['none'];
        stepEl.querySelectorAll('.diag-option').forEach(function (b) {
          if (b === btn) b.classList.toggle('selected', state.answers[question].includes('none'));
          else b.classList.remove('selected');
        });
      } else {
        if (arr.includes('none')) {
          state.answers[question] = arr.filter(function (v) { return v !== 'none'; });
          const noneBtn = stepEl.querySelector('[data-value="none"]');
          if (noneBtn) noneBtn.classList.remove('selected');
        }
        const currArr = state.answers[question];
        const idx = currArr.indexOf(value);
        if (idx >= 0) {
          currArr.splice(idx, 1);
          btn.classList.remove('selected');
        } else {
          currArr.push(value);
          btn.classList.add('selected');
        }
      }
    } else {
      stepEl.querySelectorAll('.diag-option').forEach(function (b) { b.classList.remove('selected'); });
      btn.classList.add('selected');
      state.answers[question] = value;
    }

    checkCanProceed();
  }

  // ============================================
  // 金額自由入力ハンドラ
  // ============================================
  function setupAmountInput() {
    const input = document.getElementById('amountInput');
    const preview = document.getElementById('amountPreview');
    const warning = document.getElementById('amountWarning');
    if (!input) return;

    function update() {
      const raw = input.value.trim();
      const val = parseInt(raw, 10);

      if (!raw || isNaN(val) || val <= 0) {
        state.answers.amount = null;
        preview.textContent = '';
        warning.textContent = '';
        warning.className = 'diag-amount-warning';
      } else if (val > 100000000) {
        state.answers.amount = null;
        preview.textContent = '';
        warning.textContent = '⚠ 金額が大きすぎます。1億円以下で入力してください。';
        warning.className = 'diag-amount-warning warn';
      } else {
        state.answers.amount = val;
        preview.textContent = '¥' + val.toLocaleString('ja-JP');
        if (val > 600000) {
          warning.textContent = '⚠ 60万円超は少額訴訟の対象外です（通常訴訟手続きをご検討ください）';
          warning.className = 'diag-amount-warning warn';
        } else if (val < 10000) {
          warning.textContent = '※ 印紙代等の実費との兼ね合いをご検討ください';
          warning.className = 'diag-amount-warning info';
        } else {
          warning.textContent = '';
          warning.className = 'diag-amount-warning';
        }
      }
      checkCanProceed();
    }

    input.addEventListener('input', update);
    input.addEventListener('change', update);

    if (typeof state.answers.amount === 'number') {
      input.value = state.answers.amount;
      update();
    }
  }

  // ============================================
  // 所在地（管轄判定用）入力ハンドラ
  // ============================================
  function setupLocationInput() {
    const pEl = document.getElementById('locPlaintiff');
    const dEl = document.getElementById('locDefendant');
    const iEl = document.getElementById('locIncident');
    if (!pEl) return;

    function update() {
      const loc = {
        plaintiff: pEl.value.trim(),
        defendant: dEl ? dEl.value.trim() : '',
        incident: iEl ? iEl.value.trim() : '',
      };
      state.answers.location = loc;
      checkCanProceed();
    }

    [pEl, dEl, iEl].forEach(function (el) {
      if (!el) return;
      el.addEventListener('input', update);
      el.addEventListener('change', update);
    });

    // 既存の入力値を復元
    const loc = state.answers.location;
    if (loc) {
      if (typeof loc.plaintiff === 'string') pEl.value = loc.plaintiff;
      if (dEl && typeof loc.defendant === 'string') dEl.value = loc.defendant;
      if (iEl && typeof loc.incident === 'string') iEl.value = loc.incident;
    }
    update();
  }

  // ============================================
  // アクション処理
  // ============================================
  function handleAction(action) {
    if (action === 'start') {
      state.currentIdx = STEPS.indexOf('q1');
      showStep('q1');
      checkCanProceed();
    } else if (action === 'next') {
      if (state.currentIdx < STEPS.length - 1) {
        state.currentIdx++;
        const next = getCurrentStep();
        if (next === 'q2') {
          showStep(next);
          setupAmountInput();
          checkCanProceed();
        } else if (next === 'q7') {
          showStep(next);
          setupLocationInput();
          checkCanProceed();
        } else if (next === 'loading') {
          showStep('loading');
          runAnalysis();
        } else {
          showStep(next);
          checkCanProceed();
        }
      }
    } else if (action === 'back') {
      if (state.currentIdx > 0) {
        state.currentIdx--;
        const prev = getCurrentStep();
        showStep(prev);
        if (prev === 'q2') setupAmountInput();
        if (prev === 'q7') setupLocationInput();
        checkCanProceed();
      }
    } else if (action === 'restart') {
      state.currentIdx = 0;
      state.answers = {};
      state.lastResult = null;
      document.querySelectorAll('.diag-option.selected').forEach(function (b) { b.classList.remove('selected'); });
      document.querySelectorAll('[data-action="next"]').forEach(function (b) { b.disabled = true; });
      const amountInput = document.getElementById('amountInput');
      if (amountInput) amountInput.value = '';
      const amountPreview = document.getElementById('amountPreview');
      if (amountPreview) amountPreview.textContent = '';
      const amountWarning = document.getElementById('amountWarning');
      if (amountWarning) {
        amountWarning.textContent = '';
        amountWarning.className = 'diag-amount-warning';
      }
      ['locPlaintiff', 'locDefendant', 'locIncident'].forEach(function (id) {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });
      showStep('welcome');
    }
  }

  // ============================================
  // AI診断実行
  // ============================================
  async function runAnalysis() {
    const loadingText = document.getElementById('loadingText');
    const loadingSub = document.getElementById('loadingSub');

    const messages = [
      ['過去の判例を照合中...', 'あなたのケースに類似する過去の事例を検索しています'],
      ['証拠の強度を評価中...', '提示された証拠が訴訟で認められやすいかを分析しています'],
      ['法令と判例傾向を分析中...', '適用条文と類似事例の傾向を整理しています'],
      ['回収可能性を計算中...', '請求額と相手方の状況から、見込み額を算出しています'],
    ];
    let i = 0;
    loadingText.textContent = messages[0][0];
    loadingSub.textContent = messages[0][1];
    const interval = setInterval(function () {
      i = (i + 1) % messages.length;
      loadingText.textContent = messages[i][0];
      loadingSub.textContent = messages[i][1];
    }, 1400);

    let result = null;
    let usedAi = false;

    if (API_ENDPOINT) {
      try {
        result = await callDiagnoseAPI(state.answers);
        usedAi = true;
      } catch (err) {
        console.warn('AI診断APIが利用できないため、簡易診断にフォールバックします:', err && err.message);
        loadingText.textContent = '簡易診断に切り替えています...';
        loadingSub.textContent = 'AIサーバーに接続できないため、簡易ロジックで診断します';
        await new Promise(function (r) { setTimeout(r, 1000); });
      }
    }

    if (!result) {
      result = computeHeuristicResult(state.answers);
    }

    clearInterval(interval);
    state.lastResult = result;
    renderResult(result, usedAi);

    state.currentIdx = STEPS.indexOf('result');
    showStep('result');
  }

  function callDiagnoseAPI(answers) {
    const controller = new AbortController();
    const timeoutId = setTimeout(function () { controller.abort(); }, API_TIMEOUT_MS);

    return fetch(API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        caseType: answers.caseType,
        amount: answers.amount,
        time: answers.time,
        evidence: answers.evidence || [],
        defendant: answers.defendant,
        communication: answers.communication,
        location: answers.location || null,
      }),
      signal: controller.signal,
    }).then(async function (resp) {
      clearTimeout(timeoutId);
      if (!resp.ok) {
        let detail = '';
        try {
          const body = await resp.json();
          detail = body && body.message ? body.message : ('HTTP ' + resp.status);
        } catch (_) {
          detail = 'HTTP ' + resp.status;
        }
        throw new Error(detail);
      }
      return resp.json();
    }).catch(function (err) {
      clearTimeout(timeoutId);
      throw err;
    });
  }

  // ============================================
  // ヒューリスティック診断（フォールバック）
  // ============================================
  function scoreAmount(amount) {
    if (amount < 10000) return { score: -10, reason: '請求額が小さく、印紙代等の実費負担との兼ね合いをご検討ください' };
    if (amount < 100000) return { score: 5, reason: '少額訴訟の典型的な金額帯で、手続きを進めやすい範囲です' };
    if (amount < 300000) return { score: 10, reason: '訴訟費用対効果が高く、回収できれば大きなリターンが期待できます' };
    if (amount <= 600000) return { score: 6, reason: '少額訴訟の上限に近く、回収成功時の経済効果が大きい範囲です' };
    return { score: -60, reason: '60万円超は少額訴訟の対象外です。通常訴訟手続きをご検討ください', outOfScope: true };
  }

  function scoreToType(s) {
    if (s >= 5) return 'pos';
    if (s <= -5) return 'neg';
    return 'neu';
  }

  function computeHeuristicResult(answers) {
    let score = 50;
    const reasons = [];

    function apply(data) {
      if (!data) return;
      score += data.score;
      reasons.push({ type: scoreToType(data.score), text: data.reason });
    }

    apply(caseTypeFallback[answers.caseType]);

    const amtData = scoreAmount(answers.amount || 0);
    apply(amtData);

    apply(timeFallback[answers.time]);

    const evs = answers.evidence || [];
    evs.forEach(function (ev) { apply(evidenceFallback[ev]); });

    apply(defendantFallback[answers.defendant]);
    apply(commFallback[answers.communication]);

    const isOutOfScope = !!amtData.outOfScope;
    score = isOutOfScope ? 0 : Math.max(5, Math.min(98, Math.round(score)));

    let verdict, verdictDesc, verdictClass;
    if (isOutOfScope) {
      verdict = '対象外';
      verdictDesc = 'ご請求金額は60万円を超えるため、少額訴訟の対象外となります。通常訴訟手続きでの対応をご検討ください。';
      verdictClass = 'low';
    } else if (score >= 70) {
      verdict = '勝ち目あり';
      verdictDesc = '過去の類似判例の傾向から、勝訴・回収の見込みが十分にあります。早めに手続きを進めることをおすすめします。';
      verdictClass = 'high';
    } else if (score >= 45) {
      verdict = '十分検討の価値あり';
      verdictDesc = '勝訴の見込みはありますが、いくつか強化したい要素があります。証拠の補強や事前の準備で確度を高められる可能性があります。';
      verdictClass = 'med';
    } else {
      verdict = '慎重な検討が必要';
      verdictDesc = '現状の情報のままでは、訴訟提起にリスクが伴います。証拠の補強や、他の解決手段もご検討ください。';
      verdictClass = 'low';
    }

    const winRate = score / 100;
    const base = answers.amount || 0;
    const estimated = isOutOfScope ? 0 : Math.round(base * winRate);
    const net = Math.max(0, estimated - SERVICE_FEE);

    return {
      score: score,
      verdict: verdict,
      verdictDesc: verdictDesc,
      verdictClass: verdictClass,
      winRate: winRate,
      estimatedAmount: net,
      reasons: reasons,
      precedents: fallbackPrecedents[answers.caseType] || fallbackPrecedents.other,
      outOfScope: isOutOfScope,
      outOfScopeReason: isOutOfScope ? '60万円を超える金額は少額訴訟の対象外です。通常訴訟手続きでの対応をご検討ください。' : null,
      legalBasis: null,
      courtGuidance: buildFallbackCourt(answers),
      complaintSample: buildFallbackComplaint(answers.caseType),
      procedureSteps: buildFallbackProcedure(),
      costs: buildFallbackCosts(answers.amount),
    };
  }

  // ============================================
  // 結果レンダリング
  // ============================================
  function classifyVerdict(verdict, score, outOfScope) {
    if (outOfScope || verdict === '対象外') return 'low';
    if (score >= 70 || verdict === '勝ち目あり') return 'high';
    if (score >= 45 || verdict === '十分検討の価値あり') return 'med';
    return 'low';
  }

  function renderResult(result, fromAi) {
    const verdictClass = result.verdictClass || classifyVerdict(result.verdict, result.score, result.outOfScope);

    const verdictBox = document.getElementById('verdictBox');
    verdictBox.className = 'diag-verdict ' + verdictClass;

    const tagEl = document.getElementById('verdictTag');
    const tagLabels = { high: 'High Chance', med: 'Moderate', low: result.outOfScope ? 'Out of Scope' : 'Needs Review' };
    tagEl.textContent = tagLabels[verdictClass] || 'AI Diagnosis';
    tagEl.className = 'diag-verdict-tag ' + verdictClass;

    document.getElementById('verdictTitle').textContent = result.verdict || '診断結果';
    document.getElementById('verdictDesc').textContent = result.verdictDesc || '';

    const gaugeArc = document.getElementById('gaugeArc');
    gaugeArc.style.strokeDashoffset = ARC_LENGTH;
    if (verdictClass === 'high') gaugeArc.style.stroke = '#0FB888';
    else if (verdictClass === 'med') gaugeArc.style.stroke = '#FF5B49';
    else gaugeArc.style.stroke = '#16182C99';

    setTimeout(function () {
      gaugeArc.style.strokeDashoffset = ARC_LENGTH * (1 - (result.score || 0) / 100);
      animateCount(document.getElementById('scoreValue'), 0, result.score || 0, 1200);
    }, 250);

    const legalSection = document.getElementById('legalBasisSection');
    const legalText = document.getElementById('legalBasisText');
    if (result.legalBasis && result.legalBasis.trim()) {
      legalText.textContent = result.legalBasis;
      legalSection.hidden = false;
    } else {
      legalSection.hidden = true;
    }

    const reasonsList = document.getElementById('reasonsList');
    reasonsList.innerHTML = '';
    (result.reasons || []).forEach(function (r) {
      const li = document.createElement('li');
      const mark = r.type === 'pos' ? '+' : r.type === 'neg' ? '−' : '!';
      const iconSpan = document.createElement('span');
      iconSpan.className = 'diag-r-icon ' + r.type;
      iconSpan.textContent = mark;
      const textSpan = document.createElement('span');
      textSpan.textContent = r.text;
      li.appendChild(iconSpan);
      li.appendChild(textSpan);
      reasonsList.appendChild(li);
    });

    const net = Math.max(0, result.estimatedAmount || 0);
    document.getElementById('estimateAmount').textContent = '¥' + net.toLocaleString('ja-JP');
    const rangeEl = document.getElementById('estimateRange');
    if (result.outOfScope) {
      rangeEl.textContent = result.outOfScopeReason || '本ケースは少額訴訟の対象外です';
    } else if (net > 0) {
      const lower = Math.round(net * 0.7).toLocaleString('ja-JP');
      const upper = Math.round(net * 1.0).toLocaleString('ja-JP');
      rangeEl.textContent = '見込みレンジ：¥' + lower + ' 〜 ¥' + upper;
    } else {
      rangeEl.textContent = '本ケースでは、現状の情報からの試算が困難な状況です';
    }

    const precedentsList = document.getElementById('precedentsList');
    precedentsList.innerHTML = '';
    (result.precedents || []).forEach(function (p) {
      const wrap = document.createElement('div');
      wrap.className = 'diag-precedent';

      const meta = document.createElement('div');
      meta.className = 'diag-precedent-meta';
      meta.textContent = p.meta;

      const title = document.createElement('div');
      title.className = 'diag-precedent-title';
      title.textContent = p.title;

      const r = document.createElement('div');
      r.className = 'diag-precedent-result';
      r.textContent = p.result;

      wrap.appendChild(meta);
      wrap.appendChild(title);
      wrap.appendChild(r);

      // 事件番号（実在が確実な判例のみ表示。「特定の公開判例番号なし」等の場合は表示しない）
      if (p.caseNumber && p.caseNumber.indexOf('特定の公開判例番号なし') === -1 && p.caseNumber.indexOf('なし') === -1) {
        const cn = document.createElement('div');
        cn.className = 'diag-precedent-casenumber';
        const lbl = document.createElement('span');
        lbl.className = 'diag-precedent-casenumber-label';
        lbl.textContent = '事件番号 ';
        cn.appendChild(lbl);
        cn.appendChild(document.createTextNode(p.caseNumber));
        wrap.appendChild(cn);
      }

      precedentsList.appendChild(wrap);
    });

    // 判例の確認用リンク（裁判所 判例検索）
    const precNote = document.createElement('p');
    precNote.className = 'diag-precedent-verify';
    precNote.appendChild(document.createTextNode('※ 判例の内容・事件番号は'));
    const precLink = document.createElement('a');
    precLink.href = HANREI_SEARCH_URL;
    precLink.target = '_blank';
    precLink.rel = 'noopener';
    precLink.textContent = '裁判所「判例検索」';
    precNote.appendChild(precLink);
    precNote.appendChild(document.createTextNode('で原典をご確認ください。事件番号の記載がないものは、特定の公開判例ではなく類型的な傾向を示しています。'));
    precedentsList.appendChild(precNote);

    renderCourtGuidance(result.courtGuidance);
    renderComplaintSample(result.complaintSample);
    renderProcedureSteps(result.procedureSteps);
    renderCosts(result.costs);

    const sourceEl = document.getElementById('sourceIndicator');
    if (sourceEl) {
      if (fromAi) {
        sourceEl.textContent = '⚡ Claude Opus 4.7 による判例ベース診断・手続き情報の提示';
        sourceEl.className = 'diag-source-indicator ai';
      } else {
        sourceEl.textContent = '◆ 簡易ロジックによる診断・手続き情報の提示（AI接続不可）';
        sourceEl.className = 'diag-source-indicator fallback';
      }
    }

    // 申し込みページに引き継ぐため診断内容を保存
    try {
      sessionStorage.setItem('lastDiagnosisResult', JSON.stringify(result));
      sessionStorage.setItem('lastDiagnosisAnswers', JSON.stringify(state.answers));
    } catch (_) {
      // sessionStorageが使えない場合は無視
    }
  }

  // ---- 管轄裁判所 ----
  function renderCourtGuidance(court) {
    const section = document.getElementById('courtSection');
    if (!section) return;
    if (!court || !Array.isArray(court.candidates)) {
      section.hidden = true;
      return;
    }
    const list = document.getElementById('courtCandidates');
    list.innerHTML = '';
    court.candidates.forEach(function (c) {
      const item = document.createElement('div');
      item.className = 'diag-court-candidate';
      const name = document.createElement('div');
      name.className = 'diag-court-name';
      name.textContent = c.name || '';
      const basis = document.createElement('div');
      basis.className = 'diag-court-basis';
      basis.textContent = c.basis || '';
      item.appendChild(name);
      item.appendChild(basis);
      list.appendChild(item);
    });

    const expl = document.getElementById('courtExplanation');
    expl.textContent = court.explanation || '';

    const verify = document.getElementById('courtVerify');
    verify.innerHTML = '';
    if (court.verifyNote || court.verifyUrl) {
      const note = document.createElement('span');
      note.textContent = court.verifyNote || '裁判所公式サイトで管轄区域をご確認ください。';
      verify.appendChild(note);
      verify.appendChild(document.createElement('br'));
      const a = document.createElement('a');
      a.href = court.verifyUrl || COURT_KANKATSU_URL;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = '▸ 裁判所「管轄区域」で担当裁判所を確認する';
      verify.appendChild(a);
    }

    // 提出先の簡易裁判所の「場所」を一覧で確認できる参考リンク（固定）
    const locRef = document.getElementById('courtLocationRef');
    if (locRef) {
      locRef.innerHTML = '';
      const note = document.createElement('span');
      note.className = 'diag-court-locationref-note';
      note.textContent = '📍 提出先となる簡易裁判所の所在地・アクセスは、全国の裁判所所在地一覧でご確認いただけます。';
      locRef.appendChild(note);
      locRef.appendChild(document.createElement('br'));
      const a2 = document.createElement('a');
      a2.href = COURT_LOCATION_PDF_URL;
      a2.target = '_blank';
      a2.rel = 'noopener';
      a2.textContent = '▸ 全国の裁判所所在地一覧（裁判所データブック2024・PDF）';
      locRef.appendChild(a2);
    }

    section.hidden = false;
  }

  // ---- 訴状の記入例 ----
  function renderComplaintSample(sample) {
    const section = document.getElementById('complaintSection');
    if (!section) return;
    if (!sample || !Array.isArray(sample.fields)) {
      section.hidden = true;
      return;
    }
    document.getElementById('complaintTitle').textContent = sample.title || '訴状の記入例';
    document.getElementById('complaintIntro').textContent = sample.intro || '';

    // おすすめの訴状様式 + 裁判所の書式入手リンク（固定）
    const formRef = document.getElementById('complaintFormRef');
    if (formRef) {
      formRef.innerHTML = '';
      if (sample.recommendedForm) {
        const rec = document.createElement('div');
        rec.className = 'diag-complaint-form-rec';
        const lbl = document.createElement('span');
        lbl.className = 'diag-complaint-form-label';
        lbl.textContent = 'おすすめの訴状様式';
        const val = document.createElement('span');
        val.className = 'diag-complaint-form-name';
        val.textContent = sample.recommendedForm;
        rec.appendChild(lbl);
        rec.appendChild(val);
        formRef.appendChild(rec);
      }
      const link = document.createElement('a');
      link.className = 'diag-complaint-form-link';
      link.href = SHOJO_FORM_LIST_URL;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = '▸ 裁判所「少額訴訟の訴状書式」から様式（Word）と記載例を入手する';
      formRef.appendChild(link);
    }

    const fieldsEl = document.getElementById('complaintFields');
    fieldsEl.innerHTML = '';
    sample.fields.forEach(function (f) {
      const row = document.createElement('div');
      row.className = 'diag-complaint-field';

      const label = document.createElement('div');
      label.className = 'diag-complaint-label';
      label.textContent = f.label || '';

      const example = document.createElement('div');
      example.className = 'diag-complaint-example';
      example.textContent = f.example || '';

      row.appendChild(label);
      row.appendChild(example);

      if (f.hint) {
        const hint = document.createElement('div');
        hint.className = 'diag-complaint-hint';
        hint.textContent = '記入のポイント：' + f.hint;
        row.appendChild(hint);
      }
      fieldsEl.appendChild(row);
    });

    const noteEl = document.getElementById('complaintNote');
    noteEl.textContent = sample.note || '';
    section.hidden = false;
  }

  // ---- 手続きの流れ ----
  function renderProcedureSteps(steps) {
    const section = document.getElementById('procedureSection');
    if (!section) return;
    if (!Array.isArray(steps) || steps.length === 0) {
      section.hidden = true;
      return;
    }
    const list = document.getElementById('procedureList');
    list.innerHTML = '';
    steps.forEach(function (s) {
      const li = document.createElement('li');
      const title = document.createElement('div');
      title.className = 'diag-procedure-title';
      title.textContent = s.title || '';
      const detail = document.createElement('div');
      detail.className = 'diag-procedure-detail';
      detail.textContent = s.detail || '';
      li.appendChild(title);
      li.appendChild(detail);
      list.appendChild(li);
    });
    section.hidden = false;
  }

  // ---- 費用の目安 ----
  function renderCosts(costs) {
    const section = document.getElementById('costsSection');
    if (!section) return;
    if (!costs) {
      section.hidden = true;
      return;
    }
    const grid = document.getElementById('costsGrid');
    grid.innerHTML = '';
    const items = [
      { label: '申立手数料（収入印紙）', value: costs.stampFee },
      { label: '予納郵便切手', value: costs.postage },
    ];
    items.forEach(function (it) {
      if (!it.value) return;
      const row = document.createElement('div');
      row.className = 'diag-costs-item';
      const lbl = document.createElement('div');
      lbl.className = 'diag-costs-label';
      lbl.textContent = it.label;
      const val = document.createElement('div');
      val.className = 'diag-costs-value';
      val.textContent = it.value;
      row.appendChild(lbl);
      row.appendChild(val);
      grid.appendChild(row);
    });
    document.getElementById('costsNote').textContent = costs.note || '';
    section.hidden = false;
  }

  function animateCount(el, from, to, duration) {
    const start = performance.now();
    function frame(now) {
      const t = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      const val = Math.round(from + (to - from) * eased);
      el.textContent = val;
      if (t < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  // ============================================
  // 初期化
  // ============================================
  function init() {
    document.addEventListener('click', function (e) {
      const opt = e.target.closest('.diag-option');
      if (opt) {
        handleOptionClick(opt);
        return;
      }
      const actionEl = e.target.closest('[data-action]');
      if (actionEl) {
        handleAction(actionEl.dataset.action);
      }
    });

    updateProgress();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
