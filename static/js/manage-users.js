const API_BASE_URL = "http://localhost:5000";
let allUsers   = [];
let isDeleting = false;

// ── Next available admission number ───────────────────────────
// Reads all existing students, finds the highest ADM### number,
// and returns the next sequential one — never reuses a number.
async function getNextAdmissionNumber() {
  try {
    const res = await fetch(`${API_BASE_URL}/api/students`);
    const list = res.ok ? await res.json() : [];
    let maxNum = 0;
    list.forEach(s => {
      const match = (s.admissionNumber || '').toUpperCase().trim().match(/^ADM(\d+)$/);
      if (match) {
        const n = parseInt(match[1], 10);
        if (n > maxNum) maxNum = n;
      }
    });
    return `ADM${String(maxNum + 1).padStart(3, '0')}`;
  } catch {
    return 'ADM001';
  }
}

// Validate admission number in manage-users context
async function validateAdmissionNumberMU(inputEl) {
  const val = (inputEl.value || '').trim().toUpperCase();
  if (!val) return true;
  try {
    const res  = await fetch(`${API_BASE_URL}/api/students`);
    const list = res.ok ? await res.json() : [];
    const editId = document.getElementById('editUserId')?.value || '';
    const duplicate = list.find(s =>
      (s.admissionNumber || '').toUpperCase().trim() === val &&
      s.id !== editId
    );
    if (duplicate) {
      inputEl.style.borderColor = '#dc2626';
      inputEl.style.background  = '#fee2e2';
      inputEl.style.color       = '#991b1b';
      let warn = document.getElementById('muAdmWarn');
      if (!warn) {
        warn = document.createElement('div');
        warn.id = 'muAdmWarn';
        warn.style.cssText = 'color:#dc2626;font-size:0.78rem;font-weight:600;margin-top:4px;display:flex;align-items:center;gap:4px;';
        inputEl.parentNode.appendChild(warn);
      }
      warn.innerHTML = `<i class="fas fa-exclamation-circle"></i> "${val}" is already assigned to <strong>${duplicate.fullName}</strong>. Use a different number.`;
      return false;
    } else {
      inputEl.style.borderColor = '';
      inputEl.style.background  = '';
      inputEl.style.color       = '#065f46';
      const warn = document.getElementById('muAdmWarn');
      if (warn) warn.remove();
      return true;
    }
  } catch { return true; }
}


const roleDescriptions = {
  'Admin':      'Full system access with all permissions across all modules',
  'Teacher':    'Access to teaching modules, students, grades, and attendance',
  'Parent':     'View-only access to student information and announcements.',
  'Accountant': 'Full access to financial modules and reports',
  'Student':    'Access to view assignments, grades, and school announcements'
};

function getRoleBadgeClass(role) {
  return { Admin:'role-admin', Teacher:'role-teacher', Parent:'role-parent',
           Accountant:'role-accountant', Student:'role-student',
           Pending:'role-pending' }[role] || 'role-user';
}

function showRoleInfo() {
  const role = document.getElementById('role').value;
  const info = document.getElementById('roleInfo');
  const infoText = document.getElementById('roleInfoText');
  if (infoText) infoText.textContent = roleDescriptions[role] || '';
  info.style.display = role && roleDescriptions[role] ? 'block' : 'none';
  const rLower = (role || '').toLowerCase();
  document.getElementById('studentFields').classList.toggle('show', rLower === 'student');
  document.getElementById('parentFields').classList.toggle('show',  rLower === 'parent');

  // Students cannot log in — hide login credential fields
  const isStudent = rLower === 'student';
  const emailGroup    = document.getElementById('emailGroup');
  const phoneGroup    = document.getElementById('phoneGroup');
  const passwordGroup = document.getElementById('passwordGroup');

  if (emailGroup) {
    emailGroup.style.display = isStudent ? 'none' : '';
    document.getElementById('email').required = !isStudent;
  }
  if (phoneGroup) {
    phoneGroup.style.display = isStudent ? 'none' : '';
    document.getElementById('phone').required = !isStudent;
  }
  if (passwordGroup) {
    // Only show password in create mode (not edit); student hides it regardless
    const isEditMode = document.getElementById('editUserId').value !== '';
    passwordGroup.style.display = (isStudent || isEditMode) ? 'none' : '';
    document.getElementById('password').required = (!isStudent && !isEditMode);
    // Change type to prevent browser password-save popup for students
    document.getElementById('password').type = isStudent ? 'text' : 'password';
  }

  // Auto-suggest next admission number when Student role is selected in CREATE mode
  if (isStudent) {
    const isEditMode = document.getElementById('editUserId').value !== '';
    const admEl = document.getElementById('admissionNumber');
    if (admEl && !isEditMode && !admEl.value.trim()) {
      admEl.value       = 'Generating…';
      admEl.disabled    = true;
      admEl.style.color = '#9ca3af';
      getNextAdmissionNumber().then(next => {
        admEl.value          = next;
        admEl.disabled       = false;
        admEl.style.color    = '#065f46';
        admEl.style.fontWeight = '700';
        admEl.title          = 'Auto-suggested next available number. You may change it if needed.';
        admEl.onblur         = () => validateAdmissionNumberMU(admEl);
      });
    }
  }
}

