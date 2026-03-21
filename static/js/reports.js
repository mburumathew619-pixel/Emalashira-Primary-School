/**
 * reports.js — EMALASHIRA Primary School
 * Full generate + preview + schedule + custom report builder
 */

const API = "https://emalashira-primary-school.onrender.com";
let _currentReportData  = null;  // holds last generated report for download
let _currentReportTitle = '';
let _scheduledReports   = JSON.parse(localStorage.getItem('scheduledReports') || '[]');

// ── Helpers ────────────────────────────────────────────────────
function fmt(n)     { return 'KSh ' + Number(n || 0).toLocaleString(); }
function fmtDate(d) { return d ? new Date(d).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}) : '—'; }

async function safeFetch(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

function showToast(msg, type = 'success') {
  let t = document.getElementById('rptToast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'rptToast';
    t.style.cssText = 'position:fixed;bottom:24px;right:24px;padding:12px 20px;border-radius:8px;'
      + 'font-size:.9rem;z-index:9999;color:#fff;box-shadow:0 4px 16px rgba(0,0,0,.2);transition:opacity .35s;max-width:360px;';
    document.body.appendChild(t);
  }
  t.style.background = type === 'error' ? '#dc2626' : type === 'warning' ? '#d97706' : '#065f46';
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(t._t);
  t._t = setTimeout(() => { t.style.opacity = '0'; }, 4000);
}

// ── Modal helpers ──────────────────────────────────────────────
function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
}
function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'flex';
}
function openReportBuilder() { openModal('reportBuilderModal'); }
function scheduleReport()    { openModal('scheduleReportModal'); }

// Close modals on backdrop click
document.addEventListener('click', e => {
  ['reportViewerModal','generateParamsModal'].forEach(id => {
    const el = document.getElementById(id);
    if (el && e.target === el) el.style.display = 'none';
  });
});

// ── Report Viewer ──────────────────────────────────────────────
function openReportViewer(title, meta, html, data, headers) {
  _currentReportTitle = title;
  _currentReportData  = { data, headers };
  document.getElementById('reportViewerTitle').textContent = title;
  document.getElementById('reportViewerMeta').textContent  = meta;
  document.getElementById('reportViewerBody').innerHTML    = html;
  openModal('reportViewerModal');
}

function downloadCurrentReport() {
  if (!_currentReportData || !_currentReportData.data) {
    showToast('No report data to download', 'error'); return;
  }
  const { data, headers } = _currentReportData;
  const rows = [headers, ...data.map(r => headers.map(h => String(r[h] ?? r[h.toLowerCase()] ?? '—')))];
  const csv  = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const a    = Object.assign(document.createElement('a'), {
    href:     URL.createObjectURL(new Blob([csv], { type:'text/csv' })),
    download: `${_currentReportTitle.replace(/\s+/g,'-')}-${new Date().toISOString().split('T')[0]}.csv`
  });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  showToast(`Downloaded: ${_currentReportTitle}`);
}

// ── Shared table renderer ──────────────────────────────────────
function renderTable(columns, rows, emptyMsg = 'No data found.') {
  if (!rows || rows.length === 0) {
    return `<div style="text-align:center;padding:3rem;color:#9ca3af;font-style:italic;">${emptyMsg}</div>`;
  }
  const th  = columns.map(c => `<th style="padding:0.55rem 0.9rem;background:#f0fdf4;color:#065f46;font-weight:700;
      font-size:0.78rem;text-transform:uppercase;border-bottom:2px solid #d1fae5;white-space:nowrap;text-align:left;">${c.label}</th>`).join('');
  const trs = rows.map(row => `<tr style="border-bottom:1px solid #f3f4f6;" onmouseenter="this.style.background='#f9fafb'" onmouseleave="this.style.background=''">
    ${columns.map(c => {
      const val = row[c.key] ?? '—';
      const cell = c.badge
        ? `<span style="background:${c.badge(val).bg};color:${c.badge(val).text};padding:0.15rem 0.55rem;border-radius:999px;font-size:0.78rem;font-weight:600;">${val}</span>`
        : `<span>${val}</span>`;
      return `<td style="padding:0.55rem 0.9rem;font-size:0.86rem;color:#374151;">${cell}</td>`;
    }).join('')}
  </tr>`).join('');
  return `<div style="overflow-x:auto;">
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr>${th}</tr></thead>
      <tbody>${trs}</tbody>
    </table>
    <div style="padding:0.75rem 1rem;font-size:0.78rem;color:#9ca3af;border-top:1px solid #f3f4f6;">
      ${rows.length} record${rows.length!==1?'s':''} · Generated ${new Date().toLocaleString('en-GB')}
    </div>
  </div>`;
}

function summaryBox(items) {
  return `<div style="display:flex;flex-wrap:wrap;gap:1rem;margin-bottom:1.5rem;">
    ${items.map(item => `
      <div style="background:${item.bg||'#f0fdf4'};border-radius:10px;padding:1rem 1.25rem;flex:1;min-width:130px;text-align:center;">
        <div style="font-size:1.5rem;font-weight:800;color:${item.color||'#065f46'};">${item.value}</div>
        <div style="font-size:0.78rem;color:#6b7280;margin-top:2px;">${item.label}</div>
      </div>`).join('')}
  </div>`;
}

// ══════════════════════════════════════════════════════════════
//  ACADEMIC REPORTS
// ══════════════════════════════════════════════════════════════

