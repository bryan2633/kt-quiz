// v5 mathematics extension: existing index.html and KT data are retained.
(() => {
  const base = document.currentScript?.src || location.href;
  const css = document.createElement('link');
  css.rel = 'stylesheet'; css.href = new URL('./math.css', base).href;
  document.head.appendChild(css);
  const script = document.createElement('script');
  script.src = new URL('./math.js', base).href;
  script.onerror = () => { const node = document.getElementById('homeView'); if(node){ const p=document.createElement('p'); p.textContent='数学機能の読み込みに失敗しました。オンラインで再読み込みしてください。'; node.prepend(p); } };
  document.head.appendChild(script);
})();
(() => {
  const ORIGINAL = window.KT_DATA || [];
  let DATA = [...ORIGINAL];
  let THEMES = [...new Set(DATA.map(q => q.theme))];
  const customPositions = loadJSON('kt-custom-positions-v1', {});
  const displayNo = q => String(q.displayNumber || q.studyNumber).padStart(3,'0');
  const saveCustomPositions = () => localStorage.setItem('kt-custom-positions-v1', JSON.stringify(customPositions));
  // Keep the existing v1 keys so users upgrading from v1 retain their progress.
  const STORE_KEY = 'kt-quiz-progress-v1';
  const STATE_KEY = 'kt-quiz-state-v1';
  const DOUBT_KEY = 'kt-quiz-doubts-v2';
  const REVIEW_KEY = 'kt-quiz-review-v3';
  const APP_VERSION = '5.4.0';
  let suppressKTSync = false;

  let progress = loadJSON(STORE_KEY, {});
  let appState = loadJSON(STATE_KEY, { lastStudyNumber: 1 });
  let doubts = loadJSON(DOUBT_KEY, []);
  if (!Array.isArray(doubts)) doubts = [];
  let reviewQueue = loadJSON(REVIEW_KEY, {});
  if (!reviewQueue || Array.isArray(reviewQueue) || typeof reviewQueue !== 'object') reviewQueue = {};
  if (!appState.sessionPositions || typeof appState.sessionPositions !== 'object') appState.sessionPositions = {};

  let session = [];
  let sessionIndex = 0;
  let currentSlides = [];
  let currentSlideIndex = 0;
  let slideSourceQuestion = null;
  let deferredPrompt = null;
  let activeSessionKey = null;
  let activeSessionMode = 'normal';

  const $ = id => document.getElementById(id);
  const views = [...document.querySelectorAll('.view')];
  const navBtns = [...document.querySelectorAll('.nav-btn')];

  function loadJSON(k, fallback){
    try {
      const raw = localStorage.getItem(k);
      if (raw === null) return fallback;
      const parsed = JSON.parse(raw);
      return parsed ?? fallback;
    } catch {
      return fallback;
    }
  }

  function save(){
    localStorage.setItem(STORE_KEY, JSON.stringify(progress));
    localStorage.setItem(STATE_KEY, JSON.stringify(appState));
    localStorage.setItem(DOUBT_KEY, JSON.stringify(doubts));
    localStorage.setItem(REVIEW_KEY, JSON.stringify(reviewQueue));
    renderDoubtNavBadge();
    if(!suppressKTSync) window.dispatchEvent(new Event('kt-state-saved'));
  }

  function statusFor(q){ return (q.custom ? q.card.review?.rating : progress[q.studyNumber]?.rating) || 'unseen'; }
  function esc(s){ return String(s ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
  function withBreaks(s){ return esc(s).replace(/\n/g, '<br>'); }
  function highlightTarget(question, n){
    const safe = esc(question);
    const re = new RegExp(`（${n}）`, 'g');
    return safe.replace(re, `<mark>（${n}）</mark>`);
  }
  function normalize(s){ return (s||'').normalize('NFKC').toLowerCase().replace(/[\s・･ー\-‐‑–—()（）／/]/g,''); }
  function candidateAnswers(ans){
    const out = new Set([ans]);
    const par = [...ans.matchAll(/[（(]([^）)]+)[）)]/g)].map(m=>m[1]);
    par.forEach(x=>out.add(x));
    ans.split(/[／/]/).forEach(x=>out.add(x.trim()));
    return [...out].filter(Boolean);
  }
  function compareInput(input, ans){
    if(!input.trim()) return '';
    const n=normalize(input);
    const candidates=candidateAnswers(ans).map(normalize);
    return candidates.includes(n)
      ? '入力は公式解答と一致しています。'
      : '表記差もあり得るため、公式解答と見比べて自己評価してください。';
  }
  function currentQuestion(){ return session[sessionIndex] || null; }
  function questionForStudyNumber(studyNumber){ return DATA.find(q => String(q.studyNumber) === String(studyNumber)) || null; }
  function makeId(){
    if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
    return `d-${Date.now()}-${Math.random().toString(36).slice(2,10)}`;
  }
  function formatDate(iso){
    if(!iso) return '';
    const d = new Date(iso);
    if(Number.isNaN(d.getTime())) return '';
    return new Intl.DateTimeFormat('ja-JP', {
      year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'
    }).format(d);
  }

  function dateKey(date=new Date()){
    const y=date.getFullYear();
    const m=String(date.getMonth()+1).padStart(2,'0');
    const d=String(date.getDate()).padStart(2,'0');
    return `${y}-${m}-${d}`;
  }

  function dateKeyFromISO(iso){
    const d=new Date(iso);
    return Number.isNaN(d.getTime()) ? dateKey() : dateKey(d);
  }

  function addDaysKey(key,days){
    const [y,m,d]=key.split('-').map(Number);
    const dt=new Date(y,m-1,d);
    dt.setDate(dt.getDate()+days);
    return dateKey(dt);
  }

  function displayDateKey(key){
    if(!key) return '';
    const [y,m,d]=key.split('-').map(Number);
    return `${m}/${d}`;
  }

  function themeSessionKey(theme,level){ return `theme:${theme}|level:${level}`; }

  function savedSessionQuestion(sessionKey,qs){
    if(!sessionKey) return null;
    const n=customPositions[sessionKey] || appState.sessionPositions?.[sessionKey]?.studyNumber;
    return qs.find(q=>String(q.studyNumber)===String(n)) || null;
  }

  function saveSessionPosition(q){
    if(!activeSessionKey || !q) return;
    if(q.custom){customPositions[activeSessionKey]=q.studyNumber;saveCustomPositions();return;}
    delete customPositions[activeSessionKey];saveCustomPositions();
    if(!appState.sessionPositions) appState.sessionPositions={};
    appState.sessionPositions[activeSessionKey]={studyNumber:q.studyNumber,updatedAt:new Date().toISOString()};
  }

  function clearSessionPosition(sessionKey){
    if(!sessionKey || !appState.sessionPositions) return;
    delete appState.sessionPositions[sessionKey];
    delete customPositions[sessionKey];saveCustomPositions();
  }

  function isReviewDue(entry){ return !!entry?.dueDate && entry.dueDate<=dateKey(); }
  const allReviewEntries = () => [...Object.values(reviewQueue), ...DATA.filter(q=>q.custom && q.card.review?.due).map(q=>({studyNumber:q.studyNumber,dueDate:q.card.review.due,custom:true}))];
  function dueReviewEntries(){ return allReviewEntries().filter(isReviewDue); }
  function waitingReviewEntries(){ return allReviewEntries().filter(x=>!isReviewDue(x)); }
  function reviewStageLabel(stage){ return ['翌日チェック','2日目チェック','1週間チェック'][stage] || '復習'; }

  function queueFailure(q){
    const now=new Date().toISOString();
    const today=dateKey();
    const existing=reviewQueue[q.studyNumber];
    const wasDue=existing && isReviewDue(existing);
    reviewQueue[q.studyNumber]={
      studyNumber:q.studyNumber,
      originalNumber:q.originalNumber,
      firstFailedAt:existing?.firstFailedAt || now,
      lastFailedAt:now,
      stage:0,
      // 期限到来後に再度×なら未消化のまま今日に残す。新規の×は翌日から復習。
      dueDate:wasDue ? today : addDaysKey(today,1),
      updatedAt:now
    };
  }

  function advanceReviewIfDue(q){
    const entry=reviewQueue[q.studyNumber];
    if(!entry || !isReviewDue(entry)) return;
    const now=new Date().toISOString();
    if(entry.stage===0){
      entry.stage=1;
      entry.dueDate=addDaysKey(dateKey(),1);
      entry.updatedAt=now;
      return;
    }
    if(entry.stage===1){
      entry.stage=2;
      entry.dueDate=addDaysKey(dateKey(),5);
      entry.updatedAt=now;
      return;
    }
    delete reviewQueue[q.studyNumber];
  }

  function migrateCurrentBadProgress(){
    let changed=false;
    DATA.forEach(q=>{
      const p=progress[q.studyNumber];
      if(p?.rating!=='bad' || reviewQueue[q.studyNumber]) return;
      const failedAt=p.lastSeen || new Date().toISOString();
      const failDate=dateKeyFromISO(failedAt);
      reviewQueue[q.studyNumber]={
        studyNumber:q.studyNumber,
        originalNumber:q.originalNumber,
        firstFailedAt:failedAt,
        lastFailedAt:failedAt,
        stage:0,
        dueDate:addDaysKey(failDate,1),
        updatedAt:failedAt
      };
      changed=true;
    });
    if(changed) save();
  }

  function showView(id){
    views.forEach(v => v.classList.toggle('active', v.id===id));
    navBtns.forEach(b => b.classList.toggle('active', b.dataset.view===id));
    if(id==='homeView') renderHome();
    if(id==='listView') renderList();
    if(id==='doubtsView') renderDoubts();
    if(id==='progressView') renderProgress();
    window.scrollTo({top:0, behavior:'instant'});
  }

  function renderHome(){
    const seen=DATA.filter(q=>statusFor(q)!=='unseen').length;
    $('doneCount').textContent=seen;
    $('doneCount').nextElementSibling.textContent=`/ ${DATA.length} 学習済み`;
    document.querySelector('#homeView .hero-kicker').textContent=`公式${ORIGINAL.length}問 ＋ 自作${DATA.length-ORIGINAL.length}問`;
    $('progressBar').style.width=`${seen/DATA.length*100}%`;

    const due=dueReviewEntries().length;
    const waiting=waitingReviewEntries().length;
    $('reviewBtn').textContent=`未消化の復習（${due}件）`;
    $('reviewSummary').textContent=allReviewEntries().length
      ? `復習キュー：今日・期限超過 ${due}件 / 待機中 ${waiting}件。公式問題の×は翌日→2日目→1週間に復習。自作問題は○△×に応じた間隔で復習します。`
      : '復習キュー：現在は空です。×にした問題は翌日から復習対象として記憶されます。';

    const level=$('levelFilterHome').value;
    $('themeGrid').innerHTML='';
    THEMES.forEach(theme=>{
      const qs=DATA.filter(q=>q.theme===theme && (level==='all'||q.level===level));
      if(!qs.length) return;
      const done=qs.filter(q=>statusFor(q)!=='unseen').length;
      const key=themeSessionKey(theme,level);
      const saved=savedSessionQuestion(key,qs);
      const savedIdx=saved ? qs.findIndex(q=>q.studyNumber===saved.studyNumber) : -1;
      const resumeMeta=saved ? `<div class="theme-resume">続き：${savedIdx+1} / ${qs.length}（学習順 ${displayNo(saved)}）</div>` : '';
      const b=document.createElement('button');
      b.className='theme-card';
      b.type='button';
      b.innerHTML=`<div class="theme-name">${esc(theme)}</div><div class="theme-meta">${done} / ${qs.length} 学習済み</div>${resumeMeta}<div class="mini-progress"><span style="width:${done/qs.length*100}%"></span></div>`;
      b.addEventListener('click',()=>startSession(qs, `${theme}${level==='all'?'':` / ${level}`}`, null, key, true));
      $('themeGrid').appendChild(b);
    });
  }

  function startSession(qs,label,startStudyNo=null,sessionKey=null,resumeSaved=false,mode='normal'){
    session=[...qs];
    if(!session.length){ alert('対象となる問題がありません。'); return; }
    activeSessionKey=sessionKey;
    activeSessionMode=mode;
    sessionIndex=0;
    let targetStudyNo=startStudyNo;
    if(!targetStudyNo && resumeSaved && sessionKey){
      targetStudyNo=customPositions[sessionKey] || appState.sessionPositions?.[sessionKey]?.studyNumber || null;
    }
    if(targetStudyNo){
      const idx=session.findIndex(q=>String(q.studyNumber)===String(targetStudyNo));
      if(idx>=0) sessionIndex=idx;
    }
    $('sessionLabel').textContent=label;
    showView('studyView');
    renderQuestion();
  }

  function renderQuestion(){
    const q=currentQuestion();
    if(!q) return;
    if(q.custom){customPositions.last=q.studyNumber;}else{delete customPositions.last;appState.lastStudyNumber=q.studyNumber;appState.lastStudyUpdatedAt=new Date().toISOString();}
    saveCustomPositions();
    saveSessionPosition(q);
    save();
    $('studyNo').textContent=`学習順 ${displayNo(q)}`;
    $('origNo').textContent=q.custom?'自作':`元(${q.originalNumber})`;
    $('levelPill').hidden=!!q.custom;
    $('targetBlank').parentElement.hidden=!!q.custom;
    $('explainBtn').hidden=!!q.custom;
    document.querySelector('.doubt-compose').hidden=!!q.custom;
    document.querySelector('#answerPanel > .answer-caption').textContent=q.custom?'答え':'公式解答';
    $('editIntegratedCard').hidden=!q.custom;
    $('themePill').textContent=q.theme;
    $('levelPill').textContent=`${q.level} ${q.levelName}`;
    $('targetBlank').textContent=`（${q.originalNumber}）`;
    $('questionText').innerHTML=q.custom?withBreaks(q.question):highlightTarget(q.question,q.originalNumber);
    renderCustomMedia(q);
    $('answerInput').value='';
    $('doubtInput').value='';
    $('answerPanel').classList.add('hidden');
    $('officialAnswer').textContent=q.answer;
    $('inputCompare').textContent='';
    document.querySelectorAll('.rate').forEach(b=>b.classList.toggle('selected', b.dataset.rating===statusFor(q)));
    $('sessionPos').textContent=`${sessionIndex+1} / ${session.length}`;
    $('prevBtn').disabled=sessionIndex===0;
    $('nextBtn').disabled=sessionIndex===session.length-1;
    renderCurrentDoubts();
  }

  function reveal(){
    const q=currentQuestion();
    if(!q) return;
    $('officialAnswer').textContent=q.answer;
    $('inputCompare').textContent=q.custom ? '答えと照らし合わせて、○△×で評価してください。' : compareInput($('answerInput').value,q.answer);
    $('answerPanel').classList.remove('hidden');
    renderCurrentDoubts();
  }

  let ratingBusy=false;
  async function rateCurrent(rating){
    const q=currentQuestion();
    if(!q) return;
    if(ratingBusy || $('answerPanel').classList.contains('hidden'))return;
    ratingBusy=true;
    if(q.custom){
      try{await window.KT_CUSTOM.rate(q.card.id,rating);}catch(e){ratingBusy=false;alert(e.message || '保存できませんでした');return;}
    }else{
    const p=progress[q.studyNumber] || {attempts:0};
    progress[q.studyNumber]={rating, attempts:(p.attempts||0)+1, lastSeen:new Date().toISOString()};

    if(rating==='bad') queueFailure(q);
    if(rating==='good') advanceReviewIfDue(q);
    // △は復習キューの段階を進めない。期限到来済みなら未消化のまま残る。
    }

    save();
    document.querySelectorAll('.rate').forEach(b=>b.classList.toggle('selected', b.dataset.rating===rating));
    setTimeout(()=>{
      ratingBusy=false;
      if(sessionIndex<session.length-1){
        sessionIndex++;
        renderQuestion();
      } else {
        clearSessionPosition(activeSessionKey);
        activeSessionKey=null;
        activeSessionMode='normal';
        save();
        showView('homeView');
      }
    },170);
  }

  // ---- Doubts / questions-to-resolve -------------------------------------------------------
  function doubtsForQuestion(q){
    return doubts
      .filter(d => d.studyNumber === q.studyNumber)
      .sort((a,b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
  }

  function createDoubt(){
    const q=currentQuestion();
    if(!q) return;
    const text=$('doubtInput').value.trim();
    if(!text){
      $('doubtInput').focus();
      return;
    }
    const now=new Date().toISOString();
    doubts.unshift({
      id:makeId(),
      studyNumber:q.studyNumber,
      originalNumber:q.originalNumber,
      theme:q.theme,
      level:q.level,
      text,
      status:'open',
      createdAt:now,
      updatedAt:now,
      resolvedAt:null
    });
    $('doubtInput').value='';
    save();
    renderCurrentDoubts();
  }

  function setDoubtStatus(id,status){
    const d=doubts.find(x=>x.id===id);
    if(!d) return;
    const now=new Date().toISOString();
    d.status=status;
    d.updatedAt=now;
    d.resolvedAt=status==='resolved'?now:null;
    save();
    renderCurrentDoubts();
    if($('doubtsView').classList.contains('active')) renderDoubts();
  }

  function editDoubt(id){
    const d=doubts.find(x=>x.id===id);
    if(!d) return;
    const next=prompt('疑問メモを編集', d.text);
    if(next===null) return;
    const text=next.trim();
    if(!text) return;
    d.text=text;
    d.updatedAt=new Date().toISOString();
    save();
    renderCurrentDoubts();
    if($('doubtsView').classList.contains('active')) renderDoubts();
  }

  function deleteDoubt(id){
    const d=doubts.find(x=>x.id===id);
    if(!d) return;
    if(!confirm('この疑問メモを削除しますか？')) return;
    doubts=doubts.filter(x=>x.id!==id);
    save();
    renderCurrentDoubts();
    if($('doubtsView').classList.contains('active')) renderDoubts();
  }

  function doubtStatusLabel(status){ return status==='resolved'?'解決済み':'未解決'; }

  function renderCurrentDoubts(){
    const q=currentQuestion();
    if(!q) return;
    const items=doubtsForQuestion(q);
    const open=items.filter(d=>d.status==='open').length;
    $('currentDoubtCount').textContent=items.length ? `${open}件未解決 / ${items.length}件` : '0件';
    const box=$('currentDoubts');
    box.innerHTML='';
    if(!items.length){
      box.innerHTML='<div class="doubt-empty compact">この問題にはまだ疑問メモがありません。</div>';
      return;
    }
    items.forEach(d=>{
      const el=document.createElement('div');
      el.className=`mini-doubt ${d.status}`;
      el.innerHTML=`
        <div class="mini-doubt-top">
          <span class="doubt-status ${d.status}">${doubtStatusLabel(d.status)}</span>
          <span class="doubt-time">更新 ${esc(formatDate(d.updatedAt || d.createdAt))}</span>
        </div>
        <div class="mini-doubt-text">${withBreaks(d.text)}</div>
        <div class="mini-doubt-actions">
          <button class="ghost small js-doubt-toggle" type="button">${d.status==='open'?'解決済みにする':'未解決に戻す'}</button>
          <button class="ghost small js-doubt-edit" type="button">編集</button>
          <button class="ghost small js-doubt-delete" type="button">削除</button>
        </div>`;
      el.querySelector('.js-doubt-toggle').addEventListener('click',()=>setDoubtStatus(d.id,d.status==='open'?'resolved':'open'));
      el.querySelector('.js-doubt-edit').addEventListener('click',()=>editDoubt(d.id));
      el.querySelector('.js-doubt-delete').addEventListener('click',()=>deleteDoubt(d.id));
      box.appendChild(el);
    });
  }

  function renderDoubtNavBadge(){
    const open=doubts.filter(d=>d.status==='open').length;
    const badge=$('doubtsNavBadge');
    if(!badge) return;
    badge.textContent=String(open);
    badge.classList.toggle('hidden',open===0);
  }

  function renderDoubts(){
    const search=$('doubtSearchInput').value.trim().toLowerCase();
    const theme=$('doubtThemeFilter').value;
    const status=$('doubtStatusFilter').value;
    const openCount=doubts.filter(d=>d.status==='open').length;
    const resolvedCount=doubts.filter(d=>d.status==='resolved').length;
    $('doubtSummary').textContent=`未解決 ${openCount}件 / 解決済み ${resolvedCount}件 / 合計 ${doubts.length}件`;

    const filtered=doubts.filter(d=>{
      const q=questionForStudyNumber(d.studyNumber);
      const hay=`${d.text} ${d.studyNumber} ${d.originalNumber} ${d.theme} ${q?.question||''} ${q?.answer||''}`.toLowerCase();
      return (!search||hay.includes(search)) && (theme==='all'||d.theme===theme) && (status==='all'||d.status===status);
    }).sort((a,b)=>{
      if(a.status!==b.status) return a.status==='open'?-1:1;
      return new Date(b.updatedAt||b.createdAt)-new Date(a.updatedAt||a.createdAt);
    });

    const list=$('doubtList');
    list.innerHTML='';
    if(!filtered.length){
      list.innerHTML='<div class="card doubt-empty">条件に該当する疑問メモはありません。</div>';
      return;
    }

    filtered.forEach(d=>{
      const q=questionForStudyNumber(d.studyNumber);
      const card=document.createElement('article');
      card.className=`doubt-card card ${d.status}`;
      card.innerHTML=`
        <div class="doubt-card-head">
          <div class="doubt-meta-wrap">
            <span class="doubt-status ${d.status}">${doubtStatusLabel(d.status)}</span>
            <span class="pill strong">学習順 ${String(d.studyNumber).padStart(3,'0')}</span>
            <span class="pill">元(${d.originalNumber})</span>
            <span class="pill">${esc(d.theme)}</span>
          </div>
          <span class="doubt-time">更新 ${esc(formatDate(d.updatedAt||d.createdAt))}</span>
        </div>
        <div class="doubt-question">${q?esc(q.question):'問題データが見つかりません。'}</div>
        <div class="doubt-text">${withBreaks(d.text)}</div>
        <div class="doubt-card-actions">
          <button class="secondary js-open-question" type="button">問題へ</button>
          <button class="secondary js-open-slides" type="button" ${q?'':'disabled'}>PowerPointを見る</button>
          <button class="ghost js-toggle-status" type="button">${d.status==='open'?'解決済みにする':'未解決に戻す'}</button>
          <button class="ghost js-edit" type="button">編集</button>
          <button class="ghost js-delete" type="button">削除</button>
        </div>`;
      card.querySelector('.js-open-question').addEventListener('click',()=>startSession(DATA,`全${DATA.length}問`,d.studyNumber));
      card.querySelector('.js-open-slides').addEventListener('click',()=>{ if(q) openSlidesForQuestion(q); });
      card.querySelector('.js-toggle-status').addEventListener('click',()=>setDoubtStatus(d.id,d.status==='open'?'resolved':'open'));
      card.querySelector('.js-edit').addEventListener('click',()=>editDoubt(d.id));
      card.querySelector('.js-delete').addEventListener('click',()=>deleteDoubt(d.id));
      list.appendChild(card);
    });
  }

  // ---- PowerPoint slides -----------------------------------------------------------------
  function openSlides(){
    const q=currentQuestion();
    if(q) openSlidesForQuestion(q);
  }

  function openSlidesForQuestion(q){
    slideSourceQuestion=q;
    currentSlides=q.slides||[];
    currentSlideIndex=0;
    $('slideModal').classList.remove('hidden');
    document.body.style.overflow='hidden';
    if(!currentSlides.length){
      $('noSlideMessage').classList.remove('hidden');
      $('slideViewer').classList.add('hidden');
      $('slideTitle').textContent=`元(${q.originalNumber}) の解説`;
    } else {
      $('noSlideMessage').classList.add('hidden');
      $('slideViewer').classList.remove('hidden');
      renderSlide();
    }
  }

  function closeSlides(){
    $('slideModal').classList.add('hidden');
    document.body.style.overflow='';
    slideSourceQuestion=null;
  }

  function renderSlide(){
    const s=currentSlides[currentSlideIndex];
    if(!s) return;
    $('slideImage').src=s.image;
    $('slideImage').alt=`PowerPoint スライド ${s.number}: ${s.title}`;
    $('slideTitle').textContent=s.title;
    const source=slideSourceQuestion?`・元(${slideSourceQuestion.originalNumber})`:'';
    $('slideCounter').textContent=`スライド ${s.number} ${source} ・ ${currentSlideIndex+1}/${currentSlides.length}`;
    $('slidePrev').disabled=currentSlideIndex===0;
    $('slideNext').disabled=currentSlideIndex===currentSlides.length-1;
  }

  // ---- List / progress -------------------------------------------------------------------
  function renderList(){
    const search=$('searchInput').value.trim().toLowerCase();
    const theme=$('themeFilter').value;
    const level=$('levelFilter').value;
    const st=$('statusFilter').value;
    document.querySelector('#listView h2').textContent=`問題一覧（${DATA.length}問）`;
    const qs=DATA.filter(q=>{
      const hay=`${q.studyNumber} ${q.originalNumber} ${q.question} ${q.answer} ${q.card?.note || ''} ${q.card?.theme || ''}`.toLowerCase();
      return (!search||hay.includes(search)) && (theme==='all'||q.theme===theme) && (level==='all'||q.level===level) && (st==='all'||statusFor(q)===st);
    });
    $('questionList').innerHTML='';
    qs.forEach(q=>{
      const s=statusFor(q);
      const symbol={unseen:'–',good:'○',meh:'△',bad:'×'}[s];
      const noteCount=doubts.filter(d=>d.studyNumber===q.studyNumber&&d.status==='open').length;
      const row=document.createElement('button');
      row.type='button';
      row.className='list-row';
      row.innerHTML=`<div class="list-num">${displayNo(q)}</div><div class="list-body"><div class="list-q">${esc(q.question)}</div><div class="list-meta">${q.custom?'自作':`元(${q.originalNumber})`}・${esc(q.theme)}${q.custom?'':`・${q.level} ${q.levelName}`}${noteCount?`・未解決の疑問 ${noteCount}件`:''}</div></div><div class="status-dot ${s}">${symbol}</div>`;
      row.addEventListener('click',()=>startSession(DATA,`全${DATA.length}問`,q.studyNumber));
      $('questionList').appendChild(row);
    });
  }

  function renderProgress(){
    const summary=$('progressSummary');
    summary.innerHTML='';

    const pieGradient=(counts,total)=>{
      if(!total) return 'conic-gradient(#e2e8f0 0 100%)';
      const good=counts.good/total*100;
      const meh=counts.meh/total*100;
      const bad=counts.bad/total*100;
      const a=good;
      const b=a+meh;
      const c=b+bad;
      return `conic-gradient(var(--good) 0 ${a}%, var(--meh) ${a}% ${b}%, var(--bad) ${b}% ${c}%, var(--unseen) ${c}% 100%)`;
    };

    const make=(name,qs,isOverall=false)=>{
      const counts={good:0,meh:0,bad:0,unseen:0};
      qs.forEach(q=>counts[statusFor(q)]++);
      const total=qs.length;
      const learned=total-counts.unseen;
      const learnedPct=total ? Math.round(learned/total*100) : 0;
      const d=document.createElement('div');
      d.className=`progress-card${isOverall?' overall':''}`;
      d.innerHTML=`
        <div class="progress-card-head">
          <div>
            <h3>${esc(name)}</h3>
            <div class="progress-subtitle">${learned} / ${total} 学習済み</div>
          </div>
          <div class="progress-percent">${learnedPct}%</div>
        </div>
        <div class="progress-visual">
          <div class="progress-pie" role="img" aria-label="${esc(name)}の進捗円グラフ。できた${counts.good}、微妙${counts.meh}、できなかった${counts.bad}、未学習${counts.unseen}" style="--pie:${pieGradient(counts,total)}">
            <div class="progress-pie-hole"><strong>${learnedPct}%</strong><span>学習済み</span></div>
          </div>
          <div class="progress-compact-stats">
            <div class="progress-stat-chip good"><span class="progress-dot"></span><span>できた</span><strong>${counts.good}</strong></div>
            <div class="progress-stat-chip meh"><span class="progress-dot"></span><span>微妙</span><strong>${counts.meh}</strong></div>
            <div class="progress-stat-chip bad"><span class="progress-dot"></span><span>できなかった</span><strong>${counts.bad}</strong></div>
            <div class="progress-stat-chip unseen"><span class="progress-dot"></span><span>未学習</span><strong>${counts.unseen}</strong></div>
          </div>
        </div>`;
      summary.appendChild(d);
    };
    make('全体',DATA,true);
    THEMES.forEach(t=>make(t,DATA.filter(q=>q.theme===t)));
    renderReviewQueueProgress();
  }

  function renderReviewQueueProgress(){
    const box=$('reviewQueueProgress');
    if(!box) return;
    const entries=allReviewEntries().sort((a,b)=>(a.dueDate||'').localeCompare(b.dueDate||''));
    const due=entries.filter(isReviewDue);
    const waiting=entries.filter(x=>!isReviewDue(x));
    let html=`<h3>復習キュー</h3><p>今日・期限超過 <strong>${due.length}</strong>件 / 待機中 <strong>${waiting.length}</strong>件</p>`;
    if(!entries.length){
      html+='<div class="review-empty">現在、未消化の復習はありません。</div>';
    } else {
      html+='<div class="review-queue-list">';
      entries.slice(0,12).forEach(e=>{
        const q=questionForStudyNumber(e.studyNumber);
        const dueClass=isReviewDue(e)?'due':'waiting';
        html+=`<div class="review-queue-row ${dueClass}"><span>${isReviewDue(e)?'期限':'次回'} ${displayDateKey(e.dueDate)}</span><strong>学習順 ${q?displayNo(q):esc(e.studyNumber)}</strong><span>${q?`${q.custom?'自作':`元(${q.originalNumber})`}・${esc(q.theme)}`:''}</span><span>${e.custom?'自作カードの復習':reviewStageLabel(e.stage)}</span></div>`;
      });
      if(entries.length>12) html+=`<div class="review-more">ほか ${entries.length-12}件</div>`;
      html+='</div>';
    }
    box.innerHTML=html;
  }

  // ---- Backup ----------------------------------------------------------------------------
  function backupObject(){
    return {
      format:'kt-quiz-backup',
      appVersion:APP_VERSION,
      exportedAt:new Date().toISOString(),
      questionCount:ORIGINAL.length,
      progress,
      appState,
      doubts,
      reviewQueue
    };
  }

  async function exportBackup(){
    const json=JSON.stringify(backupObject(),null,2);
    const date=new Date();
    const y=date.getFullYear();
    const m=String(date.getMonth()+1).padStart(2,'0');
    const d=String(date.getDate()).padStart(2,'0');
    const filename=`KT_一問一答_backup_${y}-${m}-${d}.json`;
    const blob=new Blob([json],{type:'application/json;charset=utf-8'});

    try {
      if(typeof File!=='undefined' && navigator.share){
        const file=new File([blob],filename,{type:'application/json'});
        if(!navigator.canShare || navigator.canShare({files:[file]})){
          await navigator.share({title:'KT 一問一答 バックアップ',files:[file]});
          return;
        }
      }
    } catch(err){
      if(err?.name==='AbortError') return;
    }

    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url;
    a.download=filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }

  // ---- Events ----------------------------------------------------------------------------
  $('continueBtn').addEventListener('click',()=>startSession(DATA,'学習順',customPositions.last||appState.lastStudyNumber||1));
  $('randomBtn').addEventListener('click',()=>{const x=[...DATA].sort(()=>Math.random()-.5);startSession(x,'ランダム');});
  $('reviewBtn').addEventListener('click',()=>{
    const dueSet=new Set(dueReviewEntries().map(e=>String(e.studyNumber)));
    const qs=DATA.filter(q=>dueSet.has(String(q.studyNumber))).sort((a,b)=>{
      const da=(a.custom?a.card.review?.due:reviewQueue[a.studyNumber]?.dueDate)||'';
      const db=(b.custom?b.card.review?.due:reviewQueue[b.studyNumber]?.dueDate)||'';
      return da.localeCompare(db) || (a.displayNumber||a.studyNumber)-(b.displayNumber||b.studyNumber);
    });
    if(!qs.length){ alert('今日または期限超過の未消化問題はありません。待機中の問題は期日になるとここに残り続けます。'); return; }
    startSession(qs,'未消化の復習',null,null,false,'review');
  });
  $('levelFilterHome').addEventListener('change',renderHome);
  $('backHomeBtn').addEventListener('click',()=>showView('homeView'));
  $('listHomeBtn').addEventListener('click',()=>showView('homeView'));
  $('doubtsHomeBtn').addEventListener('click',()=>showView('homeView'));
  $('progressHomeBtn').addEventListener('click',()=>showView('homeView'));
  $('revealBtn').addEventListener('click',reveal);
  $('answerInput').addEventListener('keydown',e=>{if(e.key==='Enter') reveal();});
  $('saveDoubtBtn').addEventListener('click',createDoubt);
  document.querySelectorAll('.rate').forEach(b=>b.addEventListener('click',()=>rateCurrent(b.dataset.rating)));
  $('prevBtn').addEventListener('click',()=>{if(sessionIndex>0){sessionIndex--;renderQuestion();}});
  $('nextBtn').addEventListener('click',()=>{if(sessionIndex<session.length-1){sessionIndex++;renderQuestion();}});
  $('shuffleSessionBtn').addEventListener('click',()=>{session.sort(()=>Math.random()-.5);sessionIndex=0;renderQuestion();});
  $('explainBtn').addEventListener('click',openSlides);
  $('closeModalBtn').addEventListener('click',closeSlides);
  $('slidePrev').addEventListener('click',()=>{if(currentSlideIndex>0){currentSlideIndex--;renderSlide();}});
  $('slideNext').addEventListener('click',()=>{if(currentSlideIndex<currentSlides.length-1){currentSlideIndex++;renderSlide();}});
  $('slideModal').addEventListener('click',e=>{if(e.target===$('slideModal')) closeSlides();});
  document.addEventListener('keydown',e=>{
    if(!$('slideModal').classList.contains('hidden')){
      if(e.key==='Escape') closeSlides();
      if(e.key==='ArrowLeft') $('slidePrev').click();
      if(e.key==='ArrowRight') $('slideNext').click();
    }
  });
  let touchX=null;
  $('slideViewer').addEventListener('touchstart',e=>touchX=e.changedTouches[0].clientX,{passive:true});
  $('slideViewer').addEventListener('touchend',e=>{
    if(touchX===null)return;
    const delta=e.changedTouches[0].clientX-touchX;
    if(Math.abs(delta)>45)(delta>0?$('slidePrev'):$('slideNext')).click();
    touchX=null;
  },{passive:true});

  ['searchInput','themeFilter','levelFilter','statusFilter'].forEach(id=>$(id).addEventListener(id==='searchInput'?'input':'change',renderList));
  ['doubtSearchInput','doubtThemeFilter','doubtStatusFilter'].forEach(id=>$(id).addEventListener(id==='doubtSearchInput'?'input':'change',renderDoubts));
  $('exportBackupBtn').addEventListener('click',exportBackup);
  $('resetBtn').addEventListener('click',()=>{
    if(confirm('KTの学習進捗をリセットしますか？ 同期接続済みの場合は他の端末にも反映されます。疑問メモは削除されません。')){
      progress={};
      reviewQueue={};
      appState={lastStudyNumber:1,sessionPositions:{}};
      save();
      renderProgress();
    }
  });
  navBtns.forEach(b=>b.addEventListener('click',()=>showView(b.dataset.view)));

  // Filters options
  THEMES.forEach(t=>{
    const o=document.createElement('option');
    o.value=t; o.textContent=t;
    $('themeFilter').appendChild(o);
    const d=o.cloneNode(true);
    $('doubtThemeFilter').appendChild(d);
  });

  // Custom economy cards remain in their existing store; original question IDs never change.
  const qMedia=document.createElement('div');qMedia.id='customQuestionMedia';$('questionText').after(qMedia);
  const aMedia=document.createElement('div');aMedia.id='customAnswerMedia';$('officialAnswer').after(aMedia);
  const editCardButton=document.createElement('button');editCardButton.id='editIntegratedCard';editCardButton.type='button';editCardButton.className='secondary';editCardButton.textContent='この自作問題を編集';editCardButton.hidden=true;
  $('questionText').before(editCardButton);editCardButton.onclick=()=>{const q=currentQuestion();if(q?.custom)window.KT_CUSTOM.edit(q.card.id);};
  function renderCustomMedia(q){
    for(const [box,side] of [[qMedia,'q'],[aMedia,'a']]){
      box.replaceChildren();if(!q.custom)continue;
      for(const src of q.card[side+'Images']||[]){
        const b=document.createElement('button');b.type='button';b.className='kt-custom-image';b.setAttribute('aria-label','画像を拡大');
        const im=document.createElement('img');im.src=src;im.alt=side==='q'?'問いの画像':'答えの画像';b.append(im);b.onclick=()=>window.KT_CUSTOM.zoom(src);box.append(b);
      }
    }
    if(q.custom){for(const [label,value] of [['間違えた理由',q.card.note],['出典',q.card.source]]){if(!value)continue;const p=document.createElement('p');p.className='kt-custom-note';const b=document.createElement('b');b.textContent=label+'：';p.append(b,document.createTextNode(value));aMedia.append(p);}}
  }
  function updateCustomCards(cards){
    const custom=cards.filter(c=>c.subject==='economy'&&!c.deleted&&!c.draft).sort((a,b)=>(a.createdAt||'').localeCompare(b.createdAt||'')||a.id.localeCompare(b.id));
    DATA=[...ORIGINAL,...custom.map((c,i)=>({custom:true,card:c,studyNumber:'custom:'+c.id,displayNumber:ORIGINAL.length+i+1,question:c.question||'画像の問いに答えてください',answer:c.answer,theme:c.theme||c.field||'未分類',level:'custom',levelName:'自作',slides:[]}))];
    THEMES=[...new Set(DATA.map(q=>q.theme))];
    const select=$('themeFilter'),prior=select.value;
    select.replaceChildren(new Option('全テーマ','all'),...THEMES.map(t=>new Option(t,t)));
    select.value=THEMES.includes(prior)?prior:'all';
    // Replace the displayed session's cards by ID after edits/sync, dropping removed/draft cards.
    const before=currentQuestion(),wasRevealed=!$('answerPanel').classList.contains('hidden');
    const lookup=new Map(DATA.map(q=>[String(q.studyNumber),q]));
    session=session.map(q=>lookup.get(String(q.studyNumber))).filter(Boolean);
    if(before){const found=session.findIndex(q=>String(q.studyNumber)===String(before.studyNumber));sessionIndex=found>=0?found:Math.min(sessionIndex,Math.max(0,session.length-1));}
    renderHome();
    if($('listView').classList.contains('active'))renderList();
    if($('progressView').classList.contains('active'))renderProgress();
    if($('studyView').classList.contains('active') && before?.custom && !ratingBusy && JSON.stringify(before.card)!==JSON.stringify(currentQuestion()?.card)){
      if(session.length){const same=before.studyNumber===currentQuestion()?.studyNumber,typed=$('answerInput').value;renderQuestion();if(same){$('answerInput').value=typed;if(wasRevealed)reveal();}}else showView('homeView');
    }
  }
  for(const id of ['levelFilter','levelFilterHome'])$(id).append(new Option('自作','custom'));
  const add=document.createElement('button');add.id='addEconomyCard';add.className='secondary big';add.textContent='＋ 自作問題を追加';add.onclick=()=>window.KT_CUSTOM?.newEconomy();document.querySelector('#homeView .action-grid').append(add);
  document.querySelector('#progressView .backup-zone p').textContent='公式130問の学習記録と、自作カード（画像・復習履歴）は、それぞれのボタンから保存できます。';
  $('exportBackupBtn').textContent='公式130問の記録を書き出す';
  const cb=document.createElement('button');cb.className='secondary';cb.textContent='自作カードを書き出す';cb.onclick=()=>window.KT_CUSTOM?.export();$('exportBackupBtn').after(cb);
  // Shared KT data bridge. Applying cloud state must not generate a new local edit.
  window.KT_BRIDGE={
    updateCustomCards,
    snapshot:()=>JSON.parse(JSON.stringify({progress,appState,doubts,reviewQueue})),
    apply:(next)=>{
      const before={progress,appState,doubts,reviewQueue};
      const previous=[STORE_KEY,STATE_KEY,DOUBT_KEY,REVIEW_KEY].map(k=>[k,localStorage.getItem(k)]);
      suppressKTSync=true;
      try{progress=next.progress;appState=next.appState;doubts=next.doubts;reviewQueue=next.reviewQueue;save();}
      catch(error){({progress,appState,doubts,reviewQueue}=before);for(const [key,value] of previous){if(value===null)localStorage.removeItem(key);else localStorage.setItem(key,value);}throw error;}
      finally{suppressKTSync=false;}
      renderHome();
      if($('listView').classList.contains('active'))renderList();
      if($('doubtsView').classList.contains('active'))renderDoubts();
      if($('progressView').classList.contains('active'))renderProgress();
      if($('studyView').classList.contains('active'))renderCurrentDoubts();
    }
  };
  window.KT_BRIDGE.reloadLocal=()=>{
    progress=loadJSON(STORE_KEY,{});appState=loadJSON(STATE_KEY,{lastStudyNumber:1,sessionPositions:{}});doubts=loadJSON(DOUBT_KEY,[]);reviewQueue=loadJSON(REVIEW_KEY,{});
    renderHome();renderDoubtNavBadge();
    if($('listView').classList.contains('active'))renderList();
    if($('doubtsView').classList.contains('active'))renderDoubts();
    if($('progressView').classList.contains('active'))renderProgress();
  };
  let storageRefresh;
  window.addEventListener('storage',e=>{if([STORE_KEY,STATE_KEY,DOUBT_KEY,REVIEW_KEY].includes(e.key)){clearTimeout(storageRefresh);storageRefresh=setTimeout(()=>window.KT_BRIDGE.reloadLocal(),0);}});
  const versionTag=document.createElement('small');versionTag.textContent='v'+APP_VERSION;versionTag.id='ktAppVersion';versionTag.style.cssText='font-size:11px;color:#64748b;margin-left:8px;white-space:nowrap';
  document.querySelector('.appbar h1')?.append(versionTag);
  const heroDescription=document.querySelector('#homeView .hero p');if(heroDescription)heroDescription.textContent='学習順番号と元番号を併記。進捗は端末に保存され、同期設定後はPC・スマホ間で共有できます。';
  $('resetBtn').textContent='公式130問の進捗をリセット';
  const resetDescription=$('resetBtn')?.closest('.danger-zone')?.querySelector('p');if(resetDescription)resetDescription.textContent='公式130問の進捗・再開位置・復習キューをリセットします。同期接続済みの場合は他の端末にも反映されます。疑問メモと自作カードの記録は残ります。';
  // PWA install
  window.addEventListener('beforeinstallprompt',e=>{
    e.preventDefault();
    deferredPrompt=e;
    $('installBtn').classList.remove('hidden');
  });
  $('installBtn').addEventListener('click',async()=>{
    if(!deferredPrompt)return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt=null;
    $('installBtn').classList.add('hidden');
  });
  if('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('./sw.js');

  migrateCurrentBadProgress();
  renderDoubtNavBadge();
  renderHome();
})();

// v5.1: Import an existing KT backup, with a recoverable pre-import snapshot.
(() => {
  const exportButton = document.getElementById('exportBackupBtn');
  if (!exportButton) return;
  const keys = {progress:'kt-quiz-progress-v1', appState:'kt-quiz-state-v1', doubts:'kt-quiz-doubts-v2', reviewQueue:'kt-quiz-review-v3'};
  const rollbackKey = 'kt-quiz-before-import-v5';
  const questions = new Map((window.KT_DATA || []).map(q=>[String(q.studyNumber),q]));
  const object = x => !!x && typeof x === 'object' && !Array.isArray(x);
  const known = n => questions.has(String(n));
  const date = x => typeof x === 'string' && !Number.isNaN(Date.parse(x));
  function validate(data) {
    if (!object(data) || data.format !== 'kt-quiz-backup' || !object(data.progress) || !object(data.appState) || !Array.isArray(data.doubts) || !object(data.reviewQueue)) throw new Error('KTのバックアップJSONを選択してください。自作カードのバックアップはここでは読み込めません。');
    for (const [n,p] of Object.entries(data.progress)) if (!known(n) || !object(p) || !['good','meh','bad','unseen'].includes(p.rating) || !Number.isInteger(p.attempts) || p.attempts<0 || !date(p.lastSeen)) throw new Error('学習記録の形式が正しくありません。スマホから書き出し直してください。');
    for (const d of data.doubts) if (!object(d) || !known(d.studyNumber) || typeof d.id!=='string' || typeof d.text!=='string' || !['open','resolved'].includes(d.status)) throw new Error('疑問メモの形式が正しくありません。');
    for (const [n,r] of Object.entries(data.reviewQueue)) if (!known(n) || !object(r) || String(r.studyNumber)!==n || !Number.isInteger(r.stage) || r.stage<0 || r.stage>2 || !/^\d{4}-\d{2}-\d{2}$/.test(r.dueDate) || !date(r.dueDate)) throw new Error('復習キューの形式が正しくありません。');
    if (data.appState.lastStudyNumber != null && !known(data.appState.lastStudyNumber)) throw new Error('再開位置がこの問題集と一致しません。');
    if (data.appState.sessionPositions != null) {
      if (!object(data.appState.sessionPositions)) throw new Error('テーマ別再開位置の形式が正しくありません。');
      for (const entry of Object.values(data.appState.sessionPositions)) if (!object(entry) || !known(entry.studyNumber)) throw new Error('テーマ別再開位置がこの問題集と一致しません。');
    }
    return data;
  }
  function currentBackup() {
    const result = {format:'kt-quiz-backup', appVersion:'5.4.0', exportedAt:new Date().toISOString(), questionCount:questions.size};
    for (const [field,key] of Object.entries(keys)) result[field]=JSON.parse(localStorage.getItem(key)|| (field==='doubts'?'[]':'{}'));
    return result;
  }
  function write(data) {
    const before = Object.fromEntries(Object.values(keys).map(key=>[key,localStorage.getItem(key)]));
    try { for (const [field,key] of Object.entries(keys)) localStorage.setItem(key,JSON.stringify(data[field])); }
    catch (e) { for(const [key,value] of Object.entries(before)) { if(value===null)localStorage.removeItem(key);else localStorage.setItem(key,value); } throw e; }
  }
  const button = document.createElement('button');
  button.type='button';button.className='secondary';button.id='importKTBackupBtn';button.textContent='スマホのKT記録を読み込む';button.style.margin='8px';
  exportButton.insertAdjacentElement('afterend',button);
  const input=document.createElement('input');input.type='file';input.id='importKTBackupInput';input.accept='.json,application/json';input.hidden=true;button.after(input);button.onclick=()=>{input.value='';input.click();};
  input.onchange=async()=>{
    const file=input.files[0];if(!file)return;
    try {
      if(file.size>10*1024*1024)throw new Error('KTのバックアップは10MB以下のJSONを選択してください。');
      const data=validate(JSON.parse(await file.text()));
      const dialog=document.createElement('dialog');dialog.className='km-crop';dialog.id='ktImportDialog';
      const title=document.createElement('h2');title.textContent='スマホの記録をこの端末へ反映';
      const details=document.createElement('p');details.style.whiteSpace='pre-line';details.textContent=`選択ファイル：${file.name}\n学習済み：${Object.values(data.progress).filter(p=>p.rating!=='unseen').length}問\n疑問メモ：${data.doubts.length}件\n未消化の復習：${Object.keys(data.reviewQueue).length}件\n書き出し日時：${date(data.exportedAt)?new Date(data.exportedAt).toLocaleString('ja-JP'):'不明'}`;
      const note=document.createElement('p');note.textContent='この端末のKTの進捗・疑問メモ・復習キュー・再開位置を、選択した記録で置き換えます。元の記録は取り込み前バックアップとして端末に保管します。自作カードは変更しません。KT同期に接続済みの場合、この変更は他の端末にも反映されます。';
      const apply=document.createElement('button');apply.id='confirmKTImportBtn';apply.textContent='この記録を取り込む';
      const cancel=document.createElement('button');cancel.textContent='キャンセル';cancel.style.marginLeft='8px';cancel.onclick=()=>dialog.close();
      const error=document.createElement('p');error.setAttribute('role','alert');
      apply.onclick=()=>{apply.disabled=true;try{localStorage.setItem(rollbackKey,JSON.stringify(currentBackup()));write(data);location.reload();}catch(e){apply.disabled=false;error.textContent='保存できませんでした。元の記録を保ったまま中止しました。空き容量などを確認してください。';}};
      dialog.append(title,details,note,apply,cancel,error);document.body.append(dialog);dialog.addEventListener('close',()=>dialog.remove());dialog.showModal();
    }catch(e){alert(e instanceof SyntaxError?'JSONを読み取れませんでした。スマホから書き出したファイルをそのまま選択してください。':e.message);}
  };
  if(localStorage.getItem(rollbackKey)) {
    const restore=document.createElement('button');restore.id='restoreKTBackupBtn';restore.type='button';restore.className='ghost';restore.textContent='取り込み前のKT記録に戻す';restore.style.margin='8px';button.after(restore);
    restore.onclick=()=>{if(!confirm('KT記録を直前の取り込み前の状態に戻しますか？ 同期接続済みの場合は他の端末にも反映されます。'))return;try{const data=validate(JSON.parse(localStorage.getItem(rollbackKey)));write(data);location.reload();}catch{alert('復元できませんでした。バックアップJSONからの読み込みをお試しください。');}};
  }
})();
