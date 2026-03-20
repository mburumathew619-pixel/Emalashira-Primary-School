const API = 'http://localhost:5000';
let allTeachers      = [];
let currentUser      = null;
let classTeacherMap  = {};  // class_name → { id, teacher_id, teacher_name }

// ── School level groupings ────────────────────────────────────
const LEVEL_GROUPS = [
  {
    key:     'kindergarten',
    label:   'Kindergarten',
    icon:    'fas fa-child',
    color:   '#7c3aed',
    bg:      'linear-gradient(90deg,#5b21b6,#7c3aed)',
    classes: ['Kindergarten', 'PlayGroup']
  },
  {
    key:     'pre-primary',
    label:   'Pre-Primary',
    icon:    'fas fa-star',
    color:   '#db2777',
    bg:      'linear-gradient(90deg,#be185d,#db2777)',
    classes: ['PP1', 'PP2', 'Pre-Primary 1', 'Pre-Primary 2']
  },
  {
    key:     'lower-primary',
    label:   'Lower Primary (Grades 1–3)',
    icon:    'fas fa-book-open',
    color:   '#065f46',
    bg:      'linear-gradient(90deg,#065f46,#0f766e)',
    classes: ['Grade 1', 'Grade 2', 'Grade 3']
  },
  {
    key:     'upper-primary',
    label:   'Upper Primary (Grades 4–6)',
    icon:    'fas fa-graduation-cap',
    color:   '#1e40af',
    bg:      'linear-gradient(90deg,#1e3a8a,#1e40af)',
    classes: ['Grade 4', 'Grade 5', 'Grade 6']
  },
  {
    key:     'junior-secondary',
    label:   'Junior Secondary (Grades 7–9)',
    icon:    'fas fa-microscope',
    color:   '#92400e',
    bg:      'linear-gradient(90deg,#78350f,#92400e)',
    classes: ['Grade 7', 'Grade 8', 'Grade 9']
  },
  {
    key:     'unassigned',
    label:   'Unassigned Teachers',
    icon:    'fas fa-user-clock',
    color:   '#6b7280',
    bg:      'linear-gradient(90deg,#4b5563,#6b7280)',
    classes: []
  }
];

// Helper: which level does a class belong to?
function getLevelForClass(className) {
  for (const g of LEVEL_GROUPS) {
    if (g.classes.some(c => c.toLowerCase() === (className || '').toLowerCase())) return g.key;
  }
  return 'unassigned';
}

// ── Build a map: class → [{ teacher_id, teacher_name, subject }]
// so we can show "already taken" subjects per class in the assign modal
function buildClassSubjectMap() {
  const map = {}; // class_name → { subject → [teacher_name] }
  allTeachers.forEach(t => {
    (t.assignments || []).forEach(a => {
      const cls = a.class_name;
      const sub = a.subject;
      if (!map[cls]) map[cls] = {};
      if (!map[cls][sub]) map[cls][sub] = [];
      map[cls][sub].push({ teacher_id: t.id, teacher_name: t.fullName });
    });
  });
  return map;
}

const CLASSES  = ['PP1','PP2','Grade 1','Grade 2','Grade 3','Grade 4','Grade 5','Grade 6','Grade 7','Grade 8'];
const SUBJECTS = [
    'Language Activities', 'Mathematics Activities', 'Environmental Activities',
    'Psychomotor & Creative Activities', 'Religious Education Activities',
    'English Activities', 'Kiswahili Activities', 'Hygiene & Nutrition Activities',
    'Movement & Creative Activities',
    'English', 'Kiswahili', 'Mathematics', 'Science & Technology', 'Agriculture',
    'Home Science', 'Creative Arts', 'Social Studies', 'Religious Education',
    'Physical & Health Education',
    'Integrated Science', 'Business Studies', 'Pre-Technical & Pre-Career Education',
    'Sports & Physical Education', 'Life Skills Education', 'Health Education'
];

// ── Boot ─────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
    loadUserInfo();
    loadTeachers();
    document.getElementById('classFilter').addEventListener('change', applyFilters);
    document.getElementById('subjectFilter').addEventListener('change', applyFilters);
    document.getElementById('searchInput').addEventListener('input', applyFilters);
});

function loadUserInfo() {
    const raw = sessionStorage.getItem('currentUser');
    if (!raw) { window.location.href = 'login.html'; return; }
    currentUser = JSON.parse(raw);
    document.getElementById('userNameDisplay').textContent = currentUser.fullName || currentUser.email || 'User';
    document.getElementById('roleBadge').textContent       = currentUser.role || 'User';
}