// ── Always load fresh from backend ───────────────────────────
async function loadUsers() {
  if (isDeleting) return;
  try {
    // Fetch non-student users and students separately
    const [usersRes, studentsRes] = await Promise.all([
      fetch(`${API_BASE_URL}/api/users`),
      fetch(`${API_BASE_URL}/api/students`)
    ]);
    if (!usersRes.ok) throw new Error('Backend error');

    const users    = await usersRes.json();
    const students = studentsRes.ok ? await studentsRes.json() : [];

    // Normalise student records to match the user shape renderUsers expects
    const studentUsers = students.map(s => ({
      id:              s.id,
      fullName:        s.fullName,
      email:           null,          // students have no login email
      phone:           s.parentPhone || null,
      date_of_birth:   s.date_of_birth || null,
      gender:          s.gender || null,
      address:         s.address || null,
      role:            'Student',
      status:          s.status || 'active',
      createdAt:       s.createdAt,
      children:        [],
      studentClass:    s.studentClass,
      admissionNumber: s.admissionNumber,
      parentName:      s.parentName,
      parentPhone:     s.parentPhone,
      admissionDate:   s.admissionDate,
    }));

    allUsers = [...users, ...studentUsers];
    localStorage.setItem('schoolUsers', JSON.stringify(allUsers));
    updateStatCards(allUsers); // update counts immediately
    console.log('[Users] Loaded', allUsers.length, 'total |',
      allUsers.reduce((a,u)=>{ const r=(u.role||'Unknown'); a[r]=(a[r]||0)+1; return a; }, {}));
    renderUsers(allUsers);
  } catch (err) {
    console.warn('Backend unreachable, using localStorage');
    allUsers = JSON.parse(localStorage.getItem('schoolUsers') || '[]');
    renderUsers(allUsers);
  }
}

// ── QUICK ROLE ASSIGN via email ───────────────────────────────
async function quickAssignRole(email, newRole) {
  if (!newRole) return;
  try {
    const res = await fetch(`${API_BASE_URL}/api/users/assign-role`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, role: newRole })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message);
    const u = allUsers.find(u => u.email === email);
    if (u) u.role = newRole;
    localStorage.setItem('schoolUsers', JSON.stringify(allUsers));
    showToast(`✅ Role set to "${newRole}" for ${email}`);
  } catch (err) {
    alert(`Failed to assign role: ${err.message}`);
    await loadUsers();
  }
}

function showToast(msg) {
  let t = document.getElementById('roleToast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'roleToast';
    t.style.cssText = `position:fixed;bottom:24px;right:24px;background:#065f46;color:#fff;
      padding:12px 20px;border-radius:8px;font-size:0.95rem;z-index:9999;
      box-shadow:0 4px 12px rgba(0,0,0,0.2);transition:opacity .3s`;
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.style.opacity = '0'; }, 3000);
}

function updateStatCards(users) {
  if (!users || !users.length) return;

  // Count each role — normalise to Title Case for safety
  let nAdmin = 0, nTeacher = 0, nParent = 0, nAccountant = 0, nStudent = 0, nPending = 0;
  users.forEach(function(u) {
    var raw = (u.role || '').trim();
    var r   = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
    if      (r === 'Admin')      nAdmin++;
    else if (r === 'Teacher')    nTeacher++;
    else if (r === 'Parent')     nParent++;
    else if (r === 'Accountant') nAccountant++;
    else if (r === 'Student')    nStudent++;
    else if (r === 'Pending')    nPending++;
  });

  // Directly set each element — no helper wrapper that could silently swallow errors
  var eAdmin = document.getElementById('count-admin');
  var eTeacher = document.getElementById('count-teacher');
  var eParent = document.getElementById('count-parent');
  var eAccountant = document.getElementById('count-accountant');
  var eStudent = document.getElementById('count-student');
  var ePending = document.getElementById('count-pending');
  var eTotal = document.getElementById('count-total');

  if (eAdmin)      eAdmin.textContent      = nAdmin;
  if (eTeacher)    eTeacher.textContent    = nTeacher;
  if (eParent)     eParent.textContent     = nParent;
  if (eAccountant) eAccountant.textContent = nAccountant;
  if (eStudent)    eStudent.textContent    = nStudent;
  if (ePending)    ePending.textContent    = nPending;
  // Total excludes pending users — they are not yet official members
  if (eTotal) eTotal.textContent = nAdmin + nTeacher + nParent + nAccountant + nStudent;

  console.log('[StatCards] Admin=' + nAdmin + ' Teacher=' + nTeacher + 
    ' Parent=' + nParent + ' Accountant=' + nAccountant +
    ' Student=' + nStudent + ' Pending=' + nPending + ' Total=' + users.length);

  var pendingCard  = document.querySelector('.pending-card');
  var pendingBadge = document.getElementById('pending-badge');
  if (pendingCard)  pendingCard.classList.toggle('has-pending', nPending > 0);
  if (pendingBadge) {
    pendingBadge.style.display = nPending > 0 ? 'flex' : 'none';
    pendingBadge.textContent   = nPending > 9 ? '9+' : String(nPending);
  }
}

// Called from stat cards — filters table by role (empty string = show all)
function filterByRole(r) {
  document.querySelectorAll('.user-stat-card').forEach(c => c.classList.remove('active-filter'));
  const idMap = { Admin:'count-admin', Teacher:'count-teacher', Parent:'count-parent',
                  Accountant:'count-accountant', Student:'count-student',
                  Pending:'count-pending', '':'count-total' };
  const targetEl = document.getElementById(idMap[r] ?? 'count-total');
  if (targetEl) targetEl.closest('.user-stat-card')?.classList.add('active-filter');
  renderUsers(r ? allUsers.filter(u => u.role === r) : allUsers);
}