async function buildReportCard(params) {
  showToast('Generating report cards…', 'warning');
  const cls  = params.class  || '';
  const term = params.term   || '';
  let url = `${API}/api/grades`;
  if (cls)  url += `?class=${encodeURIComponent(cls)}`;
  if (term) url += (url.includes('?') ? '&' : '?') + `term=${encodeURIComponent(term)}`;

  const grades   = await safeFetch(url) || [];
  const students = await safeFetch(`${API}/api/students`) || [];

  // Group grades by student
  const byStudent = {};
  grades.forEach(g => {
    const sid = g.student_id || g.admission_no;
    if (!byStudent[sid]) byStudent[sid] = { name: g.student_name || '—', adm: g.admission_no || '—', cls: g.student_class || cls, grades: [] };
    byStudent[sid].grades.push(g);
  });

  const cards = Object.values(byStudent).map(s => {
    const avg = s.grades.length ? (s.grades.reduce((a,g)=>a+(g.score||0),0)/s.grades.length).toFixed(1) : '—';
    const grade = avg !== '—' ? (avg>=80?'A':avg>=60?'B':avg>=40?'C':'D') : '—';
    return { ...s, avg, grade };
  }).sort((a,b) => parseFloat(b.avg)-parseFloat(a.avg));

  const html = summaryBox([
    { label:'Students',   value: cards.length,                              bg:'#eff6ff', color:'#1e40af' },
    { label:'Avg Score',  value: cards.length ? (cards.reduce((s,c)=>s+parseFloat(c.avg||0),0)/cards.length).toFixed(1)+'%':'—', bg:'#f0fdf4', color:'#065f46' },
    { label:'Excellent',  value: cards.filter(c=>parseFloat(c.avg)>=80).length,  bg:'#f0fdf4', color:'#059669' },
    { label:'Grade Records', value: grades.length,                          bg:'#fef3c7', color:'#d97706' },
  ]) + renderTable([
    { key:'adm',   label:'Adm No' },
    { key:'name',  label:'Student Name' },
    { key:'cls',   label:'Class' },
    { key:'avg',   label:'Average %' },
    { key:'grade', label:'Grade', badge: v => ({ bg: v==='A'?'#d1fae5':v==='B'?'#dbeafe':v==='C'?'#fef9c3':'#fee2e2', text: v==='A'?'#065f46':v==='B'?'#1e40af':v==='C'?'#854d0e':'#dc2626' }) },
  ], cards.map(c => ({ adm:c.adm, name:c.name, cls:c.cls, avg:c.avg+'%', grade:c.grade })), 'No report card data found. Ensure grades have been entered.');

  return { html, data: cards.map(c=>({AdmNo:c.adm,Name:c.name,Class:c.cls,Average:c.avg,Grade:c.grade})), headers:['AdmNo','Name','Class','Average','Grade'] };
}

async function buildExamResults(params) {
  showToast('Generating exam results…', 'warning');
  const cls  = params.class || '';
  const term = params.term  || '';
  let url = `${API}/api/grades`;
  if (cls)  url += `?class=${encodeURIComponent(cls)}`;
  if (term) url += (url.includes('?') ? '&' : '?') + `term=${encodeURIComponent(term)}`;
  const grades = await safeFetch(url) || [];

  const rows = grades.map(g => ({
    adm:      g.admission_no  || '—',
    name:     g.student_name  || '—',
    cls:      g.student_class || cls || '—',
    subject:  g.subject       || '—',
    score:    g.score != null ? g.score + '%' : '—',
    grade:    g.grade         || '—',
    perf:     g.performance   || '—',
    term:     g.term          || term || '—',
    examType: g.exam_type     || '—',
    teacher:  g.teacher_name  || '—',
  }));

  const avg = rows.length ? (grades.reduce((s,g)=>s+(g.score||0),0)/rows.length).toFixed(1) : '—';
  const html = summaryBox([
    { label:'Total Records', value: rows.length,                         bg:'#eff6ff', color:'#1e40af' },
    { label:'Class Average', value: avg+'%',                             bg:'#f0fdf4', color:'#065f46' },
    { label:'Excellent',     value: grades.filter(g=>(g.score||0)>=80).length, bg:'#f0fdf4', color:'#059669' },
    { label:'Need Support',  value: grades.filter(g=>(g.score||0)<40).length,  bg:'#fee2e2', color:'#dc2626' },
  ]) + renderTable([
    {key:'adm',label:'Adm No'},{key:'name',label:'Student'},{key:'cls',label:'Class'},
    {key:'subject',label:'Subject'},{key:'score',label:'Score'},{key:'grade',label:'Grade'},
    {key:'perf',label:'Performance'},{key:'term',label:'Term'},{key:'examType',label:'Exam Type'},
    {key:'teacher',label:'Teacher'},
  ], rows, 'No examination records found.');

  return { html, data: rows.map(r=>({AdmNo:r.adm,Name:r.name,Class:r.cls,Subject:r.subject,Score:r.score,Grade:r.grade,Performance:r.perf,Term:r.term,ExamType:r.examType,Teacher:r.teacher})),
    headers:['AdmNo','Name','Class','Subject','Score','Grade','Performance','Term','ExamType','Teacher'] };
}

async function buildProgressReport(params) {
  showToast('Generating progress report…', 'warning');
  const cls  = params.class || '';
  let url = `${API}/api/grades`;
  if (cls) url += `?class=${encodeURIComponent(cls)}`;
  const grades = await safeFetch(url) || [];

  // Pivot by student + subject
  const byStudent = {};
  grades.forEach(g => {
    const sid = g.student_id || g.admission_no;
    if (!byStudent[sid]) byStudent[sid] = { name:g.student_name||'—', adm:g.admission_no||'—', cls:g.student_class||cls, subjects:{} };
    byStudent[sid].subjects[g.subject] = Math.max(byStudent[sid].subjects[g.subject]||0, g.score||0);
  });

  const subjects = [...new Set(grades.map(g=>g.subject).filter(Boolean))].sort();
  const rows = Object.values(byStudent).map(s => {
    const vals = subjects.map(sub => s.subjects[sub] ?? null).filter(v=>v!==null);
    const avg  = vals.length ? (vals.reduce((a,b)=>a+b,0)/vals.length).toFixed(1) : '—';
    const row  = { adm:s.adm, name:s.name, cls:s.cls };
    subjects.forEach(sub => { row[sub] = s.subjects[sub] != null ? s.subjects[sub]+'%' : '—'; });
    row.avg = avg !== '—' ? avg+'%' : '—';
    return row;
  }).sort((a,b) => parseFloat(b.avg)-parseFloat(a.avg));

  const cols = [
    {key:'adm',label:'Adm No'},{key:'name',label:'Student'},{key:'cls',label:'Class'},
    ...subjects.map(s=>({key:s,label:s})),
    {key:'avg',label:'Average'}
  ];
  const html = renderTable(cols, rows, 'No progress data found.');
  const hdr  = ['AdmNo','Name','Class',...subjects,'Average'];
  return { html, data: rows.map(r=>{ const o={AdmNo:r.adm,Name:r.name,Class:r.cls}; subjects.forEach(s=>{o[s]=r[s]||'—'}); o.Average=r.avg; return o; }), headers: hdr };
}

// ══════════════════════════════════════════════════════════════
//  FINANCIAL REPORTS
// ══════════════════════════════════════════════════════════════