// ── Fetch all teachers + assignments + class teachers from DB ──
async function loadTeachers() {
    try {
        const [teachersRes, classTeachersRes] = await Promise.all([
            fetch(`${API}/api/teacher-assignments/summary`),
            fetch(`${API}/api/class-teacher-assignments`)
        ]);
        if (!teachersRes.ok) throw new Error(teachersRes.status);

        allTeachers = await teachersRes.json();

        classTeacherMap = {};
        if (classTeachersRes.ok) {
            const cts = await classTeachersRes.json();
            cts.forEach(ct => {
                classTeacherMap[ct.class_name] = {
                    id:           ct.id,
                    teacher_id:   ct.teacher_id,
                    teacher_name: ct.teacher_name
                };
            });
        }

        renderRecords(allTeachers);
        updateStatistics(allTeachers);
    } catch (err) {
        showToast('Could not connect to server. Is the backend running?', 'error');
    }
}

// ── RENDER: grouped by school level ──────────────────────────
function renderRecords(teachers) {
    const list = document.getElementById('recordsList');
    list.innerHTML = '';

    if (!teachers || teachers.length === 0) {
        list.innerHTML = `<div style="padding:2.5rem;text-align:center;color:#6b7280;">
            No teachers found. Add teachers via <strong>+ Add Teacher</strong> or click <strong>Sync Users</strong>.
        </div>`;
        return;
    }

    // ── Bucket each teacher into level groups based on their assignments ──
    // A teacher can teach in multiple levels; we place them in the HIGHEST level
    // (or unassigned if no assignments). "Highest" = first group that contains any of their classes.

    const levelBuckets = {}; // levelKey → [teacher, ...]
    LEVEL_GROUPS.forEach(g => { levelBuckets[g.key] = []; });

    teachers.forEach(teacher => {
        const assignments = teacher.assignments || [];
        if (assignments.length === 0) {
            levelBuckets['unassigned'].push(teacher);
            return;
        }
        // Find which level groups this teacher belongs to
        const teacherLevels = new Set(assignments.map(a => getLevelForClass(a.class_name)));
        // Place teacher in first matching level (in LEVEL_GROUPS order)
        let placed = false;
        for (const g of LEVEL_GROUPS) {
            if (g.key === 'unassigned') continue;
            if (teacherLevels.has(g.key)) {
                levelBuckets[g.key].push(teacher);
                placed = true;
                break;
            }
        }
        if (!placed) levelBuckets['unassigned'].push(teacher);
    });

    // Sort within each bucket by the earliest class they teach (class order), then by name
    const classOrderMap = {
        'Kindergarten':0,'PlayGroup':0,'PP1':1,'PP2':2,'Pre-Primary 1':1,'Pre-Primary 2':2,
        'Grade 1':3,'Grade 2':4,'Grade 3':5,'Grade 4':6,'Grade 5':7,'Grade 6':8,
        'Grade 7':9,'Grade 8':10,'Grade 9':11
    };
    function getTeacherClassOrder(teacher) {
        const classes = (teacher.assignments||[]).map(a => classOrderMap[a.class_name] ?? 99);
        return classes.length ? Math.min(...classes) : 999;
    }
    LEVEL_GROUPS.forEach(g => {
        levelBuckets[g.key].sort((a,b) => {
            const diff = getTeacherClassOrder(a) - getTeacherClassOrder(b);
            if (diff !== 0) return diff;
            return a.fullName.localeCompare(b.fullName);
        });
    });

    // ── Render each level group ──
    LEVEL_GROUPS.forEach(g => {
        const bucket = levelBuckets[g.key];
        if (bucket.length === 0) return;

        // Group header
        const header = document.createElement('div');
        header.style.cssText = `
            background:${g.bg};
            color:#fff;
            padding:0.85rem 1.4rem;
            border-radius:12px;
            margin:1.5rem 0 0.75rem;
            display:flex;
            align-items:center;
            gap:0.75rem;
            box-shadow:0 4px 12px rgba(0,0,0,0.15);
        `;
        header.innerHTML = `
            <i class="${g.icon}" style="font-size:1.1rem;"></i>
            <span style="font-size:1rem;font-weight:700;letter-spacing:0.02em;">${g.label}</span>
            <span style="background:rgba(255,255,255,0.2);padding:0.2rem 0.65rem;border-radius:20px;
                font-size:0.78rem;font-weight:700;margin-left:auto;">
                ${bucket.length} teacher${bucket.length !== 1 ? 's' : ''}
            </span>
        `;
        list.appendChild(header);

        // Teacher cards in this level
        bucket.forEach(teacher => buildTeacherCard(teacher, list));
    });
}

