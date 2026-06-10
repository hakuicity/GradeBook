// app.js — Gradebook PWA
'use strict';

// ── Constants ──────────────────────────────────────────────────────────────
const APP_LABELS = {
  eiken:      '🎓 英検アプリ',
  nh6:        '📗 NH6 練習',
  newhorizon: '📘 NH Vocab',
};
const APP_LEVELS = {
  eiken:      ['5','4','3','P'],
  nh6:        ['u1','u2','u3','u4','u5','u6','u7','u8'],
  newhorizon: ['colors','sports','animals','food','daily','time','weather','nature',
               'actions','descriptions','events','jobs','clubs','things',
               'stationery','clothes','family','people','feelings','numbers','shapes'],
};
const LEVEL_LABELS = {
  eiken: { '5':'5級','4':'4級','3':'3級','P':'準2級' },
  nh6:   { u1:'Unit 1',u2:'Unit 2',u3:'Unit 3',u4:'Unit 4',
            u5:'Unit 5',u6:'Unit 6',u7:'Unit 7',u8:'Unit 8' },
};
const EDGE_BASE = 'https://rfntsrcguhldybddfgcl.supabase.co/functions/v1';

// ── State ──────────────────────────────────────────────────────────────────
let _user = null, _profile = null;
let _students = [], _assignments = [], _quiz = [];
let _tab = 'grades';
let _selApp = 'nh6', _selLevel = 'u1', _selCat = '', _selClass = '';
let _dateFrom = '', _dateTo = '';
let _theme = localStorage.getItem('gb-theme') || 'light';
let _loginTab = 'email';
let _quizLoaded = false;

// ── Helpers ────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const fmt = d => d ? new Date(d).toLocaleDateString('ja-JP',{month:'numeric',day:'numeric'}) : '—';
const scoreColor = p => p >= 80 ? 'green' : p >= 60 ? 'amber' : 'red';
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
}

// ── Theme ──────────────────────────────────────────────────────────────────
function applyTheme() {
  document.body.classList.toggle('dark', _theme === 'dark');
  $('theme-btn').textContent = _theme === 'dark' ? '☀️' : '🌙';
}
$('theme-btn').onclick = () => {
  _theme = _theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('gb-theme', _theme);
  applyTheme();
};
applyTheme();