async function buildFeeCollection(params) {
  showToast('Generating fee collection summary…', 'warning');
  const students = await safeFetch(`${API}/api/students`) || [];
  let totalBilled = 0, totalPaid = 0;
  const rows = [];

  for (const s of students.slice(0, 50)) { // limit for performance
    const fees = await safeFetch(`${API}/api/fees?student_id=${encodeURIComponent(s.id)}`);
    if (!fees) continue;
    const billed  = fees[0]?.total || 0;
    const paid    = fees.filter(f=>f.id&&f.amount>0).reduce((a,f)=>a+(f.amount||0),0);
    const balance = Math.max(0, billed - paid);
    totalBilled += billed; totalPaid += paid;
    rows.push({ name:s.fullName||'—', adm:s.admissionNumber||'—', cls:s.studentClass||'—',
      billed:fmt(billed), paid:fmt(paid), balance:fmt(balance),
      status: balance<=0?'Cleared':paid>0?'Partial':'Unpaid' });
  }

  const html = summaryBox([
    { label:'Total Billed',    value: fmt(totalBilled),            bg:'#eff6ff', color:'#1e40af' },
    { label:'Total Collected', value: fmt(totalPaid),              bg:'#f0fdf4', color:'#065f46' },
    { label:'Outstanding',     value: fmt(Math.max(0,totalBilled-totalPaid)), bg:'#fee2e2', color:'#dc2626' },
    { label:'Collection Rate', value: totalBilled>0?(totalPaid/totalBilled*100).toFixed(1)+'%':'—', bg:'#fef3c7', color:'#d97706' },
  ]) + renderTable([
    {key:'adm',label:'Adm No'},{key:'name',label:'Student'},{key:'cls',label:'Class'},
    {key:'billed',label:'Total Fee'},{key:'paid',label:'Paid'},{key:'balance',label:'Balance'},
    {key:'status',label:'Status', badge: v=>({ bg:v==='Cleared'?'#d1fae5':v==='Partial'?'#fef9c3':'#fee2e2', text:v==='Cleared'?'#065f46':v==='Partial'?'#854d0e':'#dc2626' })}
  ], rows, 'No fee records found.');

  return { html, data:rows.map(r=>({AdmNo:r.adm,Name:r.name,Class:r.cls,Billed:r.billed,Paid:r.paid,Balance:r.balance,Status:r.status})),
    headers:['AdmNo','Name','Class','Billed','Paid','Balance','Status'] };
}

async function buildExpenseBreakdown(params) {
  showToast('Generating expense breakdown…', 'warning');
  const data = [
    { category:'Salaries & Benefits', amount:'KSh 450,000', percentage:'58%', month:'March 2026' },
    { category:'Utilities (Water, Electricity)', amount:'KSh 28,000', percentage:'4%', month:'March 2026' },
    { category:'Learning Materials', amount:'KSh 55,000', percentage:'7%', month:'March 2026' },
    { category:'Maintenance & Repairs', amount:'KSh 32,000', percentage:'4%', month:'March 2026' },
    { category:'Catering / School Meals', amount:'KSh 85,000', percentage:'11%', month:'March 2026' },
    { category:'Transport', amount:'KSh 40,000', percentage:'5%', month:'March 2026' },
    { category:'Administration', amount:'KSh 25,000', percentage:'3%', month:'March 2026' },
    { category:'Sports & Extra-curricular', amount:'KSh 35,000', percentage:'5%', month:'March 2026' },
    { category:'Miscellaneous', amount:'KSh 22,000', percentage:'3%', month:'March 2026' },
  ];
  const html = summaryBox([
    { label:'Total Expenses', value:'KSh 772,000', bg:'#fee2e2', color:'#dc2626' },
    { label:'Categories',     value: data.length,  bg:'#eff6ff', color:'#1e40af' },
    { label:'Largest Item',   value:'Salaries',    bg:'#fef3c7', color:'#d97706' },
    { label:'Period',         value:'March 2026',  bg:'#f0fdf4', color:'#065f46' },
  ]) + renderTable([
    {key:'category',label:'Expense Category'},{key:'amount',label:'Amount'},
    {key:'percentage',label:'% of Total'},{key:'month',label:'Period'}
  ], data, 'No expense data found.');
  return { html, data, headers:['Category','Amount','Percentage','Period'] };
}

async function buildBudgetVsActual(params) {
  showToast('Generating budget vs actual…', 'warning');
  const data = [
    { category:'Fee Revenue',      budget:'KSh 1,200,000', actual:'KSh 980,000',  variance:'-KSh 220,000', status:'Under' },
    { category:'Salaries',         budget:'KSh 450,000',   actual:'KSh 450,000',  variance:'KSh 0',        status:'On Target' },
    { category:'Operations',       budget:'KSh 120,000',   actual:'KSh 105,000',  variance:'+KSh 15,000',  status:'Under Budget' },
    { category:'Maintenance',      budget:'KSh 40,000',    actual:'KSh 32,000',   variance:'+KSh 8,000',   status:'Under Budget' },
    { category:'Learning Materials',budget:'KSh 60,000',   actual:'KSh 55,000',   variance:'+KSh 5,000',   status:'Under Budget' },
    { category:'Transport',        budget:'KSh 40,000',    actual:'KSh 42,000',   variance:'-KSh 2,000',   status:'Over Budget' },
  ];
  const html = summaryBox([
    {label:'Total Budget',  value:'KSh 1,910,000', bg:'#eff6ff', color:'#1e40af'},
    {label:'Actual Spend',  value:'KSh 1,664,000', bg:'#f0fdf4', color:'#065f46'},
    {label:'Net Variance',  value:'+KSh 246,000',  bg:'#fef3c7', color:'#d97706'},
    {label:'On/Under Budget',value:'5 / 6',        bg:'#f0fdf4', color:'#059669'},
  ]) + renderTable([
    {key:'category',label:'Category'},{key:'budget',label:'Budget'},
    {key:'actual',label:'Actual'},{key:'variance',label:'Variance'},
    {key:'status',label:'Status', badge:v=>({bg:v.includes('Over')?'#fee2e2':v==='On Target'?'#fef9c3':'#d1fae5', text:v.includes('Over')?'#dc2626':v==='On Target'?'#854d0e':'#065f46'})}
  ], data, 'No budget data found.');
  return { html, data, headers:['Category','Budget','Actual','Variance','Status'] };
}

