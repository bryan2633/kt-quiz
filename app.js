(() => {
  const DATA = window.KT_DATA || [];
  const THEMES = [...new Set(DATA.map(q => q.theme))];
  // Keep the existing v1 keys so users upgrading from v1 retain their progress.
  const STORE_KEY = 'kt-quiz-progress-v1';
  const STATE_KEY = 'kt-quiz-state-v1';
  const DOUBT_KEY = 'kt-quiz-doubts-v2';
  const APP_VERSION = '2.0.0';

  let progress = loadJSON(STORE_KEY, {});
  let appState = loadJSON(STATE_KEY, { lastStudyNumber: 1 });
  let doubts = loadJSON(DOUBT_KEY, []);
  if (!Array.isArray(doubts)) doubts = [];

  let session = [];
  let sessionIndex = 0;
  let currentSlides = [];
  let currentSlideIndex = 0;
  let slideSourceQuestion = null;
  let deferredPrompt = null;

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
    renderDoubtNavBadge();
  }

  function statusFor(q){ return progress[q.studyNumber]?.rating || 'unseen'; }
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
  function questionForStudyNumber(studyNumber){ return DATA.find(q => q.studyNumber === Number(studyNumber)) || null; }
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
    $('progressBar').style.width=`${seen/DATA.length*100}%`;
    const level=$('levelFilterHome').value;
    $('themeGrid').innerHTML='';
    THEMES.forEach(theme=>{
      const qs=DATA.filter(q=>q.theme===theme && (level==='all'||q.level===level));
      if(!qs.length) return;
      const done=qs.filter(q=>statusFor(q)!=='unseen').length;
      const b=document.createElement('button');
      b.className='theme-card';
      b.type='button';
      b.innerHTML=`<div class="theme-name">${esc(theme)}</div><div class="theme-meta">${done} / ${qs.length} 学習済み</div><div class="mini-progress"><span style="width:${done/qs.length*100}%"></span></div>`;
      b.addEventListener('click',()=>startSession(qs, `${theme}${level==='all'?'':` / ${level}`}`));
      $('themeGrid').appendChild(b);
    });
  }

  function startSession(qs,label,startStudyNo=null){
    session=[...qs];
    if(!session.length){ alert('対象となる問題がありません。'); return; }
    sessionIndex=0;
    if(startStudyNo){
      const idx=session.findIndex(q=>q.studyNumber===Number(startStudyNo));
      if(idx>=0) sessionIndex=idx;
    }
    $('sessionLabel').textContent=label;
    showView('studyView');
    renderQuestion();
  }

  function renderQuestion(){
    const q=currentQuestion();
    if(!q) return;
    appState.lastStudyNumber=q.studyNumber;
    save();
    $('studyNo').textContent=`学習順 ${String(q.studyNumber).padStart(3,'0')}`;
    $('origNo').textContent=`元(${q.originalNumber})`;
    $('themePill').textContent=q.theme;
    $('levelPill').textContent=`${q.level} ${q.levelName}`;
    $('targetBlank').textContent=`（${q.originalNumber}）`;
    $('questionText').innerHTML=highlightTarget(q.question,q.originalNumber);
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
    $('inputCompare').textContent=compareInput($('answerInput').value,q.answer);
    $('answerPanel').classList.remove('hidden');
    renderCurrentDoubts();
  }

  function rateCurrent(rating){
    const q=currentQuestion();
    if(!q) return;
    const p=progress[q.studyNumber] || {attempts:0};
    progress[q.studyNumber]={rating, attempts:(p.attempts||0)+1, lastSeen:new Date().toISOString()};
    save();
    document.querySelectorAll('.rate').forEach(b=>b.classList.toggle('selected', b.dataset.rating===rating));
    setTimeout(()=>{
      if(sessionIndex<session.length-1){
        sessionIndex++;
        renderQuestion();
      } else {
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
      card.querySelector('.js-open-question').addEventListener('click',()=>startSession(DATA,'全130問',d.studyNumber));
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
    const qs=DATA.filter(q=>{
      const hay=`${q.studyNumber} ${q.originalNumber} ${q.question} ${q.answer}`.toLowerCase();
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
      row.innerHTML=`<div class="list-num">${String(q.studyNumber).padStart(3,'0')}</div><div class="list-body"><div class="list-q">${esc(q.question)}</div><div class="list-meta">元(${q.originalNumber})・${esc(q.theme)}・${q.level} ${q.levelName}${noteCount?`・未解決の疑問 ${noteCount}件`:''}</div></div><div class="status-dot ${s}">${symbol}</div>`;
      row.addEventListener('click',()=>startSession(DATA,'全130問',q.studyNumber));
      $('questionList').appendChild(row);
    });
  }

  function renderProgress(){
    const summary=$('progressSummary');
    summary.innerHTML='';
    const make=(name,qs)=>{
      const counts={good:0,meh:0,bad:0,unseen:0};
      qs.forEach(q=>counts[statusFor(q)]++);
      const d=document.createElement('div');
      d.className='progress-card';
      d.innerHTML=`<h3>${esc(name)}</h3><div class="progress-bars"><div class="pstat"><strong>${counts.good}</strong><span>○ できた</span></div><div class="pstat"><strong>${counts.meh}</strong><span>△ 微妙</span></div><div class="pstat"><strong>${counts.bad}</strong><span>× できなかった</span></div><div class="pstat"><strong>${counts.unseen}</strong><span>未学習</span></div></div>`;
      summary.appendChild(d);
    };
    make('全体',DATA);
    THEMES.forEach(t=>make(t,DATA.filter(q=>q.theme===t)));
  }

  // ---- Backup ----------------------------------------------------------------------------
  function backupObject(){
    return {
      format:'kt-quiz-backup',
      appVersion:APP_VERSION,
      exportedAt:new Date().toISOString(),
      questionCount:DATA.length,
      progress,
      appState,
      doubts
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
  $('continueBtn').addEventListener('click',()=>startSession(DATA,'学習順',appState.lastStudyNumber||1));
  $('randomBtn').addEventListener('click',()=>{const x=[...DATA].sort(()=>Math.random()-.5);startSession(x,'ランダム');});
  $('reviewBtn').addEventListener('click',()=>startSession(DATA.filter(q=>['meh','bad'].includes(statusFor(q))),'△・× 復習'));
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
    if(confirm('学習進捗をリセットしますか？ 疑問メモは削除されません。')){
      progress={};
      appState={lastStudyNumber:1};
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

  renderDoubtNavBadge();
  renderHome();
})();