// ── Build a single teacher card ───────────────────────────────
function buildTeacherCard(teacher, list) {
    const assignments = teacher.assignments || [];
    const classOrderMap = {
        'Kindergarten':0,'PlayGroup':0,'PP1':1,'PP2':2,'Pre-Primary 1':1,'Pre-Primary 2':2,
        'Grade 1':3,'Grade 2':4,'Grade 3':5,'Grade 4':6,'Grade 5':7,'Grade 6':8,
        'Grade 7':9,'Grade 8':10,'Grade 9':11
    };

    // Group by class, sorted by class order
    const classMap = {};
    assignments.forEach(a => {
        (classMap[a.class_name] = classMap[a.class_name] || []).push(a);
    });
    const classSorted = Object.keys(classMap)
        .sort((a,b) => (classOrderMap[a] ?? 50) - (classOrderMap[b] ?? 50));

    const card = document.createElement('div');
    card.className = 'teacher-item';
    card.style.marginBottom = '1rem';

    const myClassTeacherOf = Object.entries(classTeacherMap)
        .filter(([, ct]) => ct.teacher_id === teacher.id)
        .map(([cn]) => cn);

    const initial     = (teacher.fullName || '?')[0].toUpperCase();
    const isActive    = (teacher.status || 'active').toLowerCase() === 'active';
    const statusBg    = isActive ? '#d1fae5' : '#fef3c7';
    const statusColor = isActive ? '#065f46' : '#92400e';

    const headerDiv = document.createElement('div');
    headerDiv.style.cssText = 'display:flex;align-items:center;gap:0.85rem;margin-bottom:0.65rem;flex-wrap:wrap;';
    headerDiv.innerHTML = `
        <div style="width:40px;height:40px;border-radius:50%;background:#065f46;color:#fff;
                    display:flex;align-items:center;justify-content:center;
                    font-weight:700;font-size:1rem;flex-shrink:0;">${initial}</div>
        <div style="flex:1;min-width:0;">
            <div style="font-weight:700;font-size:1rem;color:#111827;display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;">
                ${teacher.fullName}
                ${myClassTeacherOf.map(cn =>
                    `<span style="background:#fef3c7;color:#92400e;font-size:0.72rem;font-weight:700;
                        padding:0.1rem 0.2rem 0.1rem 0.55rem;border-radius:999px;
                        display:inline-flex;align-items:center;gap:3px;">
                        <i class="fas fa-star" style="font-size:0.65rem;"></i> Class Teacher · ${cn}
                        <button onclick="openRemoveCtModal('${cn}','${teacher.fullName.replace(/'/g,"\\'")}','${teacher.id}')"
                            title="Remove class teacher role for ${cn}"
                            style="background:rgba(220,38,38,0.12);border:none;color:#dc2626;
                            cursor:pointer;padding:0.15rem 0.35rem;border-radius:999px;
                            font-size:0.68rem;font-weight:700;margin-left:1px;
                            display:inline-flex;align-items:center;gap:2px;"
                            onmouseenter="this.style.background='rgba(220,38,38,0.25)'"
                            onmouseleave="this.style.background='rgba(220,38,38,0.12)'">
                            <i class="fas fa-times"></i> Remove
                        </button>
                    </span>`
                ).join('')}
            </div>
            <div style="font-size:0.82rem;color:#6b7280;margin-top:0.1rem;">
                <span>${teacher.email || 'N/A'}</span>
                &nbsp;·&nbsp;<span>${teacher.phone || 'N/A'}</span>
                &nbsp;·&nbsp;<span style="background:${statusBg};color:${statusColor};
                    padding:0.1rem 0.5rem;border-radius:999px;font-size:0.74rem;
                    font-weight:600;text-transform:capitalize;">${teacher.status || 'active'}</span>
            </div>
        </div>
    `;

    // Add Assignment button
    const addBtn = document.createElement('button');
    addBtn.style.cssText = 'background:#dbeafe;color:#1e40af;border:none;'
                         + 'padding:0.38rem 0.95rem;border-radius:6px;cursor:pointer;'
                         + 'font-size:0.82rem;font-weight:600;white-space:nowrap;flex-shrink:0;';
    addBtn.innerHTML = '<i class="fas fa-plus"></i> Add Assignment';
    addBtn.addEventListener('click', () => openAddAssignModal(teacher.id, teacher.fullName));
    headerDiv.appendChild(addBtn);

    // Set as Class Teacher button
    const ctBtn = document.createElement('button');
    ctBtn.style.cssText = 'background:#fef3c7;color:#92400e;border:1px solid #fcd34d;'
                        + 'padding:0.38rem 0.95rem;border-radius:6px;cursor:pointer;'
                        + 'font-size:0.82rem;font-weight:600;white-space:nowrap;flex-shrink:0;';
    ctBtn.innerHTML = '<i class="fas fa-star"></i> Set as Class Teacher';
    ctBtn.addEventListener('click', () => openClassTeacherModal(teacher.id, teacher.fullName, assignments));
    headerDiv.appendChild(ctBtn);

    card.appendChild(headerDiv);

    // ── Assignment table ──
    if (classSorted.length > 0) {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'overflow-x:auto;';
        wrap.innerHTML = `
            <table style="width:100%;border-collapse:collapse;font-size:0.86rem;">
                <thead>
                    <tr style="background:#f0fdf4;text-align:left;">
                        <th style="padding:0.5rem 0.85rem;border:1px solid #d1fae5;color:#065f46;font-weight:700;white-space:nowrap;">Class</th>
                        <th style="padding:0.5rem 0.85rem;border:1px solid #d1fae5;color:#065f46;font-weight:700;">Subject(s)</th>
                        <th style="padding:0.5rem 0.85rem;border:1px solid #d1fae5;color:#065f46;font-weight:700;white-space:nowrap;">Class Teacher</th>
                        <th style="padding:0.5rem 0.85rem;border:1px solid #d1fae5;color:#065f46;font-weight:700;white-space:nowrap;">Assigned By</th>
                        <th style="padding:0.5rem 0.85rem;border:1px solid #d1fae5;color:#065f46;font-weight:700;white-space:nowrap;">Date</th>
                        <th style="padding:0.5rem 0.85rem;border:1px solid #d1fae5;color:#065f46;font-weight:700;">Action</th>
                    </tr>
                </thead>
                <tbody id="tbody-${teacher.id}"></tbody>
            </table>`;
        card.appendChild(wrap);

        const tbody = card.querySelector(`#tbody-${teacher.id}`);

        classSorted.forEach(cn => {
            const rowAssignments = classMap[cn];
            const latest = rowAssignments
                .slice().sort((a,b) => new Date(b.assigned_at) - new Date(a.assigned_at))[0];
            const date = latest
                ? new Date(latest.assigned_at)
                    .toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'})
                : '';

            const subjectMap = {};
            rowAssignments.forEach(a => {
                (subjectMap[a.subject] = subjectMap[a.subject] || []).push(a);
            });

            const subjectPills = Object.keys(subjectMap).map(s =>
                `<span style="background:#d1fae5;color:#065f46;padding:0.18rem 0.6rem;
                    border-radius:999px;font-size:0.78rem;font-weight:600;
                    white-space:nowrap;">${s}</span>`
            ).join('');

            const tr = document.createElement('tr');
            tr.onmouseenter = () => tr.style.background = '#f9fafb';
            tr.onmouseleave = () => tr.style.background = '';

            const isClassTeacher = classTeacherMap[cn]?.teacher_id === teacher.id;
            const safeTeacherName = teacher.fullName.replace(/'/g, "\\'");
            const ctCell = isClassTeacher
                ? `<span style="background:#fef3c7;color:#92400e;padding:0.15rem 0.55rem;
                       border-radius:999px;font-size:0.76rem;font-weight:700;display:inline-flex;
                       align-items:center;gap:3px;">
                       <i class="fas fa-star" style="font-size:0.65rem;"></i> Class Teacher
                   </span>
                   <button onclick="openRemoveCtModal('${cn}','${safeTeacherName}','${teacher.id}')"
                       style="background:#fee2e2;border:none;color:#dc2626;cursor:pointer;
                       padding:0.15rem 0.5rem;border-radius:5px;font-size:0.75rem;font-weight:600;
                       margin-left:4px;display:inline-flex;align-items:center;gap:3px;"
                       title="Remove class teacher role">
                       <i class="fas fa-times"></i> Remove
                   </button>`
                : `<span style="color:#d1d5db;font-size:0.78rem;">—</span>`;

            tr.innerHTML = `
                <td style="padding:0.55rem 0.85rem;border:1px solid #e5e7eb;font-weight:600;white-space:nowrap;">${cn}</td>
                <td style="padding:0.55rem 0.85rem;border:1px solid #e5e7eb;">
                    <div style="display:flex;flex-wrap:wrap;gap:0.3rem;">${subjectPills}</div>
                </td>
                <td style="padding:0.55rem 0.85rem;border:1px solid #e5e7eb;">${ctCell}</td>
                <td style="padding:0.55rem 0.85rem;border:1px solid #e5e7eb;color:#6b7280;font-size:0.82rem;white-space:nowrap;">
                    ${latest?.assigned_by || 'Admin'}</td>
                <td style="padding:0.55rem 0.85rem;border:1px solid #e5e7eb;color:#6b7280;font-size:0.82rem;white-space:nowrap;">${date}</td>
                <td style="padding:0.55rem 0.85rem;border:1px solid #e5e7eb;" 
                    class="act-${teacher.id}-${cn.replace(/\s+/g,'_')}"></td>`;
            tbody.appendChild(tr);

            const cell = tr.querySelector(`.act-${teacher.id}-${cn.replace(/\s+/g,'_')}`);
            const btnWrap = document.createElement('div');
            btnWrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:0.3rem;';
            Object.entries(subjectMap).forEach(([subj, subList]) => {
                subList.forEach(a => {
                    const rb = document.createElement('button');
                    rb.style.cssText = 'background:#fee2e2;color:#991b1b;border:none;'
                        + 'padding:0.22rem 0.6rem;border-radius:5px;cursor:pointer;'
                        + 'font-size:0.78rem;font-weight:600;white-space:nowrap;';
                    rb.innerHTML = `<i class="fas fa-times"></i> ${a.subject}`;
                    rb.addEventListener('click', () =>
                        removeAssignment(a.id, teacher.fullName, a.class_name, a.subject));
                    btnWrap.appendChild(rb);
                });
            });
            cell.appendChild(btnWrap);
        });

    } else {
        const note = document.createElement('div');
        note.style.cssText = 'color:#9ca3af;font-style:italic;font-size:0.85rem;padding:0.2rem 0;';
        note.textContent = 'No class assignments yet';
        card.appendChild(note);
    }

    list.appendChild(card);
}