// ── Login ──────────────────────────────────────────────────────────────────
document.querySelectorAll('.modal-tab').forEach(tab => {
  tab.onclick = () => {
    _loginTab = tab.dataset.tab;
    document.querySelectorAll('.modal-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === _loginTab));
    $('login-email-form').style.display = _loginTab === 'email' ? '' : 'none';
    $('login-sid-form').style.display   = _loginTab === 'sid'   ? '' : 'none';
    $('login-err').classList.add('hidden');
  };
});

$('l-pass').addEventListener('keydown',    e => { if(e.key==='Enter') doLogin(); });
$('l-sidpass').addEventListener('keydown', e => { if(e.key==='Enter') doLogin(); });
$('login-btn').onclick = doLogin;
$('logout-btn').onclick = async () => {
  await window.hk.signOut();
  _user = _profile = null;
  showScreen('screen-login');
};

async function doLogin() {
  const btn = $('login-btn');
  const err = $('login-err');
  btn.disabled = true; btn.textContent = '処理中...';
  err.classList.add('hidden');
  try {
    if (_loginTab === 'sid') {
      const sid  = $('l-sid').value.trim();
      const pass = $('l-sidpass').value;
      if (!sid || !pass) throw new Error('学籍番号とパスワードを入力してください。');
      await window.hk.signInWithStudentId(sid, pass);
    } else {
      const email = $('l-email').value.trim();
      const pass  = $('l-pass').value;
      if (!email || !pass) throw new Error('メールとパスワードを入力してください。');
      await window.hk.signIn(email, pass);
    }
    await boot();
  } catch(e) {
    err.textContent = e.message || 'ログインに失敗しました。';
    err.classList.remove('hidden');
  } finally {
    btn.disabled = false; btn.textContent = 'ログイン';
  }
}

// ── Boot ───────────────────────────────────────────────────────────────────
function waitHk() {
  if (typeof window.hk === 'undefined') { setTimeout(waitHk, 60); return; }
  window.hk.getUser().then(user => {
    if (user) boot();
    else showScreen('screen-login');
  });
}
waitHk();

async function boot() {
  const user = await window.hk.getUser();
  if (!user) { showScreen('screen-login'); return; }
  _user = user;
  _profile = await window.hk.getProfile(user.id);

  if (!_profile || !['admin','teacher'].includes(_profile.role)) {
    $('login-err').textContent = 'このアプリは教師・管理者専用です。アクセス権限がありません。';
    $('login-err').classList.remove('hidden');
    await window.hk.signOut();
    showScreen('screen-login');
    return;
  }

  $('header-sub').textContent = (_profile.display_name || user.email) +
    ' (' + (_profile.role === 'teacher' ? '教師' : '管理者') + ')';

  await Promise.all([loadStudents(), loadAssignments()]);
  showScreen('screen-app');
  renderApp();
}

// ── Data ───────────────────────────────────────────────────────────────────
async function loadStudents() {
  let q = window.hk._client
    .from('profiles')
    .select('id,display_name,class_name,school,student_number,role')
    .eq('role', 'student');
  if (_profile && _profile.role === 'teacher') {
    // Filter by assigned school
    if (_profile.school) {
      q = q.eq('school', _profile.school);
    }
    // Filter by assigned classes if set — otherwise see all classes in their school
    if (_profile.assigned_classes && _profile.assigned_classes.length > 0) {
      q = q.in('class_name', _profile.assigned_classes);
    }
  }
  const { data } = await q.order('class_name').order('display_name');
  _students = data || [];
}

async function loadAssignments() {
  const { data } = await window.hk._client
    .from('assignments')
    .select('*')
    .order('created_at', { ascending: false });
  _assignments = data || [];
}

async function loadQuiz() {
  $('gb-table-area').innerHTML = '<div class="gb-loading">読み込み中...</div>';
  let q = window.hk._client.from('quiz_results')
    .select('user_id,correct,total,score_pct,created_at,level,category,app_id')
    .eq('app_id', _selApp);
  if (_selLevel) q = q.eq('level', _selLevel);
  if (_selCat)   q = q.eq('category', _selCat);
  if (_dateFrom) q = q.gte('created_at', _dateFrom);
  if (_dateTo)   q = q.lte('created_at', _dateTo + 'T23:59:59');
  const { data } = await q.order('created_at', { ascending: false });
  _quiz = data || [];
  _quizLoaded = true;
  renderGradeTable();
}

// ── Main render ─────────────────────────────────────────────────────────────
function renderApp() {
  if (!_profile) return;
  const canEdit = ['admin','teacher'].includes(_profile.role);
  const root = $('gb-root');
  root.innerHTML =
    '<div class="gb-wrap">' +
    '<div class="gb-nav-tabs">' +
    '<button class="gb-nav-tab' + (_tab==='grades'?' active':'') + '" id="tab-grades">📊 成績表</button>' +
    '<button class="gb-nav-tab' + (_tab==='assignments'?' active':'') + '" id="tab-asgn">📋 課題一覧 <span id="asgn-count">(' + _assignments.length + ')</span></button>' +
    '</div>' +
    '<div id="tab-body"></div>' +
    '</div>';

  $('tab-grades').onclick = () => { _tab = 'grades'; _quizLoaded = false; renderApp(); };
  $('tab-asgn').onclick   = () => { _tab = 'assignments'; renderApp(); };

  if (_tab === 'grades')      renderGradesTab();
  else                        renderAssignmentsTab(canEdit);
}

// ── Grades tab ─────────────────────────────────────────────────────────────
function renderGradesTab() {
  const classes = [...new Set(_students.map(s=>s.class_name).filter(Boolean))].sort();
  const levels  = APP_LEVELS[_selApp] || [];
  const cats    = _selApp === 'nh6'     ? ['','grammar','response','writing']
                : _selApp === 'eiken'   ? ['','ALL','READING','LISTENING','VOCABULARY']
                : [''];

  $('tab-body').innerHTML =
    '<div class="gb-filters">' +
    '<div class="gb-filter-group"><label>アプリ</label>' +
    '<select id="f-app">' + Object.entries(APP_LABELS).map(([k,v])=>'<option value="'+k+'"'+(k===_selApp?' selected':'')+'>'+v+'</option>').join('') + '</select></div>' +
    '<div class="gb-filter-group"><label>レベル / Unit</label>' +
    '<select id="f-level">' + levels.map(lv=>'<option value="'+lv+'"'+(lv===_selLevel?' selected':'')+'>'+esc((LEVEL_LABELS[_selApp]||{})[lv]||lv)+'</option>').join('') + '</select></div>' +
    (cats.length > 1 ?
    '<div class="gb-filter-group"><label>カテゴリー</label>' +
    '<select id="f-cat">' + cats.map(c=>'<option value="'+c+'"'+(c===_selCat?' selected':'')+'>'+(c||'全カテゴリー')+'</option>').join('') + '</select></div>' : '') +
    '<div class="gb-filter-group"><label>クラス</label>' +
    '<select id="f-class"><option value="">全クラス</option>' + classes.map(c=>'<option value="'+esc(c)+'"'+(c===_selClass?' selected':'')+'>'+esc(c)+'</option>').join('') + '</select></div>' +
    '<div class="gb-filter-group"><label>開始日</label><input type="date" id="f-from" value="'+esc(_dateFrom)+'"></div>' +
    '<div class="gb-filter-group"><label>終了日</label><input type="date" id="f-to" value="'+esc(_dateTo)+'"></div>' +
    '<div class="gb-filter-group" style="align-self:flex-end;display:flex;gap:8px">' +
    '<button class="btn-primary btn-sm" id="f-go">表示する</button>' +
    '<button class="btn-outline btn-sm" id="f-csv">CSV</button>' +
    '</div></div>' +
    '<div id="gb-table-area"><div class="gb-empty">フィルターを設定して「表示する」をクリックしてください。</div></div>';

  $('f-app').onchange = function() {
    _selApp = this.value;
    const lv = $('f-level');
    const newLevels = APP_LEVELS[_selApp] || [];
    lv.innerHTML = newLevels.map(l=>'<option value="'+l+'">'+esc((LEVEL_LABELS[_selApp]||{})[l]||l)+'</option>').join('');
    _selLevel = newLevels[0] || '';
  };

  $('f-go').onclick = async () => {
    _selApp   = $('f-app').value;
    _selLevel = $('f-level').value;
    _selCat   = $('f-cat') ? $('f-cat').value : '';
    _selClass = $('f-class').value;
    _dateFrom = $('f-from').value;
    _dateTo   = $('f-to').value;
    await loadQuiz();
  };

  $('f-csv').onclick = exportCSV;
}

function renderGradeTable() {
  const el = $('gb-table-area');
  const students = _selClass ? _students.filter(s=>s.class_name===_selClass) : _students;
  if (!students.length) { el.innerHTML = '<div class="gb-empty">生徒データがありません。</div>'; return; }

  const rows = students.map(s => {
    const sessions = _quiz.filter(q => q.user_id === s.id);
    if (!sessions.length) return { s, n:0, best:null, avg:null, last:null };
    const best = Math.max(...sessions.map(q=>q.score_pct||0));
    const tc = sessions.reduce((a,q)=>a+(q.correct||0),0);
    const tt = sessions.reduce((a,q)=>a+(q.total||0),0);
    const avg = tt > 0 ? Math.round(tc/tt*100) : null;
    const last = sessions.map(q=>q.created_at).sort().pop();
    return { s, n:sessions.length, best, avg, last };
  });

  const done = rows.filter(r=>r.n>0);
  const clsAvg = done.length ? Math.round(done.reduce((a,r)=>a+r.best,0)/done.length) : null;
  const lvLabel = (LEVEL_LABELS[_selApp]||{})[_selLevel] || _selLevel;

  el.innerHTML =
    '<div class="gb-summary">' +
    '<div class="gb-stat"><div class="gb-stat-num">' + students.length + '</div><div class="gb-stat-lbl">対象生徒</div></div>' +
    '<div class="gb-stat"><div class="gb-stat-num">' + done.length + '</div><div class="gb-stat-lbl">提出済み</div></div>' +
    '<div class="gb-stat"><div class="gb-stat-num">' + (students.length - done.length) + '</div><div class="gb-stat-lbl">未提出</div></div>' +
    (clsAvg !== null ? '<div class="gb-stat"><div class="gb-stat-num score-'+scoreColor(clsAvg)+'">' + clsAvg + '%</div><div class="gb-stat-lbl">クラス平均</div></div>' : '') +
    '</div>' +
    '<p style="font-size:12px;color:var(--text3);margin-bottom:10px">' +
    esc(APP_LABELS[_selApp]||_selApp) + ' &nbsp;›&nbsp; ' + esc(lvLabel) +
    (_selCat ? ' &nbsp;›&nbsp; ' + esc(_selCat) : '') +
    (_selClass ? ' &nbsp;·&nbsp; ' + esc(_selClass) : '') + '</p>' +
    '<div class="gb-table-wrap"><table class="gb-table">' +
    '<thead><tr><th>氏名</th><th>クラス</th><th>回数</th><th>最高点</th><th>平均</th><th>スコア</th><th>最終提出</th></tr></thead>' +
    '<tbody>' +
    rows.map(r => {
      if (!r.n) return '<tr>' +
        '<td><strong>'+esc(r.s.display_name||'')+'</strong></td>' +
        '<td style="color:var(--text3)">'+esc(r.s.class_name||'')+'</td>' +
        '<td><span class="badge badge-none">未提出</span></td>' +
        '<td>—</td><td>—</td><td>—</td><td>—</td></tr>';
      const c = scoreColor(r.best);
      return '<tr>' +
        '<td><strong>'+esc(r.s.display_name||'')+'</strong></td>' +
        '<td style="color:var(--text3)">'+esc(r.s.class_name||'')+'</td>' +
        '<td style="text-align:center">'+r.n+'</td>' +
        '<td class="score-'+c+'" style="font-weight:800">'+r.best+'%</td>' +
        '<td style="color:var(--text2)">'+(r.avg!==null?r.avg+'%':'—')+'</td>' +
        '<td><div class="gb-bar"><div class="gb-bar-fill fill-'+c+'" style="width:'+r.best+'%"></div></div></td>' +
        '<td style="color:var(--text3);font-size:12px">'+fmt(r.last)+'</td></tr>';
    }).join('') +
    '</tbody></table></div>';
}

// ── Assignments tab ─────────────────────────────────────────────────────────
function renderAssignmentsTab(canEdit) {
  const el = $('tab-body');
  el.innerHTML = '<div class="gb-wrap" style="padding-top:0">' +
    (canEdit ? '<button class="asgn-new" id="asgn-new-btn">＋ 新しい課題を作成する</button>' : '') +
    '<div class="asgn-grid" id="asgn-grid" style="margin-top:12px"></div>' +
    '</div>';

  if (canEdit) $('asgn-new-btn').onclick = () => openAssignmentModal(null);
  renderAsgnGrid();
}

function renderAsgnGrid() {
  const el = $('asgn-grid');
  const canEdit = _profile && ['admin','teacher'].includes(_profile.role);
  if (!_assignments.length) {
    el.innerHTML = '<div class="gb-empty" style="grid-column:1/-1">課題がまだありません。</div>';
    return;
  }
  el.innerHTML = _assignments.map(ag => {
    const lv = (LEVEL_LABELS[ag.app_id]||{})[ag.level] || ag.level || '全Unit';
    return '<div class="asgn-card">' +
      '<div class="asgn-title">'+esc(ag.title)+'</div>' +
      '<div class="asgn-meta">'+esc(APP_LABELS[ag.app_id]||ag.app_id)+' &nbsp;·&nbsp; '+esc(lv)+
        (ag.category?' / '+esc(ag.category):'')+
        (ag.class_name?' &nbsp;·&nbsp; '+esc(ag.class_name):' &nbsp;·&nbsp; 全クラス')+'</div>' +
      (ag.due_date?'<div style="font-size:12px;font-weight:700;color:var(--amber)">締切: '+esc(ag.due_date)+'</div>':'')+
      (ag.description?'<div style="font-size:12px;color:var(--text3)">'+esc(ag.description)+'</div>':'')+
      '<div class="asgn-actions">' +
      '<button class="btn-outline btn-sm" data-view="'+ag.id+'">📊 成績を見る</button>' +
      (canEdit?'<button class="btn-outline btn-sm" data-edit="'+ag.id+'">✎ 編集</button>'+
               '<button class="btn-outline btn-sm btn-danger" data-del="'+ag.id+'">🗑</button>':'')+
      '</div></div>';
  }).join('');

  el.querySelectorAll('[data-view]').forEach(b => b.onclick = () => viewAsgnGrades(b.dataset.view));
  el.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openAssignmentModal(_assignments.find(a=>a.id===b.dataset.edit)));
  el.querySelectorAll('[data-del]').forEach(b  => b.onclick = () => deleteAsgn(b.dataset.del));
}

