const API = 'http://localhost:5000';
let editingId     = null;
let announcements = [];

function getCurrentUser() {
  try { return JSON.parse(sessionStorage.getItem('currentUser') || '{}'); } catch { return {}; }
}

async function loadAnnouncements() {
  try {
    const res = await fetch(`${API}/api/announcements`);
    if (!res.ok) throw new Error();
    announcements = await res.json();
    renderAnnouncements();
    updateCount();
  } catch {
    announcements = [];
    renderAnnouncements();
    showToast('⚠️ Could not connect to server.', true);
  }
}

function updateCount() {
  const el = document.getElementById('ann-count-badge');
  if (el) el.textContent = announcements.length
    ? `${announcements.length} announcement${announcements.length > 1 ? 's' : ''}`
    : 'No announcements yet';
}

async function saveAnnouncement() {
  const title    = document.getElementById('title').value.trim();
  const content  = document.getElementById('content').value.trim();
  const audience = document.getElementById('audience').value;
  const priority = document.getElementById('priority').value;

  if (!title)   { showFormError('Please enter a title.'); return; }
  if (!content) { showFormError('Please enter the announcement message.'); return; }
  clearFormError();

  const user = getCurrentUser();
  const btn  = document.getElementById('publish-btn');
  btn.disabled    = true;
  btn.textContent = editingId ? 'Updating...' : 'Publishing...';

  try {
    let res;
    if (editingId) {
      res = await fetch(`${API}/api/announcements/${editingId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, content, audience, priority })
      });
    } else {
      res = await fetch(`${API}/api/announcements`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title, content, audience, priority,
          author:      user.fullName || user.email || 'Admin',
          author_role: user.role || 'Admin'
        })
      });
    }
    if (!res.ok) throw new Error();
    showToast(editingId ? '✅ Announcement updated.' : '✅ Published — parents can now see it.');
    resetForm();
    await loadAnnouncements();
  } catch {
    showToast('❌ Failed to save. Check server connection.', true);
  } finally {
    btn.disabled    = false;
    btn.textContent = editingId ? 'Update Announcement' : 'Publish Announcement';
  }
}

function editAnnouncement(id) {
  const ann = announcements.find(a => a.id === id);
  if (!ann) return;
  document.getElementById('title').value    = ann.title;
  document.getElementById('content').value  = ann.content;
  document.getElementById('audience').value = ann.audience || 'all';
  document.getElementById('priority').value = ann.priority || 'normal';
  editingId = id;
  document.getElementById('form-title').textContent  = 'Edit Announcement';
  document.getElementById('publish-btn').textContent = 'Update Announcement';
  const cb = document.getElementById('cancel-edit-btn');
  if (cb) cb.style.display = 'inline-flex';
  document.getElementById('announcement-form').scrollIntoView({ behavior: 'smooth' });
}

async function deleteAnnouncement(id) {
  if (!confirm('Delete this announcement? Parents will no longer see it.')) return;
  try {
    const res = await fetch(`${API}/api/announcements/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error();
    showToast('🗑️ Announcement deleted.');
    if (editingId === id) resetForm();
    await loadAnnouncements();
  } catch {
    showToast('❌ Delete failed. Try again.', true);
  }
}

function resetForm() {
  document.getElementById('title').value    = '';
  document.getElementById('content').value  = '';
  document.getElementById('audience').value = 'all';
  document.getElementById('priority').value = 'normal';
  editingId = null;
  clearFormError();
  document.getElementById('form-title').textContent  = 'Create New Announcement';
  document.getElementById('publish-btn').textContent = 'Publish Announcement';
  const cb = document.getElementById('cancel-edit-btn');
  if (cb) cb.style.display = 'none';
}

// ── Helper: safely convert plain text to paragraphs (respects line breaks) ──
function textToHtml(text) {
  if (!text) return '';
  // Escape HTML entities first
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  // Split on double newlines → paragraphs; single newlines → <br>
  return escaped
    .split(/\n{2,}/)
    .map(para => `<p style="margin:0 0 0.75rem;line-height:1.7;">${para.replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function renderAnnouncements() {
  const container = document.getElementById('active-list');
  container.innerHTML = '';

  if (!announcements.length) {
    container.innerHTML = `
      <div style="text-align:center;padding:3rem 1rem;color:#9ca3af;">
        <i class="bi bi-megaphone" style="font-size:2.5rem;display:block;margin-bottom:.75rem;opacity:.4;"></i>
        <p style="font-size:.95rem;">No announcements yet.<br>Create one above to notify parents.</p>
      </div>`;
    return;
  }

  announcements.forEach(ann => {
    const priMap = {
      normal: { label: '🟢 Normal', cls: 'pri-normal' },
      high:   { label: '🔴 High',   cls: 'pri-high'   },
      urgent: { label: '🟣 Urgent', cls: 'pri-urgent'  }
    };
    const pri  = priMap[ann.priority] || priMap.normal;
    const aud  = ann.audience === 'all' ? 'All' : (ann.audience || 'All');
    const date = ann.created_at
      ? new Date(ann.created_at).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'})
      : '—';
    const edited = ann.updated_at
      ? ` · <span style="color:#d97706;">Edited ${new Date(ann.updated_at).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'})}</span>`
      : '';

    const div = document.createElement('div');
    div.className = 'announcement-item';
    div.innerHTML = `
      <div class="ann-item-header">
        <h3 class="announcement-title">${ann.title}</h3>
        <span class="pri-badge ${pri.cls}">${pri.label}</span>
      </div>
      <div class="meta">
        <i class="bi bi-person-badge"></i> ${ann.author} (${ann.author_role})
        &nbsp;·&nbsp;<i class="bi bi-calendar3"></i> ${date}${edited}
        &nbsp;·&nbsp;<i class="bi bi-people"></i> ${aud}
      </div>
      <div class="content" style="font-size:.9rem;color:#4b5563;margin-bottom:.9rem;">${textToHtml(ann.content)}</div>
      <div class="actions">
        <button class="btn-small btn-edit"   onclick="editAnnouncement('${ann.id}')"><i class="bi bi-pencil"></i> Edit</button>
        <button class="btn-small btn-delete" onclick="deleteAnnouncement('${ann.id}')"><i class="bi bi-trash"></i> Delete</button>
      </div>`;
    container.appendChild(div);
  });
}

// ── renderAnnouncementCard: used by the parent dashboard ─────────────────────
// Call this from the parent dashboard wherever announcements are rendered.
// Usage: container.appendChild(renderAnnouncementCard(ann));
function renderAnnouncementCard(ann) {
  const priMap = {
    normal: { label: 'Normal', color: '#065f46', bg: '#d1fae5', dot: '#10b981' },
    high:   { label: 'High',   color: '#991b1b', bg: '#fee2e2', dot: '#ef4444' },
    urgent: { label: 'Urgent', color: '#5b21b6', bg: '#ede9fe', dot: '#7c3aed' }
  };
  const pri  = priMap[ann.priority] || priMap.normal;
  const aud  = ann.audience === 'all' ? 'All' : (ann.audience || 'All');
  const date = ann.created_at
    ? new Date(ann.created_at).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'})
    : '—';

  const card = document.createElement('div');
  card.style.cssText = [
    'background:#fff',
    'border:1px solid #e5e7eb',
    'border-left:4px solid ' + pri.dot,
    'border-radius:12px',
    'padding:1.25rem 1.5rem',
    'margin-bottom:1rem',
    'box-shadow:0 2px 8px rgba(0,0,0,0.06)',
    'transition:box-shadow 0.2s'
  ].join(';');
  card.onmouseenter = () => card.style.boxShadow = '0 4px 18px rgba(0,0,0,0.11)';
  card.onmouseleave = () => card.style.boxShadow = '0 2px 8px rgba(0,0,0,0.06)';

  card.innerHTML = `
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;margin-bottom:0.5rem;flex-wrap:wrap;">
      <h3 style="margin:0;font-size:1rem;font-weight:700;color:#1f2937;flex:1;">${ann.title}</h3>
      <span style="background:${pri.bg};color:${pri.color};font-size:0.74rem;font-weight:700;
                   padding:3px 11px;border-radius:20px;white-space:nowrap;display:inline-flex;
                   align-items:center;gap:5px;flex-shrink:0;">
        <span style="width:7px;height:7px;border-radius:50%;background:${pri.dot};display:inline-block;"></span>
        ${pri.label}
      </span>
    </div>
    <div style="font-size:0.79rem;color:#9ca3af;margin-bottom:0.85rem;display:flex;flex-wrap:wrap;gap:0.5rem;align-items:center;">
      <span><i class="bi bi-person-badge" style="margin-right:3px;"></i>${ann.author || 'School Admin'}</span>
      <span style="color:#d1d5db;">·</span>
      <span><i class="bi bi-calendar3" style="margin-right:3px;"></i>${date}</span>
      <span style="color:#d1d5db;">·</span>
      <span><i class="bi bi-people" style="margin-right:3px;"></i>${aud}</span>
    </div>
    <div style="font-size:0.9rem;color:#374151;">${textToHtml(ann.content)}</div>
  `;
  return card;
}

function showFormError(msg) {
  let el = document.getElementById('form-error');
  if (!el) {
    el = document.createElement('div');
    el.id = 'form-error';
    el.style.cssText = 'background:#fee2e2;color:#991b1b;border-radius:8px;padding:.6rem 1rem;font-size:.88rem;margin-top:.75rem;';
    document.getElementById('publish-btn').insertAdjacentElement('afterend', el);
  }
  el.textContent = msg;
  el.style.display = 'block';
}
function clearFormError() {
  const el = document.getElementById('form-error');
  if (el) el.style.display = 'none';
}

function showToast(msg, isError = false) {
  let t = document.getElementById('ann-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'ann-toast';
    t.style.cssText = 'position:fixed;bottom:24px;right:24px;padding:12px 20px;border-radius:10px;font-size:.9rem;font-weight:600;z-index:99999;color:#fff;box-shadow:0 4px 20px rgba(0,0,0,.25);transition:opacity .4s;opacity:0;max-width:360px;';
    document.body.appendChild(t);
  }
  t.style.background = isError ? '#dc2626' : '#065f46';
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.style.opacity = '0'; }, 4000);
}

window.addEventListener('load', loadAnnouncements);