// ── Stats ─────────────────────────────────────────────────────
function updateStatistics(teachers) {
    const allA = teachers.flatMap(t => t.assignments);
    document.getElementById('totalTeachers').textContent    = teachers.length;
    document.getElementById('classesCovered').textContent   = new Set(allA.map(a=>a.class_name)).size;
    document.getElementById('avgExperience').textContent    = '—';
    document.getElementById('totalAssignments').textContent = allA.length;
}

// ── Assign Modal (global "Assign Teacher to Class" button) ────
function openAssignModal() {
    document.getElementById('assignClass').value = '';
    updateAssignSubjectDropdown('');
    populateTeacherDropdown(null);
    document.getElementById('assignSubject').value = '';
    document.getElementById('assignTeacherModal').style.display = 'block';
}

// openAddAssignModal: "Add Assignment" on a teacher card
function openAddAssignModal(teacherId, teacherName) {
    document.getElementById('assignClass').value = '';
    updateAssignSubjectDropdown('');
    populateTeacherDropdown(teacherId);
    document.getElementById('assignSubject').value = '';
    document.getElementById('assignTeacherModal').style.display = 'block';
}

function populateTeacherDropdown(preselectId) {
    const sel = document.getElementById('assignTeacherSelect');
    sel.innerHTML = '<option value="">Choose a teacher...</option>';
    allTeachers.forEach(t => {
        const opt = document.createElement('option');
        opt.value       = t.id;
        opt.textContent = t.fullName;
        if (preselectId && t.id === preselectId) opt.selected = true;
        sel.appendChild(opt);
    });
}