function renderUsers(users) {
  updateStatCards(allUsers);
  const tbody = document.getElementById('usersTableBody');
  tbody.innerHTML = '';

  if (!users.length) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:2rem;color:#6b7280;">
      <i class="fas fa-users" style="font-size:2rem;display:block;margin-bottom:.5rem"></i>No users found</td></tr>`;
    return;
  }

  const ORDER = ['Pending','Admin','Teacher','Accountant','Parent','Student'];
  const grouped = {};
  ORDER.forEach(r => grouped[r] = []);

  users.forEach(u => {
    const raw = (u.role || '').trim();
    const r   = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
    if (ORDER.includes(r)) grouped[r].push(u);
    else grouped['Pending'].push(u); // unrecognised roles go to pending
  });

  ORDER.forEach(group => {
    if (!grouped[group] || !grouped[group].length) return;
    const isStudentGroup = group === 'Student';
    const cols = isStudentGroup ? 7 : 8;

    // Section heading
    const heading = document.createElement('tr');
    heading.innerHTML = `<td colspan="${cols}" style="background:#f0fdf4;color:#065f46;
      font-weight:700;font-size:1rem;padding:.6rem 1rem;">${group === 'Pending' ? '⏳ Pending Approval' : group + ' Users'}</td>`;
    tbody.appendChild(heading);

    // Student sub-header
    if (isStudentGroup) {
      const subHead = document.createElement('tr');
      subHead.style.cssText = 'background:#065f46;';
      ['STUDENT NAME','PARENT / GUARDIAN','PARENT PHONE','ROLE','STATUS','CREATED','ACTIONS'].forEach(h => {
        const th = document.createElement('th');
        th.style.cssText = 'padding:.55rem 1rem;font-size:.78rem;font-weight:700;color:#ffffff;text-transform:uppercase;letter-spacing:.4px;border-bottom:2px solid rgba(255,255,255,0.15);';
        th.textContent = h;
        subHead.appendChild(th);
      });
      tbody.appendChild(subHead);
    }

    grouped[group].forEach(u => {
      const isParent  = (u.role || '').toLowerCase() === 'parent';
      const isStudent = (u.role || '').toLowerCase() === 'student';
      const userKey   = u.id && u.id !== 'null' ? u.id : null;
      const tr        = document.createElement('tr');

      if (isStudent) {
        const parentName  = u.parentName  || '<span style="color:#9ca3af;">—</span>';
        const parentPhone = u.parentPhone || '<span style="color:#9ca3af;">—</span>';
        const statusCls   = u.status === 'active' ? 'status-active' : 'status-disabled';
        tr.innerHTML = `
          <td>
            <div style="font-weight:600;color:#1f2937;">${u.fullName || '—'}</div>
            ${u.admissionNumber ? `<div style="font-size:.76rem;color:#6b7280;margin-top:2px;">Adm: ${u.admissionNumber}</div>` : ''}
            ${u.studentClass    ? `<div style="font-size:.76rem;color:#6b7280;">${u.studentClass}</div>` : ''}
          </td>
          <td><div style="font-weight:500;color:#374151;">${parentName}</div></td>
          <td>${parentPhone}</td>
          <td><span class="role-badge role-student">Student</span></td>
          <td class="${statusCls}">${u.status === 'active' ? 'Active' : 'Disabled'}</td>
          <td>${u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '—'}</td>
          <td>
            <button class="action-btn action-edit" title="Edit Student" onclick="editUserByEmail('${u.id}')"><i class="fas fa-edit"></i></button>
            <button class="action-btn action-delete" title="Delete Student" onclick="deleteUserByEmail('${u.id}','${(u.fullName||'Student').replace(/'/g,"\\'")}')"><i class="fas fa-trash"></i></button>
          </td>`;
      } else {
        // Build children cell from cached data — will be refreshed async below
        const cachedChildren = u.children && u.children.length ? u.children : [];
        let childrenCell = '<span style="color:#9ca3af;">—</span>';
        if (isParent && cachedChildren.length > 0) {
          childrenCell = `<div style="display:flex;flex-wrap:wrap;gap:2px;" id="children-cell-${u.email ? u.email.replace(/[^a-z0-9]/gi,'_') : u.id}">${cachedChildren.map(c =>
            `<span style="display:inline-block;background:#d1fae5;color:#065f46;border-radius:999px;
              padding:2px 9px;font-size:0.78rem;font-weight:600;margin:2px;">
              <i class="fas fa-child" style="font-size:0.7rem;margin-right:3px;"></i>${c.childName || c.name || '?'}
            </span>`).join('')}</div>`;
        } else if (isParent) {
          childrenCell = `<span id="children-cell-${u.email ? u.email.replace(/[^a-z0-9]/gi,'_') : u.id}" style="color:#9ca3af;">—</span>`;
        }
        // Build role cell — show badge if role is assigned, dropdown if not
        const rawRole = (u.role || '').trim();
        const normRole = rawRole.charAt(0).toUpperCase() + rawRole.slice(1).toLowerCase();
        const hasRole = rawRole && !['user','pending',''].includes(rawRole.toLowerCase());
        const roleTd = document.createElement('td');
        if (hasRole) {
          const badge = document.createElement('span');
          badge.className = 'role-badge ' + getRoleBadgeClass(normRole);
          badge.textContent = normRole;
          badge.title = 'Click to reassign role';
          badge.style.cursor = 'pointer';
          badge.addEventListener('click', function() {
            const sel = document.createElement('select');
            sel.className = 'role-select';
            sel.style.cssText = 'border:1px solid #d1fae5;border-radius:6px;padding:4px 8px;font-size:0.82rem;font-weight:600;cursor:pointer;background:#f0fdf4;color:#065f46;';
            ['— Change Role —','Admin','Teacher','Parent','Accountant'].forEach(function(r, i) {
              const opt = document.createElement('option');
              opt.value = i === 0 ? '' : r;
              opt.textContent = r;
              if (r === normRole) opt.selected = true;
              sel.appendChild(opt);
            });
            sel.addEventListener('change', function() { if (this.value) quickAssignRole(u.email, this.value); });
            badge.replaceWith(sel);
            sel.focus();
          });
          roleTd.appendChild(badge);
        } else {
          const sel = document.createElement('select');
          sel.className = 'role-select';
          sel.style.cssText = 'border:1px solid #d1fae5;border-radius:6px;padding:4px 8px;font-size:0.82rem;font-weight:600;cursor:pointer;background:#f0fdf4;color:#065f46;';
          ['— Assign Role —','Admin','Teacher','Parent','Accountant'].forEach(function(r, i) {
            const opt = document.createElement('option');
            opt.value = i === 0 ? '' : r;
            opt.textContent = r;
            sel.appendChild(opt);
          });
          sel.addEventListener('change', function() { if (this.value) quickAssignRole(u.email, this.value); });
          roleTd.appendChild(sel);
        }

        tr.innerHTML = `
          <td>${u.fullName || '—'}</td>
          <td>${u.email || '—'}</td>
          <td>${u.phone || '—'}</td>`;
        tr.appendChild(roleTd);
        tr.insertAdjacentHTML('beforeend', `
          <td>${childrenCell}</td>
          <td class="${u.status==='active'?'status-active':'status-disabled'}">${u.status==='active'?'Active':'Disabled'}</td>
          <td>${u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '—'}</td>
          <td>
            <div class="action-grid">
              ${isParent ? `<button class="action-btn action-view" title="View Children" onclick="viewChildren('${u.email}')"><i class="fas fa-eye"></i></button>` : ''}
              <button class="action-btn action-edit" title="Edit User" onclick="editUserByEmail('${u.email}')"><i class="fas fa-edit"></i></button>
              <button class="action-btn action-reset" title="Reset Password" onclick="resetPassword('${userKey}','${u.email}')"><i class="fas fa-key"></i></button>
              <button class="action-btn action-delete" title="Delete User" onclick="deleteUserByEmail('${u.email}','${(u.fullName||u.email).replace(/'/g,"\\'")}')"><i class="fas fa-trash"></i></button>
            </div>
          </td>`);
      }
      tbody.appendChild(tr);
    });
  });

  document.querySelectorAll('.role-select').forEach(sel => {
    sel.style.cssText = `border:1px solid #d1fae5;border-radius:6px;padding:4px 8px;
      font-size:0.82rem;font-weight:600;cursor:pointer;background:#f0fdf4;color:#065f46;`;
  });

  // Async: refresh children cells for all parent rows with live data from backend
  // This catches children registered via the students page (parentName match)
  const parentUsers = users.filter(u => (u.role || '').toLowerCase() === 'parent' && u.email);
  parentUsers.forEach(async (u) => {
    const cellId = 'children-cell-' + u.email.replace(/[^a-z0-9]/gi, '_');
    try {
      const res = await fetch(`${API_BASE_URL}/api/parent/children`, {
        headers: { 'X-User-Email': u.email }
      });
      if (!res.ok) return;
      const liveChildren = await res.json();
      const cell = document.getElementById(cellId);
      if (!cell) return;
      if (liveChildren.length === 0) {
        cell.outerHTML = `<span id="${cellId}" style="color:#9ca3af;">—</span>`;
      } else {
        const html = `<div style="display:flex;flex-wrap:wrap;gap:2px;" id="${cellId}">${
          liveChildren.map(c =>
            `<span style="display:inline-block;background:#d1fae5;color:#065f46;border-radius:999px;
              padding:2px 9px;font-size:0.78rem;font-weight:600;margin:2px;">
              <i class="fas fa-child" style="font-size:0.7rem;margin-right:3px;"></i>${c.name || c.childName || '?'}
            </span>`
          ).join('')
        }</div>`;
        cell.outerHTML = html;
      }
    } catch(e) { /* non-fatal */ }
  });
}
// ── Edit by EMAIL or ID (students have no email) ─────────────
function editUserByEmail(emailOrId) {
  let user = allUsers.find(u => u.email === emailOrId);
  if (!user) user = allUsers.find(u => u.id === emailOrId);
  if (!user) return alert('User not found. Please refresh and try again.');
  openEditModal(user);
}

