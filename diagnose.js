(function () {
  'use strict';

  // ============================================
  // トリカエス ヒアリング・ウィザード（toB：弁護士事務所向け訴状作成）
  // 設定駆動。caseType に応じて質問を動的に構築する。
  // 入力完了後は answers を sessionStorage に保存し apply.html へ遷移する。
  // （旧：AIスコア診断・結果表示・ぼかし課金は廃止）
  // ============================================

  var state = {
    idx: 0,            // 0 = welcome、1以降 = questions[idx-1]
    answers: {},
    questions: [],
  };

  // ---- 事件類型 ----
  var CASE_TYPES = [
    { value: 'loan', icon: '💴', text: '個人間の金銭貸借（貸したお金が返らない）' },
    { value: 'deposit', icon: '🏠', text: '敷金・保証金の返還' },
    { value: 'freelance', icon: '🧾', text: '業務委託・フリーランスの未払い報酬' },
    { value: 'online', icon: '📦', text: 'ネット取引・フリマアプリ取引トラブル' },
    { value: 'wage', icon: '👔', text: '給与・残業代の未払い' },
    { value: 'damage', icon: '🛠', text: '物品の損害・破損賠償' },
    { value: 'other', icon: '⚖️', text: 'その他の金銭請求' },
  ];

  var CASE_TYPE_LABELS = {
    loan: '個人間の金銭貸借', deposit: '敷金・保証金の返還', freelance: '業務委託・フリーランス報酬',
    online: 'ネット取引・フリマ', wage: '給与・残業代未払い', damage: '物品損害・賠償', other: 'その他の金銭請求',
  };

  // ============================================
  // 質問定義
  //  type: single | multi | amount | text | textarea | date | group
  //  group は fields[{id,label,type,placeholder,required,options}] を持ち、answers[id]={fieldId:value}
  // ============================================

  // q0: 事件類型（常に最初）
  var Q_CASETYPE = {
    id: 'caseType', type: 'single', title: 'どのようなトラブルですか？',
    sub: '請求したい内容に最も近いものを1つ選んでください。これに応じて確認項目が変わります。',
    required: true, options: CASE_TYPES,
  };

  // 共通項目（caseType の後に続く）
  var COMMON = [
    {
      id: 'amount', type: 'amount', title: '請求したい金額（元金）はいくらですか',
      sub: '円単位でご入力ください。少額訴訟の対象は60万円以下です（超える場合は通常訴訟をご案内します）。', required: true,
    },
    {
      id: 'amountBreakdown', type: 'textarea', title: '請求金額の内訳・算定根拠',
      sub: '元金・遅延損害金・その他の内訳や、その金額になった根拠をご記入ください（例：貸付元金30万円＋約定利息など）。', required: true,
      placeholder: '例：貸付元金 300,000円。利息の約定はなし。', maxlength: 1000,
    },
    {
      id: 'plaintiff', type: 'group', title: '原告（申立人＝ご相談者）の情報',
      sub: '訴状に記載する正確な情報をご入力ください。', required: true,
      fields: [
        { id: 'name', label: '氏名（フルネーム）', type: 'text', placeholder: '例：山田 太郎', required: true, maxlength: 100 },
        { id: 'address', label: '住所', type: 'text', placeholder: '例：東京都世田谷区〇〇1-2-3', required: true, maxlength: 200 },
        { id: 'phone', label: '電話番号', type: 'text', placeholder: '例：090-1234-5678', required: false, maxlength: 30 },
      ],
    },
    {
      id: 'defendantInfo', type: 'group', title: '被告（相手方）の情報',
      sub: '分かる範囲で正確にご入力ください。法人の場合は商号と代表者名も記載します。', required: true,
      fields: [
        { id: 'kind', label: '個人／法人', type: 'select', required: true, options: [
          { value: '個人', text: '個人' }, { value: '法人・店舗', text: '法人・店舗' } ] },
        { id: 'name', label: '氏名／商号', type: 'text', placeholder: '例：佐藤 次郎 ／ 株式会社〇〇', required: true, maxlength: 100 },
        { id: 'rep', label: '代表者名（法人の場合）', type: 'text', placeholder: '例：代表取締役 〇〇', required: false, maxlength: 100 },
        { id: 'address', label: '住所（所在地）', type: 'text', placeholder: '例：神奈川県横浜市〇〇 ／ 不明', required: true, maxlength: 200 },
      ],
    },
    {
      id: 'timeline', type: 'textarea', title: '事実経過（時系列）',
      sub: 'いつ・誰が・何を・どうしたか、トラブルの経緯を時系列でできるだけ具体的にご記入ください。訴状の「請求の原因」の基礎になります。', required: true,
      placeholder: '例：令和5年5月1日、知人の被告に生活費として現金30万円を手渡しで貸した。返済期日は同年8月末と口頭で約束。期日を過ぎても返済がなく、9月にLINEで督促したが応じない。', maxlength: 3000,
    },
    {
      id: 'time', type: 'single', title: 'トラブル（債権の発生）からどのくらい経ちましたか？',
      sub: '消滅時効の判断に使います。', required: true,
      options: [
        { value: 'lt1y', text: '1年未満' }, { value: '1-3y', text: '1〜3年' },
        { value: '3-5y', text: '3〜5年' }, { value: '5-10y', text: '5〜10年（時効に注意）' },
        { value: 'gt10y', text: '10年以上前（時効の可能性大）' },
      ],
    },
    {
      id: 'evidence', type: 'multi', title: '手元にある証拠をすべて選んでください',
      sub: '複数選択できます。証拠説明書・添付書類の作成に使います。', required: true,
      options: [
        { value: 'contract', icon: '📄', text: '契約書・合意書・借用書（書面）' },
        { value: 'message', icon: '💬', text: 'メール・LINE・SMS等のメッセージ' },
        { value: 'receipt', icon: '🧾', text: '領収書・振込明細・銀行履歴' },
        { value: 'photo', icon: '📷', text: '写真・録音・録画' },
        { value: 'witness', icon: '🧑‍🤝‍🧑', text: '第三者の証言（証人）' },
        { value: 'certmail', icon: '📮', text: '内容証明郵便の送付実績あり' },
        { value: 'none', icon: '❌', text: '客観的な証拠はない' },
      ],
    },
    {
      id: 'priorClaims', type: 'textarea', title: 'これまでに行った請求・督促の内容と時期',
      sub: 'いつ、どのような方法（口頭・メール・内容証明等）で、いくらを請求したかをご記入ください。時効の中断（催告）の判断にも使います。', required: false,
      placeholder: '例：令和5年9月にLINEで督促。令和6年1月に内容証明郵便で全額の支払いを請求。', maxlength: 1500,
    },
    {
      id: 'communication', type: 'single', title: '相手方のこれまでの対応は？', required: true,
      options: [
        { value: 'admit', text: '支払い義務を認めている' },
        { value: 'repeated', text: '繰り返し催促したが応じない' },
        { value: 'once', text: '一度督促したが反応なし' },
        { value: 'none', text: 'まだ請求していない' },
        { value: 'deny', text: '請求自体を拒否・否定している' },
      ],
    },
    {
      id: 'delayDamages', type: 'group', title: '遅延損害金・利息の希望', required: true,
      sub: '訴状の「請求の趣旨」に記載する遅延損害金の扱いです。分からなければ「年3%（法定利率）」で構いません。',
      fields: [
        { id: 'rate', label: '利率', type: 'select', required: true, options: [
          { value: '年3%（法定利率）', text: '年3%（法定利率）' },
          { value: '約定利率あり', text: '約定（契約）の利率がある' },
          { value: '請求しない', text: '遅延損害金は請求しない' } ] },
        { id: 'startDate', label: '起算日の希望（任意）', type: 'text', placeholder: '例：返済期日の翌日／訴状送達の日の翌日', required: false, maxlength: 100 },
      ],
    },
    {
      id: 'counterpartyAssets', type: 'multi', title: '相手方の資産状況（分かる範囲で）',
      sub: '判決後の回収（強制執行）の見込みを検討するために使います。複数選択可。', required: false,
      options: [
        { value: 'salary', icon: '💼', text: '勤務先が分かる（給与差押えの可能性）' },
        { value: 'bank', icon: '🏦', text: '取引銀行・口座が分かる（預金差押え）' },
        { value: 'realestate', icon: '🏘', text: '不動産を持っている' },
        { value: 'business', icon: '🏪', text: '事業・店舗を営んでいる' },
        { value: 'vehicle', icon: '🚗', text: '自動車等の資産がある' },
        { value: 'unknown', icon: '❓', text: '資産状況は不明' },
      ],
    },
    {
      id: 'location', type: 'group', title: '管轄判定のための所在地',
      sub: '提出先となる簡易裁判所の判定に使います。都道府県＋市区町村まで（例：東京都世田谷区）で構いません。', required: true,
      fields: [
        { id: 'plaintiff', label: 'あなた（申立人）の所在地', type: 'text', placeholder: '例：東京都世田谷区', required: true, maxlength: 100 },
        { id: 'defendant', label: '相手方の所在地（任意）', type: 'text', placeholder: '例：神奈川県横浜市中区', required: false, maxlength: 100 },
        { id: 'incident', label: 'トラブルが起きた場所（任意）', type: 'text', placeholder: '例：賃貸物件の所在地など', required: false, maxlength: 100 },
      ],
    },
  ];

  // 事件類型ごとの追加項目
  var BY_CASE = {
    loan: [
      { id: 'loan_handoverDate', type: 'date', title: 'お金を渡した日（交付日）', required: true },
      { id: 'loan_method', type: 'single', title: 'お金の交付方法', required: true, options: [
        { value: '手渡し（現金）', text: '手渡し（現金）' }, { value: '銀行振込', text: '銀行振込' },
        { value: 'その他', text: 'その他' } ] },
      { id: 'loan_purpose', type: 'text', title: '資金の交付目的', sub: 'どのような名目で渡したお金ですか。', required: true, placeholder: '例：生活費の貸付、事業資金の貸付 など', maxlength: 200 },
      { id: 'loan_dueDate', type: 'text', title: '返済期日の約定', sub: '返済日の取り決め。期日を定めていない場合はその旨。', required: true, placeholder: '例：令和5年8月31日／期日の定めなし', maxlength: 100 },
      { id: 'loan_interest', type: 'text', title: '利息の約定', required: false, placeholder: '例：利息なし／年5%の約定あり', maxlength: 100 },
      { id: 'loan_iou', type: 'single', title: '借用書・契約書はありますか', required: true, options: [
        { value: 'あり', text: '借用書・契約書がある' }, { value: 'メッセージのみ', text: 'メッセージ記録のみ' }, { value: 'なし', text: 'いずれもない' } ] },
      { id: 'loan_partial', type: 'text', title: '一部返済の有無', sub: 'これまでに一部でも返済を受けた場合は金額・時期を。', required: false, placeholder: '例：令和5年7月に5万円の返済あり／なし', maxlength: 200 },
    ],
    deposit: [
      { id: 'dep_contractDate', type: 'date', title: '賃貸借契約を結んだ日', required: true },
      { id: 'dep_amount', type: 'text', title: '預け入れた敷金・保証金の額', required: true, placeholder: '例：200,000円', maxlength: 50 },
      { id: 'dep_moveout', type: 'date', title: '物件を明け渡した日（退去日）', required: true },
      { id: 'dep_disputes', type: 'textarea', title: '原状回復で争いのある項目', sub: '相手が控除を主張している費目と、あなたの言い分をご記入ください。', required: true, placeholder: '例：クロスの張替え費用5万円を控除されたが、通常損耗にあたると考える。', maxlength: 1500 },
      { id: 'dep_special', type: 'text', title: '敷引・原状回復に関する特約の有無', required: false, placeholder: '例：敷引特約あり（10万円）／特約なし', maxlength: 200 },
    ],
    freelance: [
      { id: 'fl_contractDate', type: 'date', title: '契約（受注）した日', required: true },
      { id: 'fl_work', type: 'textarea', title: '受託した業務の内容', required: true, placeholder: '例：コーポレートサイトの制作（全5ページ）', maxlength: 1000 },
      { id: 'fl_fee', type: 'text', title: '報酬額', required: true, placeholder: '例：300,000円（税込）', maxlength: 50 },
      { id: 'fl_delivery', type: 'text', title: '納品日・検収の状況', required: true, placeholder: '例：令和5年7月10日に納品、同月検収済み', maxlength: 200 },
      { id: 'fl_doc', type: 'single', title: '契約書・発注書はありますか', required: true, options: [
        { value: '契約書あり', text: '契約書がある' }, { value: '発注書・メールあり', text: '発注書・メール等がある' }, { value: 'なし', text: 'いずれもない' } ] },
    ],
    online: [
      { id: 'on_date', type: 'date', title: '取引した日', required: true },
      { id: 'on_platform', type: 'text', title: '利用したプラットフォーム', required: true, placeholder: '例：メルカリ、ヤフオク等', maxlength: 100 },
      { id: 'on_item', type: 'text', title: '取引した商品・サービス', required: true, placeholder: '例：中古カメラ', maxlength: 200 },
      { id: 'on_price', type: 'text', title: '代金', required: true, placeholder: '例：50,000円', maxlength: 50 },
      { id: 'on_issue', type: 'textarea', title: '不履行の内容', sub: '商品未着・説明と著しく異なる等、何が問題かをご記入ください。', required: true, placeholder: '例：代金支払い後、商品が発送されず連絡も取れない。', maxlength: 1500 },
    ],
    wage: [
      { id: 'wg_period', type: 'text', title: '雇用（勤務）期間', required: true, placeholder: '例：令和4年4月〜令和5年10月', maxlength: 100 },
      { id: 'wg_unpaid', type: 'text', title: '未払いの対象期間', required: true, placeholder: '例：令和5年9月〜10月分', maxlength: 100 },
      { id: 'wg_base', type: 'text', title: '基礎賃金（時給・月給など）', required: true, placeholder: '例：時給1,200円／月給25万円', maxlength: 100 },
      { id: 'wg_record', type: 'single', title: '労働時間を示す記録はありますか', required: true, options: [
        { value: 'あり', text: 'タイムカード・勤怠記録等がある' }, { value: '一部', text: '一部ある（メール等）' }, { value: 'なし', text: 'ない' } ] },
      { id: 'wg_type', type: 'single', title: '契約形態', required: true, options: [
        { value: '正社員', text: '正社員' }, { value: 'アルバイト・パート', text: 'アルバイト・パート' }, { value: '契約・派遣', text: '契約・派遣社員' }, { value: 'その他', text: 'その他' } ] },
    ],
    damage: [
      { id: 'dm_when', type: 'text', title: '加害の日時', required: true, placeholder: '例：令和5年11月1日 午後3時頃', maxlength: 100 },
      { id: 'dm_where', type: 'text', title: '加害の場所', required: true, placeholder: '例：〇〇駐車場', maxlength: 200 },
      { id: 'dm_how', type: 'textarea', title: '加害行為の態様', sub: '相手が何をして、どのように損害が生じたか。', required: true, placeholder: '例：被告が自転車で接触し、駐車中の自家用車のドアを損傷させた。', maxlength: 1500 },
      { id: 'dm_loss', type: 'textarea', title: '損害の内容と算定根拠', sub: '修理費等の内訳と、見積書等の根拠。', required: true, placeholder: '例：ドア板金塗装の修理費 8万円（〇〇自動車の見積書あり）。', maxlength: 1500 },
    ],
    other: [
      { id: 'ot_basis', type: 'textarea', title: '請求の法的根拠・経緯', sub: 'どのような権利に基づき、いくらを請求するのかをご記入ください。', required: true, placeholder: '', maxlength: 2000 },
    ],
  };

  function buildQuestions() {
    var list = [Q_CASETYPE];
    if (state.answers.caseType) {
      list = list.concat(COMMON).concat(BY_CASE[state.answers.caseType] || []);
    }
    return list;
  }

  // ============================================
  // ナビゲーション
  // ============================================
  function totalQ() { return state.questions.length; }
  function currentQ() { return state.idx >= 1 ? state.questions[state.idx - 1] : null; }

  function showWelcome() {
    document.querySelectorAll('.diag-step').forEach(function (el) { el.classList.remove('active'); });
    var w = document.querySelector('.diag-step[data-step="welcome"]');
    if (w) w.classList.add('active');
    updateProgress();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function showQuestion() {
    var q = currentQ();
    if (!q) return;
    var host = document.getElementById('dynamicStep');
    document.querySelectorAll('.diag-step').forEach(function (el) { el.classList.remove('active'); });
    host.classList.add('active');
    host.dataset.question = q.id;
    host.innerHTML = renderQuestion(q);
    wireQuestion(q, host);
    updateProgress();
    checkCanProceed();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function updateProgress() {
    var wrap = document.getElementById('progressWrap');
    if (state.idx < 1) {
      wrap.style.opacity = '0'; wrap.style.pointerEvents = 'none';
      wrap.style.maxHeight = '0'; wrap.style.marginBottom = '0'; wrap.style.overflow = 'hidden';
    } else {
      wrap.style.opacity = '1'; wrap.style.pointerEvents = 'auto';
      wrap.style.maxHeight = ''; wrap.style.marginBottom = ''; wrap.style.overflow = '';
      document.getElementById('stepCounter').textContent = 'STEP ' + state.idx + ' / ' + totalQ();
      document.getElementById('progressBar').style.width = (state.idx / totalQ()) * 100 + '%';
    }
  }

  // ============================================
  // レンダリング
  // ============================================
  function escAttr(s) { return String(s == null ? '' : s).replace(/"/g, '&quot;'); }
  function escHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function navHtml(isLast) {
    var nextLabel = isLast ? '入力内容を確認して連絡先へ →' : '次へ →';
    return '<div class="diag-actions">' +
      '<button class="diag-back-btn" data-action="back">← 戻る</button>' +
      '<button class="diag-next" data-action="next" disabled>' + nextLabel + '</button>' +
      '</div>';
  }

  function headHtml(q) {
    var h = '<h2>' + escHtml(q.title) + '</h2>';
    if (q.sub) h += '<p class="diag-sub">' + escHtml(q.sub) + '</p>';
    if (!q.required) h += '<div class="diag-multi-hint">任意項目（空欄でも次へ進めます）</div>';
    return h;
  }

  function renderQuestion(q) {
    var isLast = (state.idx === totalQ());
    var body = '';
    if (q.type === 'single' || q.type === 'multi') {
      var multi = q.type === 'multi';
      body += multi ? '<div class="diag-multi-hint">複数選択できます</div>' : '';
      body += '<div class="diag-options"' + (multi ? ' data-multi' : ' data-single') + '>';
      q.options.forEach(function (o) {
        body += '<button type="button" class="diag-option" data-value="' + escAttr(o.value) + '">' +
          (o.icon ? '<span class="diag-option-icon">' + o.icon + '</span>' : '') +
          '<span class="diag-option-text">' + escHtml(o.text) + '</span>' +
          '<span class="diag-option-check"></span></button>';
      });
      body += '</div>';
    } else if (q.type === 'amount') {
      body += '<div class="diag-amount-input-wrap"><div class="diag-amount-input">' +
        '<span class="diag-amount-prefix">¥</span>' +
        '<input type="number" id="f_amount" min="1" max="100000000" step="1" placeholder="例：300000" inputmode="numeric" autocomplete="off" aria-label="請求金額（円）">' +
        '<span class="diag-amount-suffix">円</span></div>' +
        '<div class="diag-amount-preview" id="amountPreview" aria-live="polite"></div>' +
        '<div class="diag-amount-warning" id="amountWarning" aria-live="polite"></div></div>';
    } else if (q.type === 'text') {
      body += '<div class="diag-field"><input type="text" id="f_text" class="diag-text-input" placeholder="' +
        escAttr(q.placeholder || '') + '" autocomplete="off" maxlength="' + (q.maxlength || 200) + '"></div>';
    } else if (q.type === 'textarea') {
      body += '<div class="diag-field"><textarea id="f_textarea" class="diag-textarea" rows="6" placeholder="' +
        escAttr(q.placeholder || '') + '" maxlength="' + (q.maxlength || 2000) + '"></textarea></div>';
    } else if (q.type === 'date') {
      body += '<div class="diag-field"><input type="date" id="f_date" class="diag-text-input diag-date-input"></div>';
    } else if (q.type === 'group') {
      body += '<div class="diag-group">';
      q.fields.forEach(function (f) {
        var req = f.required ? '<span class="diag-loc-req">必須</span>' : '<span class="diag-loc-opt">（任意）</span>';
        body += '<div class="diag-loc-row"><label class="diag-loc-label" for="g_' + f.id + '">' + escHtml(f.label) + ' ' + req + '</label>';
        if (f.type === 'select') {
          body += '<select id="g_' + f.id + '" class="diag-text-input diag-select" data-field="' + escAttr(f.id) + '">';
          body += '<option value="">選択してください</option>';
          (f.options || []).forEach(function (o) {
            body += '<option value="' + escAttr(o.value) + '">' + escHtml(o.text) + '</option>';
          });
          body += '</select>';
        } else if (f.type === 'date') {
          body += '<input type="date" id="g_' + f.id + '" class="diag-text-input diag-date-input" data-field="' + escAttr(f.id) + '">';
        } else {
          body += '<input type="text" id="g_' + f.id + '" class="diag-text-input" data-field="' + escAttr(f.id) + '" placeholder="' +
            escAttr(f.placeholder || '') + '" autocomplete="off" maxlength="' + (f.maxlength || 200) + '">';
        }
        body += '</div>';
      });
      body += '</div>';
    }
    return headHtml(q) + body + navHtml(isLast);
  }

  // ============================================
  // 入力ワイヤリング
  // ============================================
  function wireQuestion(q, host) {
    if (q.type === 'single' || q.type === 'multi') {
      // 既存選択を復元
      var ans = state.answers[q.id];
      host.querySelectorAll('.diag-option').forEach(function (b) {
        var v = b.dataset.value;
        var sel = (q.type === 'multi') ? (Array.isArray(ans) && ans.indexOf(v) >= 0) : (ans === v);
        b.classList.toggle('selected', !!sel);
      });
    } else if (q.type === 'amount') {
      setupAmount(q, host);
    } else if (q.type === 'text' || q.type === 'textarea' || q.type === 'date') {
      var elId = q.type === 'text' ? 'f_text' : (q.type === 'textarea' ? 'f_textarea' : 'f_date');
      var el = host.querySelector('#' + elId);
      if (el) {
        if (typeof state.answers[q.id] === 'string') el.value = state.answers[q.id];
        var upd = function () { state.answers[q.id] = el.value.trim(); checkCanProceed(); };
        el.addEventListener('input', upd); el.addEventListener('change', upd);
      }
    } else if (q.type === 'group') {
      if (!state.answers[q.id] || typeof state.answers[q.id] !== 'object') state.answers[q.id] = {};
      var obj = state.answers[q.id];
      host.querySelectorAll('[data-field]').forEach(function (el) {
        var fid = el.dataset.field;
        if (typeof obj[fid] === 'string') el.value = obj[fid];
        var upd = function () { obj[fid] = el.value.trim(); checkCanProceed(); };
        el.addEventListener('input', upd); el.addEventListener('change', upd);
      });
    }
  }

  function setupAmount(q, host) {
    var input = host.querySelector('#f_amount');
    var preview = host.querySelector('#amountPreview');
    var warning = host.querySelector('#amountWarning');
    if (!input) return;
    function update() {
      var raw = input.value.trim();
      var val = parseInt(raw, 10);
      if (!raw || isNaN(val) || val <= 0) {
        state.answers[q.id] = null; preview.textContent = ''; warning.textContent = ''; warning.className = 'diag-amount-warning';
      } else if (val > 100000000) {
        state.answers[q.id] = null; preview.textContent = '';
        warning.textContent = '⚠ 金額が大きすぎます。1億円以下で入力してください。'; warning.className = 'diag-amount-warning warn';
      } else {
        state.answers[q.id] = val; preview.textContent = '¥' + val.toLocaleString('ja-JP');
        if (val > 600000) { warning.textContent = '⚠ 60万円超は少額訴訟の対象外です（通常訴訟手続きをご検討ください）'; warning.className = 'diag-amount-warning warn'; }
        else if (val < 10000) { warning.textContent = '※ 印紙代等の実費との兼ね合いをご検討ください'; warning.className = 'diag-amount-warning info'; }
        else { warning.textContent = ''; warning.className = 'diag-amount-warning'; }
      }
      checkCanProceed();
    }
    input.addEventListener('input', update); input.addEventListener('change', update);
    if (typeof state.answers[q.id] === 'number') { input.value = state.answers[q.id]; update(); }
  }

  // ============================================
  // バリデーション
  // ============================================
  function checkCanProceed() {
    var host = document.getElementById('dynamicStep');
    var nextBtn = host.querySelector('[data-action="next"]');
    if (!nextBtn) return;
    var q = currentQ();
    if (!q) { nextBtn.disabled = true; return; }
    nextBtn.disabled = !isAnswered(q);
  }

  function isAnswered(q) {
    if (!q.required) return true;
    var ans = state.answers[q.id];
    if (q.type === 'multi') return Array.isArray(ans) && ans.length > 0;
    if (q.type === 'group') {
      if (!ans || typeof ans !== 'object') return false;
      return q.fields.every(function (f) {
        if (!f.required) return true;
        return typeof ans[f.id] === 'string' && ans[f.id].trim().length > 0;
      });
    }
    if (q.type === 'amount') return typeof ans === 'number' && ans > 0;
    return ans !== null && ans !== undefined && String(ans).trim() !== '';
  }

  // ============================================
  // 選択肢クリック（委譲）
  // ============================================
  function handleOptionClick(btn) {
    var host = document.getElementById('dynamicStep');
    var q = currentQ();
    if (!q) return;
    var value = btn.dataset.value;
    if (q.type === 'multi') {
      if (!Array.isArray(state.answers[q.id])) state.answers[q.id] = [];
      var arr = state.answers[q.id];
      if (value === 'none') {
        state.answers[q.id] = arr.indexOf('none') >= 0 ? [] : ['none'];
      } else {
        var i0 = arr.indexOf('none'); if (i0 >= 0) arr.splice(i0, 1);
        var idx = arr.indexOf(value);
        if (idx >= 0) arr.splice(idx, 1); else arr.push(value);
      }
      var cur = state.answers[q.id];
      host.querySelectorAll('.diag-option').forEach(function (b) {
        b.classList.toggle('selected', cur.indexOf(b.dataset.value) >= 0);
      });
    } else {
      host.querySelectorAll('.diag-option').forEach(function (b) { b.classList.remove('selected'); });
      btn.classList.add('selected');
      state.answers[q.id] = value;
    }
    checkCanProceed();
  }

  // ============================================
  // アクション
  // ============================================
  function handleAction(action) {
    if (action === 'start') {
      state.questions = buildQuestions();
      state.idx = 1;
      showQuestion();
    } else if (action === 'next') {
      var q = currentQ();
      if (q && !isAnswered(q)) return;
      // caseType 回答後に質問リストを再構築
      if (q && q.id === 'caseType') state.questions = buildQuestions();
      if (state.idx < totalQ()) {
        state.idx++;
        showQuestion();
      } else {
        finishIntake();
      }
    } else if (action === 'back') {
      if (state.idx > 1) { state.idx--; showQuestion(); }
      else { state.idx = 0; showWelcome(); }
    } else if (action === 'restart') {
      state.idx = 0; state.answers = {}; state.questions = buildQuestions(); showWelcome();
    }
  }

  function finishIntake() {
    // ヒアリング内容を保存して連絡先ページへ
    try {
      sessionStorage.setItem('lastDiagnosisAnswers', JSON.stringify(state.answers));
      sessionStorage.removeItem('lastDiagnosisResult');
    } catch (_) {}
    window.location.href = 'apply.html';
  }

  // ============================================
  // 初期化
  // ============================================
  function init() {
    state.questions = buildQuestions();
    document.addEventListener('click', function (e) {
      var opt = e.target.closest ? e.target.closest('.diag-option') : null;
      if (opt) { handleOptionClick(opt); return; }
      var actionEl = e.target.closest ? e.target.closest('[data-action]') : null;
      if (actionEl) { handleAction(actionEl.dataset.action); }
    });
    showWelcome();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
