// auth-check-clean.js — 2026 hardened version
(function () {
  'use strict';

  const currentPage = (window.location.pathname.split('/').pop() || '').toLowerCase();

  // ── Pages everyone logged in can access ────────────────────────
  const publicPages = [
    'profile.html',
    'teacher-profile.html',
    'parent-profile.html',
    'finance-profile.html',
    'dashboard.html',
    'dashboard-overview.html',
    'index.html',           // just in case
    'pending-approval.html'
  ];

  // ── Admin-only pages ───────────────────────────────────────────
  const adminOnly = [
    'manage-users.html',
    'roles-permissions.html',
    'settings.html',
    'backup-restore.html',
    'announcements.html',    // if you want to restrict
  ];

  // ── Get user (only sessionStorage now) ─────────────────────────
  let user = null;
  try {
    const raw = sessionStorage.getItem('currentUser');
    if (raw) user = JSON.parse(raw);
  } catch (e) {
    console.error("[AuthGuard] Parse error:", e);
  }

  // No valid session → login
  if (!user || !user.email || !user.role) {
    console.warn("[AuthGuard] No valid session → to login");
    sessionStorage.clear(); // clean up broken data
    window.location.replace('login.html');
    return;
  }

  const role = (user.role || '').trim().toLowerCase();

  // Invalid role → pending
  if (!['admin','teacher','parent','accountant'].includes(role)) {
    window.location.replace('pending-approval.html');
    return;
  }

  // ── Rule: profile pages = always allowed if logged in ──────────
  if (currentPage.includes('profile.html')) {
    console.log(`[Auth] Profile page allowed — role: ${role}`);
    return; // ← most important line
  }

  // ── Admin-only pages protection ────────────────────────────────
  if (adminOnly.some(p => currentPage === p) && role !== 'admin') {
    alert("This page is for administrators only.");
    const redirectMap = {
      'teacher':    'teacher-dashboard.html',
      'parent':     'parent-dashboard.html',
      'accountant': 'finance-dashboard.html'
    };
    window.location.replace(redirectMap[role] || 'dashboard.html');
    return;
  }

  // Default: allow
  console.log(`[Auth] Access granted — ${role} on ${currentPage}`);
})();