// ── Keep old editUser for backward compat ─────────────────────
async function editUser(id) {
  let user = allUsers.find(u => String(u.id) === String(id));
  if (!user && id && id !== 'null') {
    try {
      const res = await fetch(`${API_BASE_URL}/api/users/${id}`);
      if (res.ok) user = await res.json();
    } catch {}
  }
  if (!user) return alert('User not found. Please refresh the page.');
  openEditModal(user);
}

async function openEditModal(user) {
  document.getElementById('modalTitle').textContent = 'Edit User';
  document.getElementById('passwordGroup').style.display = 'none';
  document.getElementById('password').required = false;
  document.getElementById('editUserId').value    = user.id || '';
  document.getElementById('editUserEmail').value = user.email || '';
  document.getElementById('fullName').value      = user.fullName || '';
  document.getElementById('email').value         = user.email || '';
  document.getElementById('phone').value         = user.phone || '';
  document.getElementById('dob').value           = user.date_of_birth || '';
  document.getElementById('gender').value        = user.gender || '';
  document.getElementById('address').value       = user.address || '';
  document.getElementById('role').value          = user.role || '';
  document.getElementById('status').value        = user.status || 'active';

  document.getElementById('childrenContainer').innerHTML = '';
  showRoleInfo();
  document.getElementById('userModal').style.display = 'flex';

  // For parents: fetch live children from backend so edit fields always pre-fill correctly
  // This covers children from BOTH manage-users (children JSON) AND students page (parentName match)
  if ((user.role || '').toLowerCase() === 'parent' && user.email) {
    try {
      const res = await fetch(`${API_BASE_URL}/api/parent/children`, {
        headers: { 'X-User-Email': user.email }
      });
      if (res.ok) {
        const liveChildren = await res.json();
        if (liveChildren.length) {
          liveChildren.forEach(c => addChildField({
            childName:       c.name            || c.childName || '',
            admissionNumber: c.admissionNumber || c.admNo     || '',
            className:       c.class           || c.className || '',
            relationship:    c.relationship    || ''
          }));
          return;
        }
      }
    } catch(e) { console.warn('openEditModal: live fetch failed, using cache', e); }
    // Fallback: cached children
    (user.children || []).forEach(c => addChildField({
      childName:       c.childName    || c.name            || '',
      admissionNumber: c.admissionNumber || c.admNo        || '',
      className:       c.className    || c.class           || '',
      relationship:    c.relationship || ''
    }));
  }
}