// ══════════════════════════════════════════════════════════════
//  ADMINISTRATIVE REPORTS
// ══════════════════════════════════════════════════════════════

async function buildAttendance(params) {
  showToast('Generating attendance summary…', 'warning');
  const date = params.date || new Date().toISOString().split('T')[0];
  const records = await safeFetch(`${API}/api/attendance?date=${date}`) || [];

  const present = records.filter(r=>(r.status||'').toLowerCase()==='present').length;
  const absent  = records.filter(r=>(r.status||'').toLowerCase()==='absent').length;
  const late    = records.filter(r=>(r.status||'').toLowerCase()==='late').length;
  const total   = records.length;
  const rate    = total>0?(present/total*100).toFixed(1)+'%':'—';

  const rows = records.map(r=>({
    adm:r.admission_no||'—', name:r.student_name||'—', cls:r.student_class||'—',
    status:r.status||'—', teacher:r.teacher_name||'—', remarks:r.remarks||'—'
  }));

  const html = summaryBox([
    {label:'Total Marked', value:total,   bg:'#eff6ff',color:'#1e40af'},
    {label:'Present',      value:present, bg:'#f0fdf4',color:'#059669'},
    {label:'Absent',       value:absent,  bg:'#fee2e2',color:'#dc2626'},
    {label:'Late',         value:late,    bg:'#fef3c7',color:'#d97706'},
    {label:'Rate',         value:rate,    bg:'#f0fdf4',color:'#065f46'},
  ]) + renderTable([
    {key:'adm',label:'Adm No'},{key:'name',label:'Student'},{key:'cls',label:'Class'},
    {key:'status',label:'Status',badge:v=>({bg:v.toLowerCase()==='present'?'#d1fae5':v.toLowerCase()==='absent'?'#fee2e2':'#fef3c7',text:v.toLowerCase()==='present'?'#065f46':v.toLowerCase()==='absent'?'#dc2626':'#92400e'})},
    {key:'teacher',label:'Teacher'},{key:'remarks',label:'Remarks'}
  ], rows, `No attendance records found for ${fmtDate(date)}.`);

  return { html, data:rows.map(r=>({AdmNo:r.adm,Name:r.name,Class:r.cls,Status:r.status,Teacher:r.teacher,Remarks:r.remarks})),
    headers:['AdmNo','Name','Class','Status','Teacher','Remarks'] };
}

async function buildStaffPerformance(params) {
  showToast('Generating staff performance…', 'warning');
  const assignments = await safeFetch(`${API}/api/teacher-assignments/summary`) || [];
  const rows = assignments.map(t => {
    const classes  = [...new Set((t.assignments||[]).map(a=>a.class_name).filter(Boolean))];
    const subjects = [...new Set((t.assignments||[]).map(a=>a.subject).filter(Boolean))];
    return {
      name:     t.fullName || '—',
      email:    t.email    || '—',
      classes:  classes.join(', ')  || 'Unassigned',
      subjects: subjects.join(', ') || '—',
      total:    (t.assignments||[]).length,
      status:   t.status || 'active'
    };
  });

  const html = summaryBox([
    {label:'Total Teachers',  value:rows.length, bg:'#eff6ff',color:'#1e40af'},
    {label:'Assigned',        value:rows.filter(r=>r.classes!=='Unassigned').length, bg:'#f0fdf4',color:'#065f46'},
    {label:'Unassigned',      value:rows.filter(r=>r.classes==='Unassigned').length, bg:'#fef3c7',color:'#d97706'},
    {label:'Total Assignments',value:rows.reduce((s,r)=>s+r.total,0), bg:'#ede9fe',color:'#7c3aed'},
  ]) + renderTable([
    {key:'name',label:'Teacher'},{key:'email',label:'Email'},{key:'classes',label:'Classes'},
    {key:'subjects',label:'Subjects'},{key:'total',label:'Assignments'},
    {key:'status',label:'Status',badge:v=>({bg:v==='active'?'#d1fae5':'#fef3c7',text:v==='active'?'#065f46':'#92400e'})}
  ], rows, 'No teacher data found.');

  return { html, data:rows.map(r=>({Name:r.name,Email:r.email,Classes:r.classes,Subjects:r.subjects,Assignments:r.total,Status:r.status})),
    headers:['Name','Email','Classes','Subjects','Assignments','Status'] };
}

async function buildEnrollment(params) {
  showToast('Generating enrollment statistics…', 'warning');
  const students = await safeFetch(`${API}/api/students`) || [];
  const byClass  = {};
  students.forEach(s => {
    const cls = s.studentClass || 'Unknown';
    if (!byClass[cls]) byClass[cls] = { total:0, boys:0, girls:0, active:0 };
    byClass[cls].total++;
    if ((s.gender||'').toLowerCase()==='male')   byClass[cls].boys++;
    if ((s.gender||'').toLowerCase()==='female')  byClass[cls].girls++;
    if ((s.status||'').toLowerCase()==='active')  byClass[cls].active++;
  });

  const classOrder = { PP1:0,PP2:1,'Grade 1':2,'Grade 2':3,'Grade 3':4,'Grade 4':5,'Grade 5':6,'Grade 6':7,'Grade 7':8,'Grade 8':9 };
  const rows = Object.entries(byClass).sort((a,b)=>(classOrder[a[0]]??50)-(classOrder[b[0]]??50))
    .map(([cls,d]) => ({ cls, total:d.total, boys:d.boys, girls:d.girls,
      ratio: d.boys+d.girls>0?`${d.boys}B / ${d.girls}G`:'—', active:d.active }));

  const html = summaryBox([
    {label:'Total Students',  value:students.length,                       bg:'#eff6ff',color:'#1e40af'},
    {label:'Active',          value:students.filter(s=>s.status==='active').length, bg:'#f0fdf4',color:'#065f46'},
    {label:'Classes',         value:rows.length,                           bg:'#fef3c7',color:'#d97706'},
    {label:'Boys / Girls',    value:`${students.filter(s=>s.gender==='male').length} / ${students.filter(s=>s.gender==='female').length}`, bg:'#ede9fe',color:'#7c3aed'},
  ]) + renderTable([
    {key:'cls',label:'Class'},{key:'total',label:'Total'},{key:'boys',label:'Boys'},
    {key:'girls',label:'Girls'},{key:'ratio',label:'Gender Ratio'},{key:'active',label:'Active'}
  ], rows, 'No student enrollment data found.');

  return { html, data:rows.map(r=>({Class:r.cls,Total:r.total,Boys:r.boys,Girls:r.girls,Ratio:r.ratio,Active:r.active})),
    headers:['Class','Total','Boys','Girls','Ratio','Active'] };
}

