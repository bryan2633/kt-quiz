(() => {
  const DATA = window.KT_DATA || [];
  const THEMES = [...new Set(DATA.map(q => q.theme))];
  const STORE_KEY = 'kt-quiz-progress-v1';
  const STATE_KEY = 'kt-quiz-state-v1';
  let progress = loadJSON(STORE_KEY, {});
  let appState = loadJSON(STATE_KEY, { lastStudyNumber: 1 });
  let session = [];
  let sessionIndex = 0;
  let currentSlides = [];
  let currentSlideIndex = 0;
  let deferredPrompt = null;

  const $ = id => document.getElementById(id);
  const views = [...document.querySelectorAll('.view')];
  const navBtns = [...document.querySelectorAll('.nav-btn')];

  function loadJSON(k, fallback){ try { return JSON.parse(localStorage.getItem(k)) || fallback; } catch { return fallback; } }
  function save(){ localStorage.setItem(STORE_KEY, JSON.stringify(progress)); localStorage.setItem(STATE_KEY, JSON.stringify(appState)); }
  function statusFor(q){ return progress[q.studyNumber]?.rating || 'unseen'; }
  function esc(s){ return String(s).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
  function highlightTarget(question, n){ const safe=esc(question); const re=new RegExp(`（${n}）`, 'g'); return safe.replace(re, `<mark>（${n}）</mark>`); }
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
    const n=normalize(input); const candidates=candidateAnswers(ans).map(normalize);
    return candidates.includes(n) ? '入力は公式解答と一致しています。' : '表記差もあり得るため、公式解答と見比べて自己評価してください。';
  }

  function showView(id){
    views.forEach(v => v.classList.toggle('active', v.id===id));
    navBtns.forEach(b => b.classList.toggle('active', b.dataset.view===id));
    if(id==='homeView') renderHome();
    if(id==='listView') renderList();
    if(id==='progressView') renderProgress();
    window.scrollTo({top:0,behavior:'instant'});
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
      const b=document.createElement('button'); b.className='theme-card'; b.type='button';
      b.innerHTML=`<div class="theme-name">${esc(theme)}</div><div class="theme-meta">${done} / ${qs.length} 学習済み</div><div class="mini-progress"><span style="width:${done/qs.length*100}%"></span></div>`;
      b.addEventListener('click',()=>startSession(qs, `${theme}${level==='all'?'':` / ${level}`}`));
      $('themeGrid').appendChild(b);
    });
  }

  function startSession(qs,label, startStudyNo=null){
    session=[...qs];
    if(!session.length){ alert('対象となる問題がありません。'); return; }
    sessionIndex=0;
    if(startStudyNo){ const idx=session.findIndex(q=>q.studyNumber===startStudyNo); if(idx>=0) sessionIndex=idx; }
    $('sessionLabel').textContent=label;
    showView('studyView'); renderQuestion();
  }

  function renderQuestion(){
    const q=session[sessionIndex]; if(!q) return;
    appState.lastStudyNumber=q.studyNumber; save();
    $('studyNo').textContent=`学習順 ${String(q.studyNumber).padStart(3,'0')}`;
    $('origNo').textContent=`元(${q.originalNumber})`;
    $('themePill').textContent=q.theme;
    $('levelPill').textContent=`${q.level} ${q.levelName}`;
    $('targetBlank').textContent=`（${q.originalNumber}）`;
    $('questionText').innerHTML=highlightTarget(q.question,q.originalNumber);
    $('answerInput').value='';
    $('answerPanel').classList.add('hidden');
    $('officialAnswer').textContent=q.answer;
    $('inputCompare').textContent='';
    document.querySelectorAll('.rate').forEach(b=>b.classList.toggle('selected', b.dataset.rating===statusFor(q)));
    $('sessionPos').textContent=`${sessionIndex+1} / ${session.length}`;
    $('prevBtn').disabled=sessionIndex===0;
    $('nextBtn').disabled=sessionIndex===session.length-1;
  }

  function reveal(){
    const q=session[sessionIndex];
    $('officialAnswer').textContent=q.answer;
    $('inputCompare').textContent=compareInput($('answerInput').value,q.answer);
    $('answerPanel').classList.remove('hidden');
  }

  function rateCurrent(rating){
    const q=session[sessionIndex];
    const p=progress[q.studyNumber] || {attempts:0};
    progress[q.studyNumber]={rating, attempts:(p.attempts||0)+1, lastSeen:new Date().toISOString()};
    save();
    document.querySelectorAll('.rate').forEach(b=>b.classList.toggle('selected', b.dataset.rating===rating));
    setTimeout(()=>{ if(sessionIndex<session.length-1){sessionIndex++;renderQuestion();} else renderHome(); },170);
  }

  function openSlides(){
    const q=session[sessionIndex]; currentSlides=q.slides||[]; currentSlideIndex=0;
    $('slideModal').classList.remove('hidden'); document.body.style.overflow='hidden';
    if(!currentSlides.length){
      $('noSlideMessage').classList.remove('hidden'); $('slideViewer').classList.add('hidden'); $('slideTitle').textContent=`元(${q.originalNumber}) の解説`;
    } else {
      $('noSlideMessage').classList.add('hidden'); $('slideViewer').classList.remove('hidden'); renderSlide();
    }
  }
  function closeSlides(){ $('slideModal').classList.add('hidden'); document.body.style.overflow=''; }
  function renderSlide(){
    const s=currentSlides[currentSlideIndex];
    $('slideImage').src=s.image; $('slideImage').alt=`PowerPoint スライド ${s.number}: ${s.title}`;
    $('slideTitle').textContent=s.title;
    $('slideCounter').textContent=`スライド ${s.number} ・ ${currentSlideIndex+1}/${currentSlides.length}`;
    $('slidePrev').disabled=currentSlideIndex===0; $('slideNext').disabled=currentSlideIndex===currentSlides.length-1;
  }

  function renderList(){
    const search=$('searchInput').value.trim().toLowerCase();
    const theme=$('themeFilter').value, level=$('levelFilter').value, st=$('statusFilter').value;
    const qs=DATA.filter(q=>{
      const hay=`${q.studyNumber} ${q.originalNumber} ${q.question} ${q.answer}`.toLowerCase();
      return (!search||hay.includes(search)) && (theme==='all'||q.theme===theme) && (level==='all'||q.level===level) && (st==='all'||statusFor(q)===st);
    });
    $('questionList').innerHTML='';
    qs.forEach(q=>{
      const s=statusFor(q); const symbol={unseen:'–',good:'○',meh:'△',bad:'×'}[s];
      const row=document.createElement('button'); row.type='button'; row.className='list-row';
      row.innerHTML=`<div class="list-num">${String(q.studyNumber).padStart(3,'0')}</div><div class="list-body"><div class="list-q">${esc(q.question)}</div><div class="list-meta">元(${q.originalNumber})・${esc(q.theme)}・${q.level} ${q.levelName}</div></div><div class="status-dot ${s}">${symbol}</div>`;
      row.addEventListener('click',()=>startSession(DATA,'全130問',q.studyNumber));
      $('questionList').appendChild(row);
    });
  }

  function renderProgress(){
    const summary=$('progressSummary'); summary.innerHTML='';
    const make=(name,qs)=>{
      const counts={good:0,meh:0,bad:0,unseen:0}; qs.forEach(q=>counts[statusFor(q)]++);
      const d=document.createElement('div'); d.className='progress-card';
      d.innerHTML=`<h3>${esc(name)}</h3><div class="progress-bars"><div class="pstat"><strong>${counts.good}</strong><span>○ できた</span></div><div class="pstat"><strong>${counts.meh}</strong><span>△ 微妙</span></div><div class="pstat"><strong>${counts.bad}</strong><span>× できなかった</span></div><div class="pstat"><strong>${counts.unseen}</strong><span>未学習</span></div></div>`;
      summary.appendChild(d);
    };
    make('全体',DATA); THEMES.forEach(t=>make(t,DATA.filter(q=>q.theme===t)));
  }

  // Events
  $('continueBtn').addEventListener('click',()=>startSession(DATA,'学習順',appState.lastStudyNumber||1));
  $('randomBtn').addEventListener('click',()=>{const x=[...DATA].sort(()=>Math.random()-.5);startSession(x,'ランダム');});
  $('reviewBtn').addEventListener('click',()=>startSession(DATA.filter(q=>['meh','bad'].includes(statusFor(q))),'△・× 復習'));
  $('levelFilterHome').addEventListener('change',renderHome);
  $('backHomeBtn').addEventListener('click',()=>showView('homeView'));
  $('listHomeBtn').addEventListener('click',()=>showView('homeView'));
  $('progressHomeBtn').addEventListener('click',()=>showView('homeView'));
  $('revealBtn').addEventListener('click',reveal);
  $('answerInput').addEventListener('keydown',e=>{if(e.key==='Enter') reveal();});
  document.querySelectorAll('.rate').forEach(b=>b.addEventListener('click',()=>rateCurrent(b.dataset.rating)));
  $('prevBtn').addEventListener('click',()=>{if(sessionIndex>0){sessionIndex--;renderQuestion();}});
  $('nextBtn').addEventListener('click',()=>{if(sessionIndex<session.length-1){sessionIndex++;renderQuestion();}});
  $('shuffleSessionBtn').addEventListener('click',()=>{session.sort(()=>Math.random()-.5);sessionIndex=0;renderQuestion();});
  $('explainBtn').addEventListener('click',openSlides);
  $('closeModalBtn').addEventListener('click',closeSlides);
  $('slidePrev').addEventListener('click',()=>{if(currentSlideIndex>0){currentSlideIndex--;renderSlide();}});
  $('slideNext').addEventListener('click',()=>{if(currentSlideIndex<currentSlides.length-1){currentSlideIndex++;renderSlide();}});
  $('slideModal').addEventListener('click',e=>{if(e.target===$('slideModal')) closeSlides();});
  document.addEventListener('keydown',e=>{if(!$('slideModal').classList.contains('hidden')){if(e.key==='Escape')closeSlides(); if(e.key==='ArrowLeft')$('slidePrev').click(); if(e.key==='ArrowRight')$('slideNext').click();}});
  let touchX=null; $('slideViewer').addEventListener('touchstart',e=>touchX=e.changedTouches[0].clientX,{passive:true}); $('slideViewer').addEventListener('touchend',e=>{if(touchX===null)return;const d=e.changedTouches[0].clientX-touchX;if(Math.abs(d)>45)(d>0?$('slidePrev'):$('slideNext')).click();touchX=null;},{passive:true});
  ['searchInput','themeFilter','levelFilter','statusFilter'].forEach(id=>$(id).addEventListener(id==='searchInput'?'input':'change',renderList));
  $('resetBtn').addEventListener('click',()=>{if(confirm('進捗をリセットしますか？')){progress={};appState={lastStudyNumber:1};save();renderProgress();}});
  navBtns.forEach(b=>b.addEventListener('click',()=>showView(b.dataset.view)));

  // Filters options
  THEMES.forEach(t=>{const o=document.createElement('option');o.value=t;o.textContent=t;$('themeFilter').appendChild(o);});

  // PWA install
  window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredPrompt=e;$('installBtn').classList.remove('hidden');});
  $('installBtn').addEventListener('click',async()=>{if(!deferredPrompt)return;deferredPrompt.prompt();await deferredPrompt.userChoice;deferredPrompt=null;$('installBtn').classList.add('hidden');});
  if('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('./sw.js');

  renderHome();
})();
