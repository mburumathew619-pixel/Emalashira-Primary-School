document.addEventListener('DOMContentLoaded', function () {
  console.log("=== dashboard.js loaded ===");
  
  // Prevent access if not logged in
  if (!sessionStorage.getItem('currentUser')) {
    console.log("No currentUser found, redirecting to login.html");
    window.location.href = 'login.html';
    return;
  }

  // Force reload if loaded from bfcache
  window.addEventListener('pageshow', function (event) {
    if (event.persisted) {
      console.log("Page loaded from bfcache, reloading");
      window.location.reload();
    }
  });

  // Start the dashboard
  console.log("Calling loadDashboard()");
  loadDashboard();
});

// ── Same flag as index.html ──
const USE_BACKEND  = true;
const API_BASE_URL = "http://emalashira-primary-school.onrender.com";

// Card definitions
const cardDefinitions = {
  "1": { title: "Dashboard Overview", icon: "tachometer-alt", description: "Quick overview of school activities and statistics", link: "dashboard-overview.html" },
  "2":  { title: "Students", icon: "user-graduate", description: "View and manage student information", link: "students.html" },
  "3":  { title: "Teachers", icon: "chalkboard-teacher", description: "Manage teacher records and assignments", link: "teacher-records.html" },
  "4":  { title: "Finance", icon: "dollar-sign", description: "Track fees, payments and financial reports", link: "finance.html" },
  "5":  { title: "Reports", icon: "chart-line", description: "Generate academic and administrative reports", link: "reports.html" },
  "6":  { title: "Grades", icon: "clipboard-list", description: "View and manage student grades", link: "grades.html" },
  "7":  { title: "Attendance", icon: "calendar-check", description: "Track student and teacher attendance", link: "attendance.html" },
  "8": { title: "Announcements", icon: "bullhorn", description: "View school announcements and notices", link: "announcements.html" }
};

function logout() {
  console.log("Logging out");
  sessionStorage.removeItem('currentUser');
  window.location.href = 'login.html';
}

function loadDashboard() {
  console.log("=== loadDashboard started ===");

  const userData = sessionStorage.getItem('currentUser');
  console.log("Raw sessionStorage data:", userData);

  if (!userData) {
    console.warn("No currentUser in sessionStorage → logging out");
    logout();
    return;
  }

  let user;
  try {
    user = JSON.parse(userData);
    console.log("Parsed user:", user);
  } catch (e) {
    console.error("Failed to parse currentUser:", e);
    alert("Session error: Invalid user data. Logging out.");
    logout();
    return;
  }

  // Fallbacks — always normalize role to lowercase
  const fullName    = user.fullName || user.email || 'User';
  const role        = (user.role || 'unknown').toLowerCase().trim();
  const displayRole = role.charAt(0).toUpperCase() + role.slice(1);
  const permissions = user.permissions || {};

  console.log("Full name:", fullName);
  console.log("Role:", role);
  console.log("Permissions keys:", Object.keys(permissions));

  // Update header safely
  const nameEl = document.getElementById('userNameDisplay');
  const roleEl = document.getElementById('roleBadge');
  
  if (nameEl) {
    nameEl.textContent = fullName;
    console.log("Updated userNameDisplay");
  } else {
    console.warn("userNameDisplay element not found");
  }
  
  if (roleEl) {
    roleEl.textContent = displayRole;
    console.log("Updated roleBadge");
  } else {
    console.warn("roleBadge element not found");
  }

  const titleEl = document.getElementById('dashboardTitle');
  const pageTitleEl = document.getElementById('pageTitle');
  if (titleEl) titleEl.textContent = `${displayRole} Dashboard`;
  if (pageTitleEl) pageTitleEl.textContent = `${displayRole} Dashboard - EMALASHIRA Primary School`;

  // Admin OR default 'user' role → full access
  const isFullAccess = ['admin', 'user'].includes(role.toLowerCase()) || Object.keys(permissions).length === 0;

  if (isFullAccess) {
    console.log("Full access role detected → showing full dashboard");
    // Show all menu items
    document.querySelectorAll('.sidebar-menu a').forEach(link => {
      link.classList.remove('hidden');
    });

    // Render all cards
    const container = document.getElementById('dashboardCards');
    if (container) {
      console.log("Rendering all cards");
      container.innerHTML = '';
      Object.keys(cardDefinitions).forEach(moduleId => {
        const card = cardDefinitions[moduleId];
        container.innerHTML += `
          <div class="card">
            <div class="card-header">
              <i class="fas fa-${card.icon}"></i>
              ${card.title}
            </div>
            <div class="card-body">
              <p>${card.description}</p>
            </div>
            <div class="card-actions">
              <a href="${card.link}" class="btn btn-primary">Open</a>
            </div>
          </div>
        `;
      });
      console.log("Cards rendered successfully");
    } else {
      console.error("dashboardCards container not found!");
    }
    return;
  }

  // For non-admin: normal permission check
  console.log("Applying normal permission check...");
  document.querySelectorAll('.sidebar-menu a[data-module]').forEach(link => {
    const moduleId = link.getAttribute('data-module');
    const canView = permissions[moduleId]?.["1"] === true;
    link.classList.toggle('hidden', !canView);
  });

  const container = document.getElementById('dashboardCards');
  if (container) {
    container.innerHTML = '';

    let hasAnyAccess = false;

    Object.keys(cardDefinitions).forEach(moduleId => {
      if (permissions[moduleId]?.["1"] === true) {
        hasAnyAccess = true;
        const card = cardDefinitions[moduleId];
        container.innerHTML += `
          <div class="card">
            <div class="card-header">
              <i class="fas fa-${card.icon}"></i>
              ${card.title}
            </div>
            <div class="card-body">
              <p>${card.description}</p>
            </div>
            <div class="card-actions">
              <a href="${card.link}" class="btn btn-primary">Open</a>
            </div>
          </div>
        `;
      }
    });

    if (!hasAnyAccess) {
      container.innerHTML = `
        <div class="access-denied">
          <i class="fas fa-ban"></i>
          <h2>Access Restricted</h2>
          <p>Your role (${displayRole}) does not have permission to view any dashboard modules.</p>
          <p>Please contact the school administrator to update your permissions.</p>
          <button onclick="logout()" class="btn btn-primary" style="margin-top:1.5rem; padding:12px 24px;">
            Log out
          </button>
        </div>
      `;
    }
  } else {
    console.error("dashboardCards container not found!");
  }
}

// Remove the duplicate window.load event listener at the bottom
// The one at the top with DOMContentLoaded is sufficient