// ══════════════════════════════════════════════════════════════
//  OPERATIONAL REPORTS
// ══════════════════════════════════════════════════════════════
async function buildOperational(type, params) {
  const templates = {
    inventory: {
      title: 'Inventory Status',
      summary: [{label:'Total Items',value:142,bg:'#eff6ff',color:'#1e40af'},{label:'Low Stock',value:8,bg:'#fee2e2',color:'#dc2626'},{label:'Out of Stock',value:3,bg:'#fef3c7',color:'#d97706'},{label:'Categories',value:12,bg:'#f0fdf4',color:'#065f46'}],
      rows: [
        {item:'Exercise Books',category:'Stationery',qty:450,reorder:100,status:'OK'},
        {item:'Chalk (boxes)',category:'Teaching Aids',qty:12,reorder:20,status:'Low Stock'},
        {item:'Rulers',category:'Stationery',qty:85,reorder:50,status:'OK'},
        {item:'Lab Chemicals',category:'Science',qty:5,reorder:10,status:'Low Stock'},
        {item:'Sports Balls',category:'PE',qty:3,reorder:10,status:'Low Stock'},
        {item:'Printer Paper (reams)',category:'Admin',qty:8,reorder:20,status:'Low Stock'},
        {item:'Textbooks Gr.7',category:'Books',qty:0,reorder:30,status:'Out of Stock'},
      ],
      cols: [{key:'item',label:'Item'},{key:'category',label:'Category'},{key:'qty',label:'Qty'},
        {key:'reorder',label:'Reorder Level'},{key:'status',label:'Status',badge:v=>({bg:v==='OK'?'#d1fae5':v==='Low Stock'?'#fef3c7':'#fee2e2',text:v==='OK'?'#065f46':v==='Low Stock'?'#92400e':'#dc2626'})}],
      headers:['Item','Category','Qty','ReorderLevel','Status']
    },
    resources: {
      title: 'Resource Utilization',
      summary: [{label:'Facilities',value:18,bg:'#eff6ff',color:'#1e40af'},{label:'Avg Utilization',value:'74%',bg:'#f0fdf4',color:'#065f46'},{label:'Overcapacity',value:2,bg:'#fee2e2',color:'#dc2626'},{label:'Underused',value:4,bg:'#fef3c7',color:'#d97706'}],
      rows: [
        {facility:'Main Hall',capacity:200,current:185,utilization:'93%',status:'Near Capacity'},
        {facility:'Computer Lab',capacity:40,current:38,utilization:'95%',status:'Near Capacity'},
        {facility:'Science Lab',capacity:35,current:30,utilization:'86%',status:'Good'},
        {facility:'Library',capacity:60,current:25,utilization:'42%',status:'Underused'},
        {facility:'Sports Ground',capacity:500,current:210,utilization:'42%',status:'Good'},
        {facility:'Staff Room',capacity:30,current:28,utilization:'93%',status:'Near Capacity'},
      ],
      cols:[{key:'facility',label:'Facility'},{key:'capacity',label:'Capacity'},{key:'current',label:'Current Use'},{key:'utilization',label:'Utilization'},{key:'status',label:'Status',badge:v=>({bg:v==='Good'?'#d1fae5':v.includes('Near')?'#fef3c7':'#fee2e2',text:v==='Good'?'#065f46':v.includes('Near')?'#92400e':'#dc2626'})}],
      headers:['Facility','Capacity','CurrentUse','Utilization','Status']
    },
    maintenance: {
      title: 'Maintenance Reports',
      summary: [{label:'Open Tasks',value:6,bg:'#fee2e2',color:'#dc2626'},{label:'In Progress',value:3,bg:'#fef3c7',color:'#d97706'},{label:'Completed (Month)',value:14,bg:'#f0fdf4',color:'#065f46'},{label:'Avg Resolution',value:'4.2 days',bg:'#eff6ff',color:'#1e40af'}],
      rows: [
        {item:'Roof Leak - Block A',priority:'High',status:'Open',reported:'01 Mar 2026',assigned:'Maintenance Team'},
        {item:'Broken Windows - Gr.6',priority:'Medium',status:'In Progress',reported:'03 Mar 2026',assigned:'Contractor'},
        {item:'Generator Service',priority:'High',status:'Open',reported:'05 Mar 2026',assigned:'Unassigned'},
        {item:'Toilet Flush - Block B',priority:'High',status:'In Progress',reported:'07 Mar 2026',assigned:'Plumber'},
        {item:'Classroom Painting',priority:'Low',status:'Open',reported:'10 Mar 2026',assigned:'Unassigned'},
        {item:'CCTV Installation',priority:'Medium',status:'Completed',reported:'12 Feb 2026',assigned:'Tech Vendor'},
      ],
      cols:[{key:'item',label:'Issue'},{key:'priority',label:'Priority',badge:v=>({bg:v==='High'?'#fee2e2':v==='Medium'?'#fef3c7':'#f3f4f6',text:v==='High'?'#dc2626':v==='Medium'?'#92400e':'#6b7280'})},{key:'status',label:'Status',badge:v=>({bg:v==='Completed'?'#d1fae5':v==='In Progress'?'#dbeafe':'#f3f4f6',text:v==='Completed'?'#065f46':v==='In Progress'?'#1e40af':'#374151'})},{key:'reported',label:'Reported'},{key:'assigned',label:'Assigned To'}],
      headers:['Issue','Priority','Status','Reported','AssignedTo']
    }
  };

  const tmpl = templates[type];
  if (!tmpl) return { html:'<p>Report not available</p>', data:[], headers:[] };
  const html = summaryBox(tmpl.summary) + renderTable(tmpl.cols, tmpl.rows, 'No data found.');
  return { html, data:tmpl.rows, headers:tmpl.headers };
}

// ══════════════════════════════════════════════════════════════
//  REPORT DISPATCHER — Generate & Preview
// ══════════════════════════════════════════════════════════════

