const API_BASE_URL = "https://emalashira-primary-school.onrender.com";

// ── Data ──────────────────────────────────────────────────────
const modules = [
  { id: 1,  name: 'Dashboard',       isSensitive: false },
  { id: 2,  name: 'Students',        isSensitive: false },
  { id: 3,  name: 'Teachers',        isSensitive: false },
  { id: 4,  name: 'Finance',         isSensitive: true  },
  { id: 5,  name: 'Reports',         isSensitive: true  },
  { id: 6,  name: 'Grades',          isSensitive: false },
  { id: 7,  name: 'Attendance',      isSensitive: false },
  { id: 8,  name: 'User Management', isSensitive: true  },
  { id: 9,  name: 'Settings',        isSensitive: true  },
  { id: 10, name: 'Announcements',   isSensitive: false }
];

const permissions = [
  { id: 1, name: 'View'   },
  { id: 2, name: 'Create' },
  { id: 3, name: 'Edit'   },
  { id: 4, name: 'Delete' },
  { id: 5, name: 'Export' }
];

let roles               = [];
let selectedRole        = null;
let originalPermissions = null;

// ── Init ──────────────────────────────────────────────────────
window.addEventListener('load', () => {
  const raw = sessionStorage.getItem('currentUser');
  if (!raw) { window.location.href = 'login.html'; return; }
  try {
    const data = JSON.parse(raw);
    // Guard: only admins may access this page
    if (!data.role || data.role.toLowerCase().trim() !== 'admin') {
      alert('This page is for administrators only.');
      window.location.href = 'dashboard.html';
      return;
    }
    document.getElementById('userNameDisplay').textContent = data.fullName || 'Admin';
  } catch (err) { console.error(err); }
  // Load silently on init — no error banners for background fetch issues
  loadRoles().catch(e => console.error('Initial role load failed:', e));
});

// ── Auth ──────────────────────────────────────────────────────
function logout() {
  sessionStorage.removeItem('currentUser');
  window.location.href = 'login.html';
}

// ── Sync role counts from live DB ────────────────────────────
async function syncRoleCounts() {
  const btn = document.getElementById('syncRolesBtn');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Syncing...';
  }
  try {
    await loadRoles();
    showAlert('success', '✅ Counts synced successfully');
  } catch (e) {
    showAlert('danger', '❌ Could not sync counts');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-sync-alt"></i> Sync Counts';
    }
  }
}

// ── Load roles and compute live user counts ───────────────────
async function loadRoles() {
  try {
    // Fetch roles first — this must succeed
    const rolesRes = await fetch(`${API_BASE_URL}/api/roles`);
    if (!rolesRes.ok) throw new Error('Failed to load roles');
    roles = await rolesRes.json();

    // Fetch users and students independently — failures are non-fatal
    const countMap = {};
    roles.forEach(r => { countMap[r.name.toLowerCase()] = 0; });

    try {
      const usersRes = await fetch(`${API_BASE_URL}/api/users`);
      if (usersRes.ok) {
        const users = await usersRes.json();
        users
          .filter(u => (u.status || '').toLowerCase().trim() === 'active')
          .forEach(u => {
            const key = (u.role || '').toLowerCase().trim();
            if (key in countMap) countMap[key]++;
          });
      }
    } catch (e) { console.warn('Could not fetch users for count:', e); }

    try {
      const studentsRes = await fetch(`${API_BASE_URL}/api/students`);
      if (studentsRes.ok) {
        const students = await studentsRes.json();
        // Only count active students
        const activeStudents = students.filter(s => (s.status || 'active').toLowerCase() === 'active');
        if ('student' in countMap) countMap['student'] = activeStudents.length;
      }
    } catch (e) { console.warn('Could not fetch students for count:', e); }

    // Patch each role's users_count with the live value
    roles = roles.map(r => ({
      ...r,
      users_count: countMap[r.name.toLowerCase()] ?? r.users_count ?? 0
    }));

    renderRolesGrid();
  } catch (error) {
    console.error('Error loading roles:', error);
    showAlert('danger', 'Failed to load roles');
  }
}

// ── Render roles grid ─────────────────────────────────────────
function renderRolesGrid() {
  const grid = document.getElementById('rolesGrid');
  grid.innerHTML = roles.map(role => `
    <div class="role-card ${selectedRole?.id === role.id ? 'active' : ''}"
         onclick="selectRole(${role.id})">
      <div class="role-card-header">
        <div><div class="role-card-name">${role.name}</div></div>
        ${role.is_system_role ? '<span class="role-badge">System</span>' : ''}
      </div>
      <div class="role-card-description">${role.description}</div>
      <div class="role-card-users">
        <i class="fas fa-users"></i>
        <span>${role.users_count} users</span>
      </div>
    </div>
  `).join('');
}

// ── Select role ───────────────────────────────────────────────
function selectRole(roleId) {
  selectedRole = roles.find(r => r.id === roleId);
  if (!selectedRole) return;

  originalPermissions = JSON.parse(JSON.stringify(selectedRole.permissions));
  document.getElementById('selectedRoleName').textContent        = selectedRole.name;
  document.getElementById('selectedRoleDescription').textContent = selectedRole.description;
  document.getElementById('noSelectionMessage').style.display    = 'none';
  document.getElementById('permissionsContent').style.display    = 'block';

  renderPermissionsTable();
  renderRolesGrid();
}