// ── Update subject dropdown: mark already-taken subjects per class ─
function updateAssignSubjectDropdown(className) {
    const classSubjectMap = buildClassSubjectMap();
    const takenInClass = className ? (classSubjectMap[className] || {}) : {};
    const subjectSel = document.getElementById('assignSubject');
    const current = subjectSel.value;

    subjectSel.innerHTML = '<option value="">Select Subject</option>';

    // Group subjects by level
    const groups = [
        {
            label: '── Pre-Primary (PP1 & PP2) ──',
            subjects: [
                'Language Activities','Mathematics Activities','Environmental Activities',
                'Psychomotor & Creative Activities','Religious Education Activities'
            ]
        },
        {
            label: '── Lower Primary (Grades 1–3) ──',
            subjects: [
                'English Activities','Kiswahili Activities','Mathematics Activities',
                'Environmental Activities','Hygiene & Nutrition Activities',
                'Movement & Creative Activities','Religious Education Activities'
            ]
        },
        {
            label: '── Upper Primary (Grades 4–6) ──',
            subjects: [
                'English','Kiswahili','Mathematics','Science & Technology','Agriculture',
                'Home Science','Creative Arts','Social Studies','Religious Education',
                'Physical & Health Education'
            ]
        },
        {
            label: '── Junior Secondary (Grades 7–9) ──',
            subjects: [
                'English','Kiswahili','Mathematics','Integrated Science','Social Studies',
                'Business Studies','Agriculture','Pre-Technical & Pre-Career Education',
                'Religious Education','Sports & Physical Education','Life Skills Education',
                'Health Education'
            ]
        }
    ];

    groups.forEach(g => {
        const optgroup = document.createElement('optgroup');
        optgroup.label = g.label;

        g.subjects.forEach(sub => {
            const opt = document.createElement('option');
            opt.value = sub;

            const taken = takenInClass[sub];
            if (taken && taken.length > 0) {
                // Subject is already assigned in this class
                const teacherNames = taken.map(t => t.teacher_name).join(', ');
                opt.textContent = `⚠ ${sub} (taken by: ${teacherNames})`;
                opt.style.color = '#dc2626';
                opt.disabled = true;
                opt.dataset.taken = 'true';
            } else {
                opt.textContent = sub;
                opt.style.color = '';
                opt.disabled = false;
            }

            if (sub === current && !opt.disabled) opt.selected = true;
            optgroup.appendChild(opt);
        });

        subjectSel.appendChild(optgroup);
    });

    // Add a legend note if any subjects are taken
    const takenCount = Object.keys(takenInClass).length;
    const legend = document.getElementById('assignSubjectLegend');
    if (legend) {
        if (className && takenCount > 0) {
            legend.style.display = 'block';
            legend.innerHTML = `<i class="fas fa-info-circle"></i>
                Subjects marked <span style="color:#dc2626;font-weight:700;">⚠ taken</span>
                are already assigned to another teacher in <strong>${className}</strong> and cannot be selected.`;
        } else if (className) {
            legend.style.display = 'block';
            legend.innerHTML = `<i class="fas fa-check-circle" style="color:#065f46;"></i>
                All subjects are available in <strong>${className}</strong>.`;
        } else {
            legend.style.display = 'none';
        }
    }
}