const REPORT_CONFIG = {
  'report-card':      { title:'Student Report Cards',      builder: buildReportCard,      params:['class','term'] },
  'exam-results':     { title:'Examination Results',        builder: buildExamResults,      params:['class','term'] },
  'progress':         { title:'Progress Reports',           builder: buildProgressReport,   params:['class'] },
  'fee-summary':      { title:'Fee Collection Summary',     builder: buildFeeCollection,    params:[] },
  'expenses':         { title:'Expense Breakdown',          builder: buildExpenseBreakdown, params:[] },
  'budget':           { title:'Budget vs Actual',           builder: buildBudgetVsActual,   params:[] },
  'attendance':       { title:'Attendance Summary',         builder: buildAttendance,       params:['date'] },
  'staff-performance':{ title:'Staff Performance',          builder: buildStaffPerformance, params:[] },
  'enrollment':       { title:'Enrollment Statistics',      builder: buildEnrollment,       params:[] },
  'inventory':        { title:'Inventory Status',           builder: p=>buildOperational('inventory',p), params:[] },
  'resources':        { title:'Resource Utilization',       builder: p=>buildOperational('resources',p), params:[] },
  'maintenance':      { title:'Maintenance Reports',        builder: p=>buildOperational('maintenance',p), params:[] },
};

function buildParamField(param) {
  const today = new Date().toISOString().split('T')[0];
  if (param === 'class') return `
    <div><label style="font-size:0.82rem;font-weight:600;color:#374151;display:block;margin-bottom:0.35rem;">Class</label>
    <select id="param_class" style="width:100%;padding:0.55rem 0.75rem;border-radius:8px;border:1.5px solid #e5e7eb;font-size:0.9rem;">
      <option value="">All Classes</option>
      ${['PP1','PP2','Grade 1','Grade 2','Grade 3','Grade 4','Grade 5','Grade 6','Grade 7','Grade 8'].map(c=>`<option value="${c}">${c}</option>`).join('')}
    </select></div>`;
  if (param === 'term') return `
    <div><label style="font-size:0.82rem;font-weight:600;color:#374151;display:block;margin-bottom:0.35rem;">Term</label>
    <select id="param_term" style="width:100%;padding:0.55rem 0.75rem;border-radius:8px;border:1.5px solid #e5e7eb;font-size:0.9rem;">
      <option value="">All Terms</option>
      <option value="Term 1">Term 1</option><option value="Term 2">Term 2</option><option value="Term 3">Term 3</option>
    </select></div>`;
  if (param === 'date') return `
    <div><label style="font-size:0.82rem;font-weight:600;color:#374151;display:block;margin-bottom:0.35rem;">Date</label>
    <input type="date" id="param_date" value="${today}" style="width:100%;padding:0.55rem 0.75rem;border-radius:8px;border:1.5px solid #e5e7eb;font-size:0.9rem;"></div>`;
  return '';
}

function getParams(paramNames) {
  const p = {};
  paramNames.forEach(name => {
    const el = document.getElementById(`param_${name}`);
    if (el) p[name] = el.value;
  });
  return p;
}

async function runReport(type, params) {
  const cfg = REPORT_CONFIG[type];
  if (!cfg) { showToast('Unknown report type', 'error'); return; }
  try {
    const result = await cfg.builder(params || {});
    const meta   = `Generated by ${(JSON.parse(sessionStorage.getItem('currentUser')||'{}')).fullName||'Admin'} · ${new Date().toLocaleString('en-GB')}`;
    openReportViewer(cfg.title, meta, result.html, result.data, result.headers);
    showToast(`${cfg.title} generated successfully`);
  } catch(err) {
    console.error(err);
    showToast('Failed to generate report: ' + err.message, 'error');
  }
}

function generateReport(type) {
  const cfg = REPORT_CONFIG[type];
  if (!cfg) return;
  if (!cfg.params || cfg.params.length === 0) {
    runReport(type, {});
    return;
  }
  // Show params modal
  document.getElementById('generateParamsTitle').textContent = cfg.title + ' — Parameters';
  document.getElementById('generateParamsFields').innerHTML = cfg.params.map(buildParamField).join('');
  document.getElementById('generateParamsRunBtn').onclick = () => {
    closeModal('generateParamsModal');
    runReport(type, getParams(cfg.params));
  };
  openModal('generateParamsModal');
}

function previewReport(type) {
  // Eye button = same as generate but always goes direct to viewer
  generateReport(type);
}

function generateQuickReport(type) {
  const map = {
    'today-attendance':    'attendance',
    'weekly-fees':         'fee-summary',
    'monthly-performance': 'progress',
    'term-report':         'report-card',
  };
  const rtype = map[type];
  if (rtype) generateReport(rtype);
}

// ══════════════════════════════════════════════════════════════
//  SCHEDULE MANAGEMENT
// ══════════════════════════════════════════════════════════════

function renderScheduledList() {
  const container = document.querySelector('.scheduled-list');
  if (!container) return;
  if (_scheduledReports.length === 0) {
    container.innerHTML = '<p style="color:#9ca3af;padding:1rem;text-align:center;">No scheduled reports yet. Click "Schedule Report" to create one.</p>';
    return;
  }
  container.innerHTML = _scheduledReports.map((s, i) => `
    <div class="schedule-item">
      <div class="schedule-info">
        <h4>${s.name}</h4>
        <p>${s.frequency.charAt(0).toUpperCase()+s.frequency.slice(1)}${s.day?' · '+s.day:''} at ${s.time} | To: ${s.recipients}</p>
      </div>
      <div class="schedule-actions">
        <button class="action-btn" onclick="editSchedule(${i})"><i class="fas fa-edit"></i></button>
        <button class="action-btn" onclick="deleteSchedule(${i})"><i class="fas fa-trash"></i></button>
      </div>
    </div>`).join('');
}

function editSchedule(idx) {
  const s = _scheduledReports[idx];
  if (!s) return;
  document.getElementById('scheduleName').value        = s.name;
  document.getElementById('scheduleFrequency').value   = s.frequency;
  document.getElementById('scheduleDay').value         = s.day || '';
  document.getElementById('scheduleTime').value        = s.time;
  document.getElementById('recipients').value          = s.recipients;
  document.getElementById('scheduleReportType').value  = s.reportType || '';
  document.getElementById('scheduleReportForm')._editIdx = idx;
  openModal('scheduleReportModal');
}

function deleteSchedule(idx) {
  if (!confirm('Delete this scheduled report?')) return;
  _scheduledReports.splice(idx, 1);
  localStorage.setItem('scheduledReports', JSON.stringify(_scheduledReports));
  renderScheduledList();
  showToast('Schedule deleted');
}