// ── Render permissions table ──────────────────────────────────
function renderPermissionsTable() {
  document.getElementById('permissionsTableBody').innerHTML = modules.map(module => `
    <tr>
      <td>
        <div class="module-name">
          <i class="fas fa-${getIcon(module.name)}"></i>
          ${module.name}
          ${module.isSensitive ? '<span class="sensitive-badge">Sensitive</span>' : ''}
        </div>
      </td>
      <td>
        <div class="permission-actions">
          ${permissions.map(perm => `
            <div class="permission-checkbox">
              <input type="checkbox"
                     id="perm_${module.id}_${perm.id}"
                     ${isEnabled(module.id, perm.id) ? 'checked' : ''}
                     onchange="toggle(${module.id}, ${perm.id}, this.checked)">
              <label for="perm_${module.id}_${perm.id}">${perm.name}</label>
            </div>
          `).join('')}
        </div>
      </td>
    </tr>
  `).join('');
}

// ── Helpers ───────────────────────────────────────────────────
function getIcon(name) {
  const icons = {
    'Dashboard': 'tachometer-alt', 'Students': 'user-graduate',
    'Teachers': 'chalkboard-teacher', 'Finance': 'dollar-sign',
    'Reports': 'chart-line', 'Grades': 'clipboard-list',
    'Attendance': 'calendar-check', 'User Management': 'users-cog',
    'Settings': 'cog', 'Announcements': 'bullhorn'
  };
  return icons[name] || 'folder';
}

function isEnabled(modId, permId) {
  return selectedRole?.permissions?.[String(modId)]?.[String(permId)] || false;
}

function toggle(modId, permId, enabled) {
  if (!selectedRole.permissions[String(modId)]) {
    selectedRole.permissions[String(modId)] = {};
  }
  selectedRole.permissions[String(modId)][String(permId)] = enabled;
}

// ── Save permissions ──────────────────────────────────────────
async function savePermissions() {
  try {
    const res = await fetch(`${API_BASE_URL}/api/roles/${selectedRole.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ permissions: selectedRole.permissions })
    });
    if (!res.ok) throw new Error('Save failed');
    originalPermissions = JSON.parse(JSON.stringify(selectedRole.permissions));
    await loadRoles();
    showAlert('success', 'Permissions saved successfully!');
  } catch (error) {
    showAlert('danger', 'Failed to save permissions');
  }
}

// ── Reset permissions ─────────────────────────────────────────
function resetPermissions() {
  if (!originalPermissions) return;
  selectedRole.permissions = JSON.parse(JSON.stringify(originalPermissions));
  renderPermissionsTable();
  showAlert('success', 'Permissions reset!');
}

// ── Delete role ───────────────────────────────────────────────
async function deleteRole() {
  if (!selectedRole) return;
  if (confirm(`Are you sure you want to delete the role "${selectedRole.name}"?`)) {
    try {
      const res = await fetch(`${API_BASE_URL}/api/roles/${selectedRole.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      selectedRole = null;
      document.getElementById('noSelectionMessage').style.display = 'block';
      document.getElementById('permissionsContent').style.display = 'none';
      await loadRoles();
      showAlert('success', 'Role deleted successfully!');
    } catch (error) {
      showAlert('danger', 'Failed to delete role');
    }
  }
}

// ── Create role modal ─────────────────────────────────────────
function openCreateRoleModal() {
  document.getElementById('newRoleName').value        = '';
  document.getElementById('newRoleDescription').value = '';
  document.getElementById('createRoleModal').style.display = 'flex';
}

function closeCreateRoleModal() {
  document.getElementById('createRoleModal').style.display = 'none';
}

async function createRole(event) {
  event.preventDefault();
  const name        = document.getElementById('newRoleName').value.trim();
  const description = document.getElementById('newRoleDescription').value.trim();
  if (!name) return;

  const defaultPermissions = {};
  modules.forEach(m => {
    defaultPermissions[String(m.id)] = {};
    permissions.forEach(p => { defaultPermissions[String(m.id)][String(p.id)] = false; });
  });

  try {
    const res = await fetch(`${API_BASE_URL}/api/roles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description, permissions: defaultPermissions })
    });
    if (!res.ok) throw new Error('Create failed');
    closeCreateRoleModal();
    await loadRoles();
    showAlert('success', `Role "${name}" created successfully!`);
  } catch (error) {
    showAlert('danger', 'Failed to create role');
  }
}

// ── Alert helper ──────────────────────────────────────────────
function showAlert(type, message) {
  const successEl = document.getElementById('alertSuccess');
  const dangerEl  = document.getElementById('alertDanger');
  successEl.style.display = 'none';
  dangerEl.style.display  = 'none';

  if (type === 'success') {
    document.getElementById('alertSuccessMessage').textContent = message;
    successEl.style.display = 'flex';
    setTimeout(() => { successEl.style.display = 'none'; }, 4000);
  } else {
    document.getElementById('alertDangerMessage').textContent = message;
    dangerEl.style.display = 'flex';
    setTimeout(() => { dangerEl.style.display = 'none'; }, 4000);
  }
}

// ── Close modal on outside click ──────────────────────────────
window.addEventListener('click', function(event) {
  const modal = document.getElementById('createRoleModal');
  if (event.target === modal) closeCreateRoleModal();
});