async function viewAsgnGrades(agId) {
  const ag = _assignments.find(a=>a.id===agId);
  if (!ag) return;
  const students = ag.class_name ? _students.filter(s=>s.class_name===ag.class_name) : _students;

  let q = window.hk._client.from('quiz_results')
    .select('user_id,score_pct,correct,total,created_at')
    .eq('app_id', ag.app_id);
  if (ag.level)    q = q.eq('level', ag.level);
  if (ag.category) q = q.eq('category', ag.category);
  if (ag.due_date) q = q.lte('created_at', ag.due_date+'T23:59:59');
  const { data } = await q;
  const quiz = data || [];

  const rows = students.map(s => {
    const sessions = quiz.filter(r=>r.user_id===s.id);
    if (!sessions.length) return { s, n:0, best:null };
    return { s, n:sessions.length, best:Math.max(...sessions.map(r=>r.score_pct||0)) };
  });
  const done = rows.filter(r=>r.n>0);
  const avg  = done.length ? Math.round(done.reduce((a,r)=>a+r.best,0)/done.length) : null;
  const lv   = (LEVEL_LABELS[ag.app_id]||{})[ag.level] || ag.level || '';

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-back';
  backdrop.innerHTML =
    '<div class="modal-card">' +
    '<h2>'+esc(ag.title)+'</h2>' +
    '<p style="font-size:12px;color:var(--text3);margin-bottom:12px">'+
      esc(APP_LABELS[ag.app_id]||ag.app_id)+' · '+esc(lv)+
      (ag.class_name?' · 対象: '+esc(ag.class_name):'')+
      (ag.due_date?' · 締切: '+esc(ag.due_date):'')+
    '</p>'+
    '<div class="gb-summary" style="margin-bottom:12px">'+
      '<div class="gb-stat"><div class="gb-stat-num">'+done.length+'/'+students.length+'</div><div class="gb-stat-lbl">提出率</div></div>'+
      (avg!==null?'<div class="gb-stat"><div class="gb-stat-num score-'+scoreColor(avg)+'">'+avg+'%</div><div class="gb-stat-lbl">クラス平均</div></div>':'')+
    '</div>'+
    '<div style="max-height:45vh;overflow-y:auto;border-radius:8px;border:1.5px solid var(--border)">'+
    '<table class="gb-table"><thead><tr><th>氏名</th><th>クラス</th><th>最高点</th><th>状態</th></tr></thead><tbody>'+
    rows.map(r =>
      r.n ?
      '<tr><td><strong>'+esc(r.s.display_name||'')+'</strong></td><td>'+esc(r.s.class_name||'')+'</td>'+
        '<td class="score-'+scoreColor(r.best)+'" style="font-weight:800">'+r.best+'%</td>'+
        '<td><span class="badge badge-done">提出済み</span></td></tr>'
      :
      '<tr><td><strong>'+esc(r.s.display_name||'')+'</strong></td><td>'+esc(r.s.class_name||'')+'</td>'+
        '<td>—</td><td><span class="badge badge-none">未提出</span></td></tr>'
    ).join('')+
    '</tbody></table></div>'+
    '<div class="modal-foot">'+
    '<button class="btn-outline btn-sm" id="v-csv">CSV出力</button>'+
    '<button class="btn-primary btn-sm" id="v-close">閉じる</button>'+
    '</div></div>';

  document.body.appendChild(backdrop);
  backdrop.querySelector('#v-close').onclick = () => backdrop.remove();
  backdrop.onclick = e => { if(e.target===backdrop) backdrop.remove(); };
  backdrop.querySelector('#v-csv').onclick = () => {
    const csvRows = ['氏名,クラス,最高点,状態', ...rows.map(r=>
      ['"'+(r.s.display_name||'')+'"','"'+(r.s.class_name||'')+'"',
       r.n?r.best+'%':'',r.n?'提出済み':'未提出'].join(','))];
    const blob = new Blob(['\uFEFF'+csvRows.join('\n')],{type:'text/csv'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (ag.title||'grades')+'.csv';
    a.click();
  };
}

// ── Assignment modal ────────────────────────────────────────────────────────
function openAssignmentModal(existing) {
  const classes = [...new Set(_students.map(s=>s.class_name).filter(Boolean))].sort();
  const ag = existing || {};
  const isNew = !existing;

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-back';
  backdrop.innerHTML =
    '<div class="modal-card">' +
    '<h2>'+(isNew?'新しい課題':'課題を編集')+'</h2>'+
    '<div class="field"><label>タイトル *</label>'+
    '<input type="text" id="ag-title" placeholder="例：Unit 3 文法テスト" value="'+esc(ag.title||'')+'"></div>'+
    '<div class="field"><label>説明（任意）</label>'+
    '<input type="text" id="ag-desc" placeholder="任意のメモ" value="'+esc(ag.description||'')+'"></div>'+
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">'+
    '<div class="field"><label>アプリ</label>'+
    '<select id="ag-app">'+Object.entries(APP_LABELS).map(([k,v])=>'<option value="'+k+'"'+(k===(ag.app_id||'nh6')?' selected':'')+'>'+v+'</option>').join('')+'</select></div>'+
    '<div class="field"><label>レベル / Unit</label>'+
    '<select id="ag-level"><option value="">全体</option>'+
    (APP_LEVELS[ag.app_id||'nh6']||[]).map(lv=>'<option value="'+lv+'"'+(lv===ag.level?' selected':'')+'>'+esc((LEVEL_LABELS[ag.app_id||'nh6']||{})[lv]||lv)+'</option>').join('')+
    '</select></div>'+
    '</div>'+
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">'+
    '<div class="field"><label>対象クラス</label>'+
    '<select id="ag-class"><option value="">全クラス</option>'+classes.map(c=>'<option value="'+esc(c)+'"'+(c===ag.class_name?' selected':'')+'>'+esc(c)+'</option>').join('')+'</select></div>'+
    '<div class="field"><label>締め切り日</label><input type="date" id="ag-due" value="'+esc(ag.due_date||'')+'"></div>'+
    '</div>'+
    '<div class="modal-foot">'+
    '<button class="btn-outline btn-sm" id="ag-cancel">キャンセル</button>'+
    '<button class="btn-primary btn-sm" id="ag-save">保存する</button>'+
    '</div></div>';

  document.body.appendChild(backdrop);
  backdrop.querySelector('#ag-cancel').onclick = () => backdrop.remove();
  backdrop.onclick = e => { if(e.target===backdrop) backdrop.remove(); };

  backdrop.querySelector('#ag-app').onchange = function() {
    const lv = backdrop.querySelector('#ag-level');
    lv.innerHTML = '<option value="">全体</option>' +
      (APP_LEVELS[this.value]||[]).map(l=>'<option value="'+l+'">'+esc((LEVEL_LABELS[this.value]||{})[l]||l)+'</option>').join('');
  };

  backdrop.querySelector('#ag-save').onclick = async () => {
    const title = backdrop.querySelector('#ag-title').value.trim();
    if (!title) { alert('タイトルを入力してください。'); return; }
    const payload = {
      title,
      description: backdrop.querySelector('#ag-desc').value.trim()||null,
      app_id:      backdrop.querySelector('#ag-app').value,
      level:       backdrop.querySelector('#ag-level').value||null,
      class_name:  backdrop.querySelector('#ag-class').value||null,
      due_date:    backdrop.querySelector('#ag-due').value||null,
      created_by:  _user.id,
    };
    const { error } = isNew
      ? await window.hk._client.from('assignments').insert(payload)
      : await window.hk._client.from('assignments').update(payload).eq('id', existing.id);
    if (error) { alert('エラー: '+error.message); return; }
    backdrop.remove();
    await loadAssignments();
    $('asgn-count').textContent = '('+_assignments.length+')';
    renderAsgnGrid();
  };
}

async function deleteAsgn(id) {
  if (!confirm('この課題を削除しますか？')) return;
  await window.hk._client.from('assignments').delete().eq('id', id);
  _assignments = _assignments.filter(a=>a.id!==id);
  $('asgn-count').textContent = '('+_assignments.length+')';
  renderAsgnGrid();
}

// ── CSV export ─────────────────────────────────────────────────────────────
function exportCSV() {
  if (!_quizLoaded) { alert('先にデータを表示してください。'); return; }
  const students = _selClass ? _students.filter(s=>s.class_name===_selClass) : _students;
  const rows = ['氏名,クラス,学籍番号,回数,最高点,平均'];
  students.forEach(s => {
    const sessions = _quiz.filter(q=>q.user_id===s.id);
    if (!sessions.length) { rows.push(['"'+s.display_name+'"','"'+(s.class_name||'')+'"','"'+(s.student_number||'')+'"','0','未提出','未提出'].join(',')); return; }
    const best = Math.max(...sessions.map(q=>q.score_pct||0));
    const tc = sessions.reduce((a,q)=>a+(q.correct||0),0);
    const tt = sessions.reduce((a,q)=>a+(q.total||0),0);
    const avg = tt>0?Math.round(tc/tt*100)+'%':'—';
    rows.push(['"'+s.display_name+'"','"'+(s.class_name||'')+'"','"'+(s.student_number||'')+'"',sessions.length,best+'%',avg].join(','));
  });
  const blob = new Blob(['\uFEFF'+rows.join('\n')],{type:'text/csv'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = _selApp+'_'+_selLevel+'_grades.csv';
  a.click();
}