// ══════════════════════════════════════════════════════════════
//  MISC REPORT TABLE ACTIONS
// ══════════════════════════════════════════════════════════════
function downloadReport(id)  { showToast('Downloading report #'+id+'…'); }
function emailReport(id)     { showToast('Emailing report #'+id+'…'); }
function approveReport(id)   { showToast('Report #'+id+' approved'); }

// ══════════════════════════════════════════════════════════════
//  BOOT
// ══════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════
//  ANALYTICS DASHBOARD — Real-time charts
// ══════════════════════════════════════════════════════════════

let _trendsChart = null;
let _distChart   = null;

async function buildAnalyticsDashboard() {
  // ── Fetch all data in parallel ──────────────────────────────
  const [students, grades, attendance, fees, teachers, announcements] = await Promise.all([
    safeFetch(`${API}/api/students`),
    safeFetch(`${API}/api/grades`),
    safeFetch(`${API}/api/attendance`),
    safeFetch(`${API}/api/fees/payments`).then(d => d || safeFetch(`${API}/api/fees`)),
    safeFetch(`${API}/api/teacher-assignments/summary`),
    safeFetch(`${API}/api/announcements`),
  ]);

  const S = students     || [];
  const G = grades       || [];
  const A = attendance   || [];
  const F = Array.isArray(fees) ? fees : [];
  const T = teachers     || [];
  const N = announcements || [];

  // ── Summary pills ────────────────────────────────────────────
  const pills = [
    { label:'Students',    value: S.length,  icon:'fa-user-graduate', bg:'#eff6ff', color:'#1e40af' },
    { label:'Grade Records', value: G.length, icon:'fa-clipboard-list', bg:'#f0fdf4', color:'#065f46' },
    { label:'Attendance Records', value: A.length, icon:'fa-calendar-check', bg:'#fef3c7', color:'#92400e' },
    { label:'Fee Payments', value: F.filter(f=>f&&f.amount>0).length, icon:'fa-receipt', bg:'#fce7f3', color:'#9d174d' },
    { label:'Teachers',    value: T.length,  icon:'fa-chalkboard-teacher', bg:'#ede9fe', color:'#7c3aed' },
    { label:'Announcements', value: N.length, icon:'fa-bullhorn', bg:'#fff7ed', color:'#c2410c' },
  ];

  const pillsEl = document.getElementById('analyticsPills');
  if (pillsEl) {
    pillsEl.innerHTML = pills.map(p => `
      <div style="background:${p.bg};border-radius:10px;padding:0.65rem 1rem;
           display:flex;align-items:center;gap:0.6rem;flex:1;min-width:130px;">
        <i class="fas ${p.icon}" style="color:${p.color};font-size:1rem;"></i>
        <div>
          <div style="font-size:1.25rem;font-weight:800;color:${p.color};line-height:1.1;">${p.value}</div>
          <div style="font-size:0.72rem;color:#6b7280;">${p.label}</div>
        </div>
      </div>`).join('');
  }

  // ── Last updated ─────────────────────────────────────────────
  const ts = document.getElementById('analyticsLastUpdated');
  if (ts) ts.textContent = 'Live · updated ' + new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});

  // ── CHART 1: Report Generation Trends (line chart) ──────────
  // Build monthly counts for the last 6 months from real data
  const now    = new Date();
  const months = Array.from({length:6}, (_,i) => {
    const d = new Date(now.getFullYear(), now.getMonth()-5+i, 1);
    return { label: d.toLocaleString('en-GB',{month:'short',year:'2-digit'}), year:d.getFullYear(), month:d.getMonth() };
  });

  function countByMonth(records, dateField) {
    return months.map(m => records.filter(r => {
      const d = new Date(r[dateField] || r.created_at || r.date || '');
      return d.getFullYear()===m.year && d.getMonth()===m.month;
    }).length);
  }

  const gradeCounts      = countByMonth(G, 'date_posted');
  const attendanceCounts = countByMonth(A, 'date');
  const paymentCounts    = countByMonth(F.filter(f=>f&&f.amount>0), 'created_at');
  const announceCounts   = countByMonth(N, 'created_at');

  // Hide loading spinners
  const tl = document.getElementById('trendsLoading');
  const dl = document.getElementById('distLoading');
  if (tl) tl.style.display = 'none';
  if (dl) dl.style.display = 'none';

  const trendsCanvas = document.getElementById('reportTrendsChart');
  if (trendsCanvas) {
    if (_trendsChart) _trendsChart.destroy();
    _trendsChart = new Chart(trendsCanvas, {
      type: 'line',
      data: {
        labels: months.map(m => m.label),
        datasets: [
          {
            label:           'Grade Records',
            data:            gradeCounts,
            borderColor:     '#065f46',
            backgroundColor: 'rgba(6,95,70,0.08)',
            tension:         0.4,
            fill:            true,
            pointBackgroundColor: '#065f46',
            pointRadius:     5,
            pointHoverRadius:7,
          },
          {
            label:           'Attendance',
            data:            attendanceCounts,
            borderColor:     '#2563eb',
            backgroundColor: 'rgba(37,99,235,0.07)',
            tension:         0.4,
            fill:            true,
            pointBackgroundColor: '#2563eb',
            pointRadius:     5,
            pointHoverRadius:7,
          },
          {
            label:           'Fee Payments',
            data:            paymentCounts,
            borderColor:     '#d97706',
            backgroundColor: 'rgba(217,119,6,0.07)',
            tension:         0.4,
            fill:            true,
            pointBackgroundColor: '#d97706',
            pointRadius:     5,
            pointHoverRadius:7,
          },
          {
            label:           'Announcements',
            data:            announceCounts,
            borderColor:     '#7c3aed',
            backgroundColor: 'rgba(124,58,237,0.06)',
            tension:         0.4,
            fill:            true,
            pointBackgroundColor: '#7c3aed',
            pointRadius:     5,
            pointHoverRadius:7,
          },
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        interaction: { mode:'index', intersect:false },
        plugins: {
          legend: { position:'top', labels:{ usePointStyle:true, boxWidth:8, padding:16, font:{size:12} } },
          tooltip: {
            callbacks: {
              footer: items => {
                const total = items.reduce((s,i)=>s+i.parsed.y,0);
                return `Total: ${total} records`;
              }
            }
          }
        },
        scales: {
          x: { grid:{ color:'rgba(0,0,0,0.04)' }, ticks:{ font:{size:11} } },
          y: { beginAtZero:true, grid:{ color:'rgba(0,0,0,0.04)' }, ticks:{ font:{size:11}, stepSize:1 },
               title:{ display:true, text:'Record Count', font:{size:11}, color:'#9ca3af' } }
        }
      }
    });
  }

  // ── CHART 2: Category Distribution (doughnut) ────────────────
  // Real counts per category
  const classCount = [...new Set(S.map(s=>s.studentClass).filter(Boolean))].length;

  // Grades count = academic reports data points
  // Attendance = administrative
  // Fees = financial
  // Teachers assigned = operational-ish (assignments)
  // Build meaningful category totals from live data
  const catData = [
    { label:'Academic',       value: G.length,                              color:'#065f46', bg:'rgba(6,95,70,0.85)' },
    { label:'Attendance',     value: A.length,                              color:'#2563eb', bg:'rgba(37,99,235,0.85)' },
    { label:'Financial',      value: F.filter(f=>f&&f.amount>0).length,     color:'#d97706', bg:'rgba(217,119,6,0.85)' },
    { label:'Staff/Admin',    value: T.reduce((s,t)=>s+(t.assignments||[]).length,0), color:'#7c3aed', bg:'rgba(124,58,237,0.85)' },
    { label:'Announcements',  value: N.length,                              color:'#dc2626', bg:'rgba(220,38,38,0.85)' },
    { label:'Students',       value: S.length,                              color:'#0891b2', bg:'rgba(8,145,178,0.85)' },
  ].filter(c => c.value > 0);

  const totalRecords = catData.reduce((s,c)=>s+c.value,0);

  const distCanvas = document.getElementById('reportCategoriesChart');
  if (distCanvas) {
    if (_distChart) _distChart.destroy();
    _distChart = new Chart(distCanvas, {
      type: 'doughnut',
      data: {
        labels:   catData.map(c => c.label),
        datasets: [{
          data:             catData.map(c => c.value),
          backgroundColor:  catData.map(c => c.bg),
          borderColor:      '#fff',
          borderWidth:      3,
          hoverOffset:      10,
        }]
      },
      options: {
        responsive:          true,
        maintainAspectRatio: true,
        cutout:              '60%',
        plugins: {
          legend: {
            position: 'right',
            labels: {
              usePointStyle: true,
              boxWidth: 10,
              padding:  14,
              font: { size: 12 },
              generateLabels(chart) {
                return chart.data.labels.map((label, i) => {
                  const val = chart.data.datasets[0].data[i];
                  const pct = totalRecords > 0 ? ((val/totalRecords)*100).toFixed(1) : 0;
                  return {
                    text:            `${label}: ${val} (${pct}%)`,
                    fillStyle:       chart.data.datasets[0].backgroundColor[i],
                    strokeStyle:     '#fff',
                    lineWidth:       2,
                    pointStyle:      'circle',
                    hidden:          false,
                    index:           i,
                  };
                });
              }
            }
          },
          tooltip: {
            callbacks: {
              label: ctx => {
                const val = ctx.parsed;
                const pct = totalRecords > 0 ? ((val/totalRecords)*100).toFixed(1) : 0;
                return ` ${ctx.label}: ${val} records (${pct}%)`;
              }
            }
          }
        }
      }
    });

    // Centre text showing total
    // (pure CSS approach — add a centreText plugin inline)
    const pluginCentreText = {
      id: 'centreText',
      beforeDraw(chart) {
        if (chart.config.type !== 'doughnut') return;
        const { ctx, chartArea:{ left, top, right, bottom } } = chart;
        const cx = (left+right)/2, cy = (top+bottom)/2;
        ctx.save();
        ctx.font = 'bold 22px Segoe UI, system-ui, sans-serif';
        ctx.fillStyle = '#1f2937';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(totalRecords.toLocaleString(), cx, cy-10);
        ctx.font = '11px Segoe UI, system-ui, sans-serif';
        ctx.fillStyle = '#9ca3af';
        ctx.fillText('total records', cx, cy+12);
        ctx.restore();
      }
    };
    _distChart.register ? null : Chart.register(pluginCentreText);
    _distChart.options.plugins.centreText = {};
    _distChart.update();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const raw = sessionStorage.getItem('currentUser');
  if (!raw) { window.location.href = 'login.html'; return; }
  let user = {};
  try { user = JSON.parse(raw); } catch { window.location.href = 'login.html'; return; }

  document.getElementById('userNameDisplay').textContent = user.fullName || user.email || 'User';
  document.getElementById('roleBadge').textContent = (user.role||'User').charAt(0).toUpperCase() + (user.role||'user').slice(1);

  // Report builder form
  document.getElementById('reportBuilderForm').onsubmit = function(e) {
    e.preventDefault();
    const type = document.getElementById('reportType').value;
    const cls  = document.getElementById('reportClass').value;
    const term = document.getElementById('reportPeriod').value;
    closeModal('reportBuilderModal');
    runReport(type === 'academic' ? 'report-card' : type === 'financial' ? 'fee-summary' : type === 'administrative' ? 'attendance' : 'inventory', { class: cls, term });
  };

  // Schedule form
  document.getElementById('scheduleReportForm').onsubmit = function(e) {
    e.preventDefault();
    const schedule = {
      name:       document.getElementById('scheduleName').value,
      reportType: document.getElementById('scheduleReportType').value,
      frequency:  document.getElementById('scheduleFrequency').value,
      day:        document.getElementById('scheduleDay').value,
      time:       document.getElementById('scheduleTime').value,
      recipients: document.getElementById('recipients').value,
      format:     document.getElementById('scheduleFormat').value,
    };
    const editIdx = this._editIdx;
    if (editIdx !== undefined && editIdx !== null) {
      _scheduledReports[editIdx] = schedule;
      this._editIdx = null;
    } else {
      _scheduledReports.push(schedule);
    }
    localStorage.setItem('scheduledReports', JSON.stringify(_scheduledReports));
    renderScheduledList();
    closeModal('scheduleReportModal');
    this.reset();
    showToast(`Schedule "${schedule.name}" saved`);
  };

  renderScheduledList();

  // Build analytics dashboard with live data
  buildAnalyticsDashboard();

  // Auto-refresh charts every 2 minutes
  setInterval(buildAnalyticsDashboard, 120000);
});

function logout() {
  sessionStorage.removeItem('currentUser');
  window.location.href = 'login.html';
}