// ── Wire class dropdown to refresh subjects on change ─────────
document.addEventListener('DOMContentLoaded', () => {
    const assignClassSel = document.getElementById('assignClass');
    if (assignClassSel) {
        assignClassSel.addEventListener('change', function() {
            updateAssignSubjectDropdown(this.value);
        });
    }
});

async function assignTeacherToClass(event) {
    event.preventDefault();
    const teacherId = document.getElementById('assignTeacherSelect').value;
    const className = document.getElementById('assignClass').value.trim();
    const subject   = document.getElementById('assignSubject').value;

    if (!teacherId || !className || !subject) {
        showToast('Please fill in all three fields.', 'error'); return;
    }

    // ── Duplicate guard: check if this subject is already assigned in this class ──
    const classSubjectMap = buildClassSubjectMap();
    const takenByOther = (classSubjectMap[className] || {})[subject];
    if (takenByOther && takenByOther.length > 0) {
        // Check if it's the same teacher (re-assignment is still a dup)
        const alreadyHasIt = takenByOther.some(t => t.teacher_id === teacherId);
        const takenTeachers = takenByOther.map(t => t.teacher_name).join(', ');
        if (alreadyHasIt) {
            showToast(`This teacher already teaches ${subject} in ${className}.`, 'error');
        } else {
            showToast(`"${subject}" in ${className} is already assigned to: ${takenTeachers}`, 'error');
        }
        return;
    }

    const btn = event.target.querySelector('[type=submit]');
    btn.disabled = true; btn.textContent = 'Saving...';

    try {
        const res = await fetch(`${API}/api/teacher-assignments`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                teacher_id:  teacherId,
                class_name:  className,
                subject:     subject,
                assigned_by: currentUser?.fullName || 'Admin'
            })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || res.status);
        showToast(`✓ ${data.teacher_name} assigned to ${className} — ${subject}`, 'success');
        closeAssignModal();
        await loadTeachers();
    } catch (err) {
        showToast('Failed: ' + err.message, 'error');
    } finally {
        btn.disabled = false; btn.textContent = 'Assign';
    }
}