// ── View children by EMAIL ────────────────────────────────────
async function viewChildren(email) {
  const user = allUsers.find(u => u.email === email);
  const displayName = user ? user.fullName : email;
  document.getElementById('childrenModalTitle').textContent = displayName + "'s Children";
  const list = document.getElementById('childrenList');

  // Show spinner immediately
  list.innerHTML =
    '<div style="text-align:center;padding:2rem;color:#6b7280;">' +
      '<i class="fas fa-spinner fa-spin" style="font-size:1.5rem;display:block;margin-bottom:0.75rem;"></i>' +
      '<p style="font-size:0.9rem;">Loading children...</p>' +
    '</div>';
  document.getElementById('childrenModal').style.display = 'flex';

  // Always fetch LIVE from backend — this includes children from both
  // manage-users (children JSON column) AND students page (parentName match)
  let children = [];
  try {
    const res = await fetch(`${API_BASE_URL}/api/parent/children`, {
      headers: { 'X-User-Email': email }
    });
    if (res.ok) {
      children = await res.json();
    } else {
      throw new Error('Status ' + res.status);
    }
  } catch (e) {
    console.warn('viewChildren fetch failed:', e);
    // Fallback: use cached children data with key normalisation
    if (user && user.children && user.children.length) {
      children = user.children.map(function(c) {
        return {
          name:            c.childName || c.name || c.fullName || 'Unknown',
          admissionNumber: c.admissionNumber || c.admNo || '—',
          class:           c.className || c.class || c.studentClass || '—',
          relationship:    c.relationship || 'Parent',
          id_resolved:     false
        };
      });
    }
  }

  if (children.length) {
    const count = children.length;
    list.innerHTML =
      '<div style="margin-bottom:1rem;color:#6b7280;font-size:0.88rem;">' +
        '<i class="fas fa-info-circle"></i> ' + count + ' child' + (count !== 1 ? 'ren' : '') + ' linked to this parent' +
      '</div>' +
      children.map(function(c) {
        const childName = c.name || c.childName || c.fullName || 'Unknown';
        const admNo     = c.admissionNumber || c.admNo || '—';
        const cls       = c.class || c.className || c.studentClass || '—';
        const rel       = c.relationship || 'Parent';
        const unmatched = c.id_resolved === false
          ? '<span style="background:#fef3c7;color:#92400e;border-radius:4px;padding:1px 7px;font-size:0.72rem;margin-left:6px;" title="Admission number not matched in students table">⚠ unmatched</span>'
          : '';
        return '<div style="border:1px solid #d1fae5;border-radius:10px;margin-bottom:0.75rem;overflow:hidden;">' +
          '<div style="background:#ecfdf5;padding:0.5rem 1rem;display:flex;justify-content:space-between;align-items:center;">' +
            '<span style="font-weight:700;color:#065f46;font-size:0.95rem;">' +
              '<i class="fas fa-child"></i> ' + childName + unmatched +
            '</span>' +
            '<span style="background:#065f46;color:#fff;border-radius:999px;padding:2px 12px;font-size:0.78rem;font-weight:600;">' +
              rel +
            '</span>' +
          '</div>' +
          '<div style="padding:0.75rem 1rem;display:grid;grid-template-columns:1fr 1fr;gap:0.5rem;font-size:0.88rem;">' +
            '<div>' +
              '<span style="color:#9ca3af;font-size:0.78rem;display:block;">ADMISSION NO.</span>' +
              '<span style="font-weight:600;color:#1f2937;">' + admNo + '</span>' +
            '</div>' +
            '<div>' +
              '<span style="color:#9ca3af;font-size:0.78rem;display:block;">CLASS</span>' +
              '<span style="font-weight:600;color:#1f2937;">' + cls + '</span>' +
            '</div>' +
          '</div>' +
        '</div>';
      }).join('');
  } else {
    list.innerHTML =
      '<div style="text-align:center;padding:2rem;color:#9ca3af;">' +
        '<i class="fas fa-child" style="font-size:2.5rem;display:block;margin-bottom:0.75rem;color:#d1fae5;"></i>' +
        '<p style="font-size:0.95rem;">No children linked to this parent yet.</p>' +
        '<p style="font-size:0.82rem;">Click the edit button to add children.</p>' +
      '</div>';
  }
}
function closeChildrenModal() { document.getElementById('childrenModal').style.display = 'none'; }

function searchUsers() {
  const q = document.getElementById('searchInput').value.toLowerCase();
  renderUsers(q ? allUsers.filter(u =>
    (u.fullName||'').toLowerCase().includes(q) ||
    (u.email||'').toLowerCase().includes(q) ||
    (u.role||'').toLowerCase().includes(q)) : allUsers);
}

// filterByRole(r) is defined above renderUsers — called by stat cards and role dropdown