async function removeAssignment(id, teacherName, className, subject) {
    if (!confirm(`Remove ${teacherName} from ${className} — ${subject}?`)) return;
    try {
        const res = await fetch(`${API}/api/teacher-assignments/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error((await res.json()).message);
        showToast(`Removed ${teacherName} from ${className}`, 'success');
        await loadTeachers();
    } catch (err) {
        showToast('Failed: ' + err.message, 'error');
    }
}

// ── Filters ───────────────────────────────────────────────────
function applyFilters() {
    const cf = document.getElementById('classFilter').value;
    const sf = document.getElementById('subjectFilter').value;
    const q  = document.getElementById('searchInput').value.toLowerCase();
    const filtered = allTeachers.filter(t => {
        const nm = t.fullName.toLowerCase().includes(q) || (t.email||'').toLowerCase().includes(q);
        const cm = !cf || cf==='all'
            || (cf==='Unassigned' && t.assignments.length===0)
            || t.assignments.some(a=>a.class_name===cf);
        const sm = !sf || sf==='all' || t.assignments.some(a=>a.subject===sf);
        return nm && cm && sm;
    });
    renderRecords(filtered);
}

// ── Sync btn ──────────────────────────────────────────────────
async function syncTeachersFromDB() {
    const btn = document.getElementById('syncBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Syncing...';
    await loadTeachers();
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-sync-alt"></i> Sync Users';
    showToast(`Loaded ${allTeachers.length} teacher(s) from database`, 'success');
}
function syncTeachersFromUsers() { syncTeachersFromDB(); }

// ── Add Teacher ───────────────────────────────────────────────
async function addNewTeacher(event) {
    event.preventDefault();
    const btn = event.target.querySelector('[type=submit]');
    btn.disabled = true; btn.textContent = 'Saving...';

    const payload = {
        fullName: document.getElementById('teacherName').value.trim(),
        email:    document.getElementById('teacherEmail').value.trim(),
        phone:    document.getElementById('teacherPhone').value.trim(),
        password: 'Teacher@123',
        role:     'Teacher',
        status:   'active'
    };

    try {
        const res  = await fetch(`${API}/api/users`, {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || res.status);

        const cls  = document.getElementById('teacherClass').value;
        const subj = document.getElementById('teacherSubject').value;
        if (cls && subj && data.user?.id) {
            // Check for duplicate before assigning
            const classSubjectMap = buildClassSubjectMap();
            const taken = (classSubjectMap[cls] || {})[subj];
            if (taken && taken.length > 0) {
                showToast(`Teacher created but "${subj}" in ${cls} is already taken. Assign a different subject.`, 'warning');
            } else {
                await fetch(`${API}/api/teacher-assignments`, {
                    method:'POST', headers:{'Content-Type':'application/json'},
                    body: JSON.stringify({ teacher_id:data.user.id, class_name:cls, subject:subj,
                                           assigned_by: currentUser?.fullName||'Admin' })
                });
            }
        }

        showToast(`Teacher ${payload.fullName} created. Default password: Teacher@123`, 'success');
        event.target.reset();
        closeAddTeacherModal();
        await loadTeachers();
    } catch (err) {
        showToast('Error: ' + err.message, 'error');
    } finally {
        btn.disabled = false; btn.textContent = 'Save Teacher';
    }
}

// ── Export CSV ────────────────────────────────────────────────
function exportData() {
    const rows = [['Teacher','Email','Phone','Class','Subject','Status']];
    allTeachers.forEach(t => {
        if (t.assignments.length === 0) {
            rows.push([t.fullName,t.email,t.phone||'','Unassigned','Unassigned',t.status]);
        } else {
            t.assignments.forEach(a => rows.push([t.fullName,t.email,t.phone||'',a.class_name,a.subject,t.status]));
        }
    });
    const csv  = rows.map(r=>r.map(v=>`"${(v||'').replace(/"/g,'""')}"`).join(',')).join('\n');
    const blob = new Blob([csv],{type:'text/csv'});
    const a = Object.assign(document.createElement('a'),{href:URL.createObjectURL(blob),download:'teacher_assignments.csv'});
    a.click(); URL.revokeObjectURL(a.href);
}

// ── Toast ─────────────────────────────────────────────────────
function showToast(msg, type='success') {
    const note = document.getElementById('syncNotification');
    const msgEl = document.getElementById('syncMessage');
    if (!note||!msgEl) { alert(msg); return; }
    const s = {
        success:{bg:'#d1fae5',border:'#059669',color:'#065f46'},
        error:  {bg:'#fee2e2',border:'#dc2626',color:'#991b1b'},
        warning:{bg:'#fef3c7',border:'#d97706',color:'#92400e'}
    }[type] || {bg:'#d1fae5',border:'#059669',color:'#065f46'};
    note.style.cssText=`display:flex;background:${s.bg};border:2px solid ${s.border};color:${s.color};
        padding:1rem 1.25rem;border-radius:8px;margin-bottom:1.25rem;align-items:center;gap:.75rem;font-weight:500;`;
    msgEl.textContent = msg;
    clearTimeout(note._t);
    note._t = setTimeout(()=>{ note.style.display='none'; }, 5000);
}

// ── Modal helpers ─────────────────────────────────────────────
function openAddTeacherModal()  { document.getElementById('addTeacherModal').style.display='block'; }
function closeAddTeacherModal() { document.getElementById('addTeacherModal').style.display='none'; }
function closeAssignModal() {
    document.getElementById('assignTeacherModal').style.display='none';
    document.getElementById('assignClass').value = '';
    const legend = document.getElementById('assignSubjectLegend');
    if (legend) legend.style.display = 'none';
}
function closeEditModal() { document.getElementById('editTeacherModal').style.display='none'; }
function logout() { sessionStorage.removeItem('currentUser'); window.location.href='login.html'; }

// ── Class Teacher Modal ───────────────────────────────────────
function openClassTeacherModal(teacherId, teacherName, assignments) {
    const modal = document.getElementById('classTeacherModal');
    if (!modal) return;

    document.getElementById('ctTeacherName').textContent = teacherName;

    const ctClassSel = document.getElementById('ctClass');
    ctClassSel.innerHTML = '<option value="">Select a class…</option>';

    const teacherClasses = [...new Set((assignments || []).map(a => a.class_name).filter(Boolean))];

    const classOrderMap = { PP1:0,PP2:1,'Grade 1':2,'Grade 2':3,'Grade 3':4,
                            'Grade 4':5,'Grade 5':6,'Grade 6':7,'Grade 7':8,'Grade 8':9 };

    if (teacherClasses.length === 0) {
        CLASSES.forEach(cn => {
            const opt = document.createElement('option');
            opt.value = cn; opt.textContent = cn;
            ctClassSel.appendChild(opt);
        });
    } else {
        teacherClasses.sort((a, b) => (classOrderMap[a] ?? 50) - (classOrderMap[b] ?? 50));
        teacherClasses.forEach(cn => {
            const opt = document.createElement('option');
            opt.value = cn; opt.textContent = cn;
            if (classTeacherMap[cn]?.teacher_id === teacherId) {
                opt.textContent = cn + '  ✓ (current class teacher)';
                opt.selected = true;
            }
            ctClassSel.appendChild(opt);
        });
    }

    document.getElementById('ctSaveBtn').dataset.teacherId = teacherId;
    document.getElementById('ctSaveBtn').dataset.teacherName = teacherName;
    modal.style.display = 'flex';
}

function closeClassTeacherModal() {
    document.getElementById('classTeacherModal').style.display = 'none';
}

async function saveClassTeacher() {
    const btn       = document.getElementById('ctSaveBtn');
    const teacherId = btn.dataset.teacherId;
    const teacherName = btn.dataset.teacherName;
    const className = document.getElementById('ctClass').value;

    if (!className) { showToast('Please select a class', 'error'); return; }

    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving…';

    try {
        const res = await fetch(`${API}/api/class-teacher-assignments`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                teacher_id:  teacherId,
                class_name:  className,
                assigned_by: currentUser?.fullName || 'Admin'
            })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || res.status);
        showToast(`✓ ${teacherName} is now Class Teacher for ${className}`, 'success');
        closeClassTeacherModal();
        await loadTeachers();
    } catch (err) {
        showToast('Failed: ' + err.message, 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-star"></i> Confirm Class Teacher';
    }
}

// ── Remove Class Teacher ──────────────────────────────────────
function openRemoveCtModal(className, teacherName, teacherId) {
    document.getElementById('removeCtTeacherName').textContent = teacherName;
    document.getElementById('removeCtClassName').textContent   = className;

    const confirmBtn = document.getElementById('removeCtConfirmBtn');
    const fresh = confirmBtn.cloneNode(true);
    confirmBtn.parentNode.replaceChild(fresh, confirmBtn);
    fresh.addEventListener('click', () => confirmRemoveClassTeacher(className, teacherName));

    document.getElementById('removeCtModal').style.display = 'flex';
}

function closeRemoveCtModal() {
    document.getElementById('removeCtModal').style.display = 'none';
}

async function confirmRemoveClassTeacher(className, teacherName) {
    const btn = document.getElementById('removeCtConfirmBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Removing…'; }

    try {
        const res = await fetch(`${API}/api/class-teacher-assignments/${encodeURIComponent(className)}`,
            { method: 'DELETE' });
        if (!res.ok) throw new Error((await res.json()).message);
        closeRemoveCtModal();
        showToast(`✓ ${teacherName} removed as Class Teacher for ${className}`, 'success');
        await loadTeachers();
    } catch (err) {
        showToast('Failed: ' + err.message, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-star-half-alt"></i> Yes, Remove Role'; }
    }
}

function removeClassTeacher(className) {
    const ct = classTeacherMap[className];
    const name = ct?.teacher_name || 'this teacher';
    openRemoveCtModal(className, name, ct?.teacher_id || '');
}






























