// ── Add child field (collapsible card style) ──────────────────
function addChildField(childData = null) {
  const container = document.getElementById('childrenContainer');
  const idx = Date.now(); // unique key
  const childNum = container.querySelectorAll('.child-relationship').length + 1;
  container.insertAdjacentHTML('beforeend', `
    <div class="child-relationship" id="child-${idx}">
      <div class="child-card">
        <div class="child-card-header">
          <span><i class="fas fa-child"></i> Child ${childNum}</span>
          <button type="button" class="remove-child-btn" onclick="removeChildField(${idx})">
            <i class="fas fa-times"></i> Remove
          </button>
        </div>
        <div class="child-card-body">
          <div class="form-row">
            <div class="form-group">
              <label>Child's Full Name <span class="required">*</span></label>
              <input type="text" class="childName" value="${childData ? childData.childName : ''}" placeholder="e.g. John Kamau" required>
            </div>
            <div class="form-group">
              <label>Admission Number <span class="required">*</span></label>
              <input type="text" class="admissionNumber" value="${childData ? childData.admissionNumber : ''}" placeholder="e.g. ADM2024001" required>
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>Class <span class="required">*</span></label>
              <select class="className" required>
                <option value="">Select Class</option>
                ${['Grade 1','Grade 2','Grade 3','Grade 4','Grade 5','Grade 6','Grade 7','Grade 8']
                  .map(g => `<option value="${g}" ${childData && childData.className === g ? 'selected' : ''}>${g}</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <label>Relationship <span class="required">*</span></label>
              <select class="relationship" required>
                <option value="">Select</option>
                ${['Father','Mother','Guardian','Other']
                  .map(r => `<option value="${r}" ${childData && childData.relationship === r ? 'selected' : ''}>${r}</option>`).join('')}
              </select>
            </div>
          </div>
        </div>
      </div>
    </div>`);
}

function removeChildField(idx) {
  const el = document.getElementById(`child-${idx}`);
  if (el) el.remove();
  // Re-number remaining children
  document.querySelectorAll('.child-relationship').forEach((el, i) => {
    const header = el.querySelector('.child-card-header span');
    if (header) header.innerHTML = `<i class="fas fa-child"></i> Child ${i + 1}`;
  });
}

function getChildrenData() {
  return [...document.querySelectorAll('.child-relationship')].map(el => ({
    childName:       el.querySelector('.childName').value.trim(),
    admissionNumber: el.querySelector('.admissionNumber').value.trim(),
    className:       el.querySelector('.className').value,
    relationship:    el.querySelector('.relationship').value
  })).filter(c => c.childName && c.admissionNumber && c.className && c.relationship);
}

document.getElementById('createUserBtn').addEventListener('click', () => {
  document.getElementById('modalTitle').textContent = 'Create New User';
  document.getElementById('passwordGroup').style.display = 'block';
  document.getElementById('password').required = true;
  document.getElementById('password').type = 'password';
  document.getElementById('userForm').reset();
  document.getElementById('editUserId').value = '';
  document.getElementById('editUserEmail').value = '';
  document.getElementById('roleInfo').style.display = 'none';
  document.getElementById('studentFields').classList.remove('show');
  document.getElementById('parentFields').classList.remove('show');
  document.getElementById('childrenContainer').innerHTML = '';
  document.getElementById('userModal').style.display = 'flex';
});

function closeModal() { document.getElementById('userModal').style.display = 'none'; }

document.getElementById('userForm').addEventListener('submit', async e => {
  e.preventDefault();
  const id         = document.getElementById('editUserId').value;
  const savedEmail = document.getElementById('editUserEmail').value;
  const role       = document.getElementById('role').value;
  const isStudentRole = (role || '').toLowerCase() === 'student'; // FIX: was missing — caused ReferenceError on every save

  const payload = {
    fullName: document.getElementById('fullName').value.trim(),
    email:    document.getElementById('email').value.trim().toLowerCase(),
    phone:    document.getElementById('phone').value.trim(),
    date_of_birth: document.getElementById('dob').value || null,
    gender:   document.getElementById('gender').value || null,
    address:  document.getElementById('address').value.trim() || null,
    role,
    status: document.getElementById('status').value
  };

  if (isStudentRole) {
    payload.studentClass    = document.getElementById('studentClass').value;
    payload.admissionNumber = document.getElementById('admissionNumber').value.trim();
    payload.parentName      = document.getElementById('parentName').value.trim() || null;
    payload.parentPhone     = document.getElementById('parentPhone').value.trim() || null;
    payload.admissionDate   = document.getElementById('admissionDate').value || null;
    if (!payload.studentClass)    return alert('Please select a class');
    if (!payload.admissionNumber) return alert('Please enter an admission number');

    // Block save if admission number is already taken by another student
    const admEl = document.getElementById('admissionNumber');
    const admValid = await validateAdmissionNumberMU(admEl);
    if (!admValid) {
      admEl.focus();
      return;
    }
  }

  if ((role || '').toLowerCase() === 'parent') {
    const children = getChildrenData();
    if (!children.length) return alert('Please add at least one child for this parent');
    payload.children = children;
  }

  if (!isStudentRole && (!payload.fullName || !payload.email)) return alert('Full Name and Email are required');
  if (!payload.fullName) return alert('Full Name is required');
  if (!payload.role)     return alert('Please select a role');

  if (isStudentRole && !payload.email) {
    const adm = (payload.admissionNumber || '').toLowerCase().replace(/\s+/g, '');
    payload.email = adm ? `${adm}@student.emalashira.ac.ke` : `student${Date.now()}@student.emalashira.ac.ke`;
  }

  // Helper: sync parent's children into the students table
  async function syncChildrenToStudents(children, parentPayload) {
    for (const child of children) {
      const cp = {
        fullName:        child.childName       || child.name  || '',
        admissionNumber: child.admissionNumber || child.admNo || '',
        studentClass:    child.className       || child.class || '',
        parentName:      parentPayload.fullName || '',
        parentPhone:     parentPayload.phone    || '',
        status:          'active'
      };
      if (!cp.fullName || !cp.admissionNumber) continue;
      try {
        const cr = await fetch(`${API_BASE_URL}/api/students`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(cp)
        });
        if (cr.status === 409) {
          // Already exists — update parent info
          const stuRes = await fetch(`${API_BASE_URL}/api/students`);
          if (stuRes.ok) {
            const all = await stuRes.json();
            const existing = all.find(s => (s.admissionNumber || '').toLowerCase() === cp.admissionNumber.toLowerCase());
            if (existing) {
              await fetch(`${API_BASE_URL}/api/students/${existing.id}`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...existing, parentName: cp.parentName, parentPhone: cp.parentPhone })
              });
            }
          }
        }
      } catch(ce) { console.warn('Child sync failed:', cp.fullName, ce); }
    }
  }

  try {
    if (id || savedEmail) {
      // ── Edit mode ──
      let res;
      if (isStudentRole) {
        res = await fetch(`${API_BASE_URL}/api/students/${id}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
        });
      } else {
        res = id ? await fetch(`${API_BASE_URL}/api/users/${id}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
        }) : null;
        if (!res || !res.ok) {
          res = await fetch(`${API_BASE_URL}/api/users/update-by-email`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...payload, targetEmail: savedEmail || payload.email })
          });
        }
        if (!res || !res.ok) {
          res = await fetch(`${API_BASE_URL}/api/users/assign-role`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: savedEmail || payload.email, role: payload.role, status: payload.status })
          });
          if (!res.ok) throw new Error('Could not update user');
        }
      }
      if (res && !res.ok) { const err = await res.json(); throw new Error(err.message || 'Update failed'); }
      // Sync edited parent's children into students table
      if ((role || '').toLowerCase() === 'parent' && payload.children && payload.children.length) {
        await syncChildrenToStudents(payload.children, payload);
      }
    } else {
      // ── Create mode ──
      if (isStudentRole) {
        // Students MUST go to /api/students — create-user doesn't write to students table
        const res = await fetch(`${API_BASE_URL}/api/students`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
        });
        if (!res.ok) { const err = await res.json(); throw new Error(err.message); }
      } else {
        payload.password = document.getElementById('password').value;
        if (!payload.password || payload.password.length < 6) return alert('Password must be at least 6 characters');
        const res = await fetch(`${API_BASE_URL}/api/admin/create-user`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
        });
        if (!res.ok) { const err = await res.json(); throw new Error(err.message); }
        // Auto-create children in students table when new parent is saved
        if ((role || '').toLowerCase() === 'parent' && payload.children && payload.children.length) {
          await syncChildrenToStudents(payload.children, payload);
        }
      }
    }
    showToast(id || savedEmail ? '✅ User updated successfully' : '✅ User created successfully');
    closeModal();
    await loadUsers();
  } catch (err) { alert('Failed: ' + err.message); }
});

// ── Delete by EMAIL or ID ─────────────────────────────────────
async function deleteUserByEmail(emailOrId, name) {
  if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
  isDeleting = true;
  try {
    let user = allUsers.find(u => u.email === emailOrId);
    if (!user) user = allUsers.find(u => u.id === emailOrId);
    const id   = user ? user.id : null;
    const role = user ? (user.role || '') : '';
    let res;

    if (role.toLowerCase() === 'student') {
      // Students: delete from students table
      res = await fetch(`${API_BASE_URL}/api/students/${id}`, { method: 'DELETE' });
    } else if (id && id !== 'null') {
      res = await fetch(`${API_BASE_URL}/api/users/${id}`, { method: 'DELETE' });
    } else {
      res = await fetch(`${API_BASE_URL}/api/users/delete-by-email`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailOrId })
      });
    }
    showToast('✅ User deleted');
    await loadUsers();
  } catch (err) { alert('Delete failed: ' + err.message); }
  finally { isDeleting = false; }
}

async function deleteUser(id, name) { deleteUserByEmail(id, name); } // legacy

// ── Reset Password Modal ──────────────────────────────────────
let _resetId    = null;
let _resetEmail = null;

function toggleResetEye(inputId, iconId) {
  const inp  = document.getElementById(inputId);
  const icon = document.getElementById(iconId);
  const show = inp.type === 'password';
  inp.type       = show ? 'text' : 'password';
  icon.className = show ? 'fas fa-eye-slash' : 'fas fa-eye';
}

function getRpChecks(pwd) {
  return {
    length:  pwd.length >= 10,
    upper:   /[A-Z]/.test(pwd),
    lower:   /[a-z]/.test(pwd),
    number:  /[0-9]/.test(pwd),
    special: /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?~`]/.test(pwd)
  };
}

function isRpStrong(pwd) {
  const c = getRpChecks(pwd);
  return c.length && c.upper && c.lower && c.number && c.special;
}

function generateRpPassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ', lower = 'abcdefghjkmnpqrstuvwxyz';
  const nums  = '23456789', spec = '!@#$%^&*+-=?';
  const words = ['Tiger','Cloud','River','Stone','Flame','Eagle','Storm','Bloom',
                 'Swift','Frost','Grove','Spark','Brave','Prime','Light','Forge'];
  let pwd;
  do {
    const w  = words[Math.floor(Math.random() * words.length)];
    const raw = w
      + nums[Math.floor(Math.random()*nums.length)]
      + nums[Math.floor(Math.random()*nums.length)]
      + spec[Math.floor(Math.random()*spec.length)]
      + upper[Math.floor(Math.random()*upper.length)]
      + lower[Math.floor(Math.random()*lower.length)]
      + nums[Math.floor(Math.random()*nums.length)];
    pwd = raw.split('').sort(() => Math.random() - 0.5).join('');
  } while (!isRpStrong(pwd));
  return pwd;
}

function updateRpStrength(pwd) {
  const bar   = document.getElementById('resetStrengthBar');
  const fill  = document.getElementById('resetStrengthFill');
  const label = document.getElementById('resetStrengthLabel');
  const reqs  = document.getElementById('resetPwReqs');

  if (!pwd) {
    bar.style.display  = 'none';
    reqs.style.display = 'none';
    label.textContent  = '';
    return;
  }

  bar.style.display  = 'block';
  reqs.style.display = 'block';

  const checks = getRpChecks(pwd);
  const setReq = (id, ok) => {
    const el = document.getElementById(id);
    el.style.color = ok ? '#059669' : '#9ca3af';
    el.querySelector('i').style.color = ok ? '#059669' : '#9ca3af';
  };
  setReq('rreq-length',  checks.length);
  setReq('rreq-upper',   checks.upper);
  setReq('rreq-lower',   checks.lower);
  setReq('rreq-number',  checks.number);
  setReq('rreq-special', checks.special);

  const score  = Object.values(checks).filter(Boolean).length;
  const levels = [
    { color:'#ef4444', text:'Very Weak',  width:'10%'  },
    { color:'#f97316', text:'Weak',        width:'25%'  },
    { color:'#eab308', text:'Fair',        width:'50%'  },
    { color:'#3b82f6', text:'Strong',      width:'75%'  },
    { color:'#059669', text:'Very Strong', width:'100%' }
  ];
  const lv = levels[Math.max(score - 1, 0)];
  fill.style.width      = lv.width;
  fill.style.background = lv.color;
  label.textContent     = 'Password strength: ' + lv.text;
  label.style.color     = lv.color;
}

function checkRpMatch() {
  const pwd  = document.getElementById('resetNewPassword').value;
  const conf = document.getElementById('resetConfirmPassword').value;
  const msg  = document.getElementById('resetMatchMsg');
  msg.style.display = conf && pwd !== conf ? 'flex' : 'none';
}

function showRpGenerated(pwd) {
  document.getElementById('resetGenValue').textContent = pwd;
  document.getElementById('resetGenBox').style.display = 'block';
  document.getElementById('resetCopiedMsg').style.display = 'none';
}

function applyRpPassword(pwd) {
  document.getElementById('resetNewPassword').value     = pwd;
  document.getElementById('resetConfirmPassword').value = pwd;
  updateRpStrength(pwd);
  checkRpMatch();
}

async function resetPassword(id, email) {
  _resetId    = id;
  _resetEmail = email;
  document.getElementById('resetEmailText').textContent  = email;
  document.getElementById('resetNewPassword').value      = '';
  document.getElementById('resetConfirmPassword').value  = '';
  document.getElementById('resetGenBox').style.display   = 'none';
  document.getElementById('resetStrengthBar').style.display = 'none';
  document.getElementById('resetStrengthLabel').textContent = '';
  document.getElementById('resetPwReqs').style.display   = 'none';
  document.getElementById('resetMatchMsg').style.display = 'none';
  document.getElementById('resetPasswordModal').style.display = 'flex';
}

function closeResetModal() {
  document.getElementById('resetPasswordModal').style.display = 'none';
}

async function submitResetPassword() {
  const pwd  = document.getElementById('resetNewPassword').value;
  const conf = document.getElementById('resetConfirmPassword').value;

  if (!isRpStrong(pwd)) {
    alert('Please ensure the password meets all the requirements shown.');
    return;
  }
  if (pwd !== conf) {
    document.getElementById('resetMatchMsg').style.display = 'flex';
    return;
  }

  try {
    const res = await fetch(`${API_BASE_URL}/api/users/${_resetId}/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newPassword: pwd })
    });
    closeResetModal();
    showToast(res.ok ? '✅ Password reset successfully' : '⚠️ Reset may not have saved');
  } catch {
    showToast('⚠️ Could not reach server');
  }
}

// Wire up reset modal events after DOM ready
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('resetNewPassword').addEventListener('input', function() {
    updateRpStrength(this.value);
    checkRpMatch();
  });
  document.getElementById('resetConfirmPassword').addEventListener('input', checkRpMatch);

  document.getElementById('resetSuggestBtn').addEventListener('click', () => showRpGenerated(generateRpPassword()));
  document.getElementById('resetRefreshBtn').addEventListener('click', () => showRpGenerated(generateRpPassword()));

  document.getElementById('resetUseBtn').addEventListener('click', () => {
    const pwd = document.getElementById('resetGenValue').textContent;
    const msg = document.getElementById('resetCopiedMsg');
    applyRpPassword(pwd);
    navigator.clipboard?.writeText(pwd).then(() => {
      msg.textContent   = '✓ Applied & copied to clipboard!';
      msg.style.display = 'block';
      setTimeout(() => { msg.style.display = 'none'; }, 3000);
    }).catch(() => {
      msg.textContent   = '✓ Password applied to fields.';
      msg.style.display = 'block';
      setTimeout(() => { msg.style.display = 'none'; }, 3000);
    });
  });

  document.getElementById('resetGenValue').addEventListener('click', function() {
    const msg = document.getElementById('resetCopiedMsg');
    navigator.clipboard?.writeText(this.textContent).then(() => {
      msg.textContent   = '✓ Copied to clipboard!';
      msg.style.display = 'block';
      setTimeout(() => { msg.style.display = 'none'; }, 2000);
    });
  });
});

async function syncAllData() {
  showToast(`Synced: ${allUsers.filter(u=>u.role==='Student').length} students, ${allUsers.filter(u=>u.role==='Teacher').length} teachers`);
}

// Trigger on both DOMContentLoaded and load for reliability
document.addEventListener('DOMContentLoaded', () => loadUsers());
window.addEventListener('click', e => {
  if (e.target.id === 'userModal')          closeModal();
  if (e.target.id === 'childrenModal')      closeChildrenModal();
  if (e.target.id === 'resetPasswordModal') closeResetModal();
});