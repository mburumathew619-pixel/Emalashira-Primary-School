const API_BASE_URL = 'https://emalashira-primary-school.onrender.com';

// ── Cached chart instances ──────────────────────────────────
let _enrollChart = null;
let _feeChart    = null;
let _gradeChart  = null;
let _attChart    = null;

// ── Auth ────────────────────────────────────────────────────
function logout() {
    sessionStorage.removeItem('currentUser');
    window.location.href = 'login.html';
}

function loadUserInfo() {
    const raw = sessionStorage.getItem('currentUser');
    if (!raw) { logout(); return; }
    try {
        const user = JSON.parse(raw);
        const nameEl = document.getElementById('userNameDisplay');
        const roleEl = document.getElementById('roleBadge');
        if (nameEl) nameEl.textContent = user.fullName || user.email || 'User';
        if (roleEl) {
            roleEl.textContent = user.role || 'User';
            roleEl.className   = 'role-badge ' + (user.role || 'user').toLowerCase();
        }
    } catch (e) { logout(); }
}

// ── Formatters ──────────────────────────────────────────────
function fmtKes(n) {
    if (n >= 1000000) return 'KES ' + (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000)    return 'KES ' + (n / 1000).toFixed(0) + 'K';
    return 'KES ' + Number(n || 0).toLocaleString();
}
function fmtFull(n) {
    return 'Ksh ' + Number(n || 0).toLocaleString('en-KE');
}
function fmtDate(d) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
function timeAgo(d) {
    if (!d) return '';
    const diff = (Date.now() - new Date(d)) / 1000;
    if (diff < 60)    return Math.floor(diff) + 's ago';
    if (diff < 3600)  return Math.floor(diff / 60) + ' min ago';
    if (diff < 86400) return Math.floor(diff / 3600) + ' hr ago';
    return fmtDate(d);
}

// ── Toast ────────────────────────────────────────────────────
function showToast(msg, isError) {
    let t = document.getElementById('ovToast');
    if (!t) {
        t = document.createElement('div');
        t.id = 'ovToast';
        t.style.cssText = 'position:fixed;bottom:24px;right:24px;padding:12px 20px;border-radius:8px;' +
            'font-size:.9rem;z-index:9999;color:#fff;box-shadow:0 4px 16px rgba(0,0,0,.2);transition:opacity .35s;';
        document.body.appendChild(t);
    }
    t.style.background = isError ? '#dc2626' : '#065f46';
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(t._t);
    t._t = setTimeout(() => { t.style.opacity = '0'; }, 3500);
}

// ── Sync button state ────────────────────────────────────────
function setSyncState(loading) {
    const btn  = document.getElementById('syncBtn');
    const icon = document.getElementById('syncIcon');
    const text = document.getElementById('syncText');
    if (!btn) return;
    btn.disabled = loading;
    if (icon) icon.className = loading ? 'fas fa-spinner fa-spin' : 'fas fa-sync-alt';
    if (text) text.textContent = loading ? 'Loading...' : 'Refresh Data';
}

// ── Stat cards ───────────────────────────────────────────────
function updateStatCards(dash, attSummary) {
    const set = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };

    const totalStudents  = dash.students?.total             || 0;
    const activeStudents = dash.students?.active            || 0;
    const totalTeachers  = dash.staff?.teachers             || 0;
    const totalParents   = dash.staff?.parents              || 0;
    const collected      = dash.fees?.total_collected       || 0;
    const arrears        = dash.fees?.total_arrears         || 0;
    const rate           = dash.fees?.collection_rate       || 0;
    const paidCount      = dash.fees?.students_paid         || 0;
    const byGrade        = dash.students?.by_grade          || [];

    set('totalStudents', totalStudents.toLocaleString());
    set('totalTeachers', totalTeachers.toLocaleString());
    set('totalRevenue',  fmtKes(collected));
    set('pendingFees',   fmtKes(arrears));
    set('activeClasses', byGrade.filter(g => (g.count || 0) > 0).length);

    set('studentsSubtext', activeStudents + ' active, ' + (totalStudents - activeStudents) + ' inactive');
    set('teachersSubtext', totalParents + ' parent' + (totalParents !== 1 ? 's' : '') + ' registered');
    set('revenueSubtext',  rate.toFixed(1) + '% collection rate');
    set('feesSubtext',     (totalStudents - paidCount) + ' students outstanding');

    // Attendance from today's summary
    if (attSummary && attSummary.length) {
        const totalPresent = attSummary.reduce((s, c) => s + (c.present || 0), 0);
        const totalRec     = attSummary.reduce((s, c) => s + (c.total   || 0), 0);
        set('attendanceRate',    totalRec > 0 ? ((totalPresent / totalRec) * 100).toFixed(1) + '%' : '—');
        set('attendanceSubtext', totalRec > 0 ? totalPresent + ' of ' + totalRec + ' present today' : 'No records today');
    } else {
        set('attendanceRate',    '—');
        set('attendanceSubtext', 'No attendance records today');
    }
}

// ── Enrollment line chart ────────────────────────────────────
// Uses by_grade to get current total; plots a flat line with per-grade breakdown as tooltip
function updateEnrollmentChart(byGrade) {
    const ctx = document.getElementById('enrollmentChart');
    if (!ctx) return;

    const total  = byGrade.reduce((s, g) => s + (g.count || 0), 0);
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    if (_enrollChart) { _enrollChart.destroy(); _enrollChart = null; }
    _enrollChart = new Chart(ctx.getContext('2d'), {
        type: 'line',
        data: {
            labels: months,
            datasets: [{
                label: 'Students Enrolled',
                data: Array(12).fill(total),
                borderColor: '#065f46',
                backgroundColor: 'rgba(6,95,70,0.12)',
                tension: 0.4, fill: true, borderWidth: 3,
                pointRadius: 4, pointHoverRadius: 6
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        afterBody: () => byGrade.map(g => '  ' + (g.grade || '?') + ': ' + (g.count || 0))
                    }
                }
            },
            scales: {
                y: { beginAtZero: false, min: Math.max(0, total - 20), grid: { color: '#e2e8f0' } },
                x: { grid: { display: false } }
            }
        }
    });
}

// ── Fee doughnut chart ───────────────────────────────────────
function updateFeeChart(fees) {
    const ctx = document.getElementById('feeChart');
    if (!ctx) return;
    const collected   = fees.total_collected || 0;
    const outstanding = fees.total_arrears   || 0;

    if (_feeChart) { _feeChart.destroy(); _feeChart = null; }
    _feeChart = new Chart(ctx.getContext('2d'), {
        type: 'doughnut',
        data: {
            labels: ['Collected', 'Outstanding'],
            datasets: [{
                data: [collected, outstanding],
                backgroundColor: ['#059669', '#dc2626'],
                borderWidth: 0
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { position: 'bottom', labels: { padding: 20 } },
                tooltip: { callbacks: { label: ctx => '  ' + fmtFull(ctx.parsed) } }
            },
            cutout: '65%'
        }
    });
}

// ── Grade bar chart ──────────────────────────────────────────
function updateGradeChart(byGrade) {
    const ctx = document.getElementById('gradeChart');
    if (!ctx) return;

    // Sort grades naturally
    const sorted = [...byGrade].sort((a, b) => (a.grade || '').localeCompare(b.grade || '', undefined, { numeric: true }));
    const labels = sorted.map(g => (g.grade || '?').replace(/grade\s*/i, 'G'));
    const data   = sorted.map(g => g.count || 0);

    if (_gradeChart) { _gradeChart.destroy(); _gradeChart = null; }
    _gradeChart = new Chart(ctx.getContext('2d'), {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                label: 'Students',
                data,
                backgroundColor: '#065f46',
                borderRadius: 6
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: '#e2e8f0' } },
                x: { grid: { display: false } }
            }
        }
    });
}

// ── Weekly attendance trend chart ────────────────────────────
function updateAttendanceChart(attRecords) {
    const ctx = document.getElementById('attendanceChart');
    if (!ctx) return;

    // Group individual attendance records by date
    const byDate = {};
    attRecords.forEach(r => {
        if (!r.date) return;
        if (!byDate[r.date]) byDate[r.date] = { present: 0, total: 0 };
        byDate[r.date].total++;
        if ((r.status || '').toLowerCase() === 'present') byDate[r.date].present++;
    });

    const dates  = Object.keys(byDate).sort().slice(-7);
    const labels = dates.map(d => new Date(d).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit' }));
    const data   = dates.map(d => {
        const { present, total } = byDate[d];
        return total > 0 ? parseFloat(((present / total) * 100).toFixed(1)) : 0;
    });

    if (_attChart) { _attChart.destroy(); _attChart = null; }
    _attChart = new Chart(ctx.getContext('2d'), {
        type: 'line',
        data: {
            labels: labels.length ? labels : ['No data'],
            datasets: [{
                label: 'Attendance Rate',
                data: data.length ? data : [0],
                borderColor: '#7c3aed',
                backgroundColor: 'rgba(124,58,237,0.15)',
                tension: 0.4, fill: true, borderWidth: 3, pointRadius: 4
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                y: {
                    min: 0, max: 100,
                    ticks: { callback: v => v + '%', stepSize: 20 },
                    grid: { color: '#e2e8f0' }
                },
                x: { grid: { display: false } }
            }
        }
    });
}

// ── Recent activity feed ─────────────────────────────────────
// Uses data already embedded in the /api/dashboard response — no extra calls needed
function updateActivity(recentPayments, recentStudents, recentGrades) {
    const list = document.getElementById('activityList');
    if (!list) return;

    const events = [];

    // Payments from dashboard recent_payments (already joined with student name)
    (recentPayments || []).forEach(p => {
        events.push({
            type:  'payment',
            icon:  'fas fa-money-bill',
            title: 'Fee Payment Received',
            desc:  (p.fullName || 'Student') + ' — ' + fmtFull(p.amount),
            time:  p.created_at
        });
    });

    // Recently registered students from dashboard recent_students
    (recentStudents || []).forEach(s => {
        events.push({
            type:  'student',
            icon:  'fas fa-user-plus',
            title: 'New Student Registered',
            desc:  (s.fullName || '—') + (s.studentClass ? ' — ' + s.studentClass : ''),
            time:  s.createdAt
        });
    });

    // Recent grades posted (from separate fetch)
    (recentGrades || []).forEach(g => {
        events.push({
            type:  'grade',
            icon:  'fas fa-clipboard-list',
            title: 'Grade Posted',
            desc:  (g.subject || 'Subject') + (g.student_name ? ' — ' + g.student_name : '') +
                   (g.student_class ? ' (' + g.student_class + ')' : ''),
            time:  g.created_at
        });
    });

    // Merge and sort newest-first
    events.sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0));

    if (!events.length) {
        list.innerHTML = '<div style="padding:1.5rem;text-align:center;color:#9ca3af;">No recent activity found</div>';
        return;
    }

    const iconClass = { payment: 'payment', student: 'student', grade: 'student' };
    list.innerHTML = events.slice(0, 6).map(ev =>
        `<div class="activity-item">
            <div class="activity-icon ${iconClass[ev.type] || 'student'}">
                <i class="${ev.icon}"></i>
            </div>
            <div class="activity-details">
                <h4>${ev.title}</h4>
                <p>${ev.desc}</p>
            </div>
            <div class="activity-time">${timeAgo(ev.time)}</div>
        </div>`
    ).join('');
}

// ── Upcoming events from announcements ───────────────────────
function updateEvents(announcements) {
    const list = document.getElementById('eventList');
    if (!list) return;

    // Use the most recent announcements as "events"
    const items = (announcements || []).slice(0, 4);

    if (!items.length) {
        list.innerHTML = '<div style="padding:1.5rem;text-align:center;color:#9ca3af;">' +
            '<i class="fas fa-calendar" style="font-size:1.5rem;display:block;margin-bottom:.5rem;color:#d1fae5;"></i>' +
            'No upcoming announcements</div>';
        return;
    }

    list.innerHTML = items.map(ann => {
        const d      = ann.created_at ? new Date(ann.created_at) : new Date();
        const day    = d.getDate().toString().padStart(2, '0');
        const month  = d.toLocaleDateString('en-GB', { month: 'short' }).toUpperCase();
        const role   = (ann.author_role || 'Admin').toLowerCase();
        const badge  = role.includes('teacher') ? 'meeting'
                     : ann.priority === 'high' || ann.priority === 'urgent' ? 'exam'
                     : 'meeting';
        const label  = ann.priority === 'high' ? 'Urgent'
                     : ann.priority === 'urgent' ? 'Urgent'
                     : (ann.audience && ann.audience !== 'all') ? ann.audience : 'Notice';
        return `<div class="event-item">
            <div class="event-date">
                <div class="day">${day}</div>
                <div class="month">${month}</div>
            </div>
            <div class="event-info">
                <h4>${ann.title || 'Announcement'}</h4>
                <p>${ann.author || 'Admin'} · ${ann.author_role || ''}</p>
                <span class="event-badge ${badge}">${label}</span>
            </div>
        </div>`;
    }).join('');
}

// ── Alerts from real data ────────────────────────────────────
function updateAlerts(dash, attSummary) {
    const list = document.getElementById('alertList');
    if (!list) return;

    const alerts    = [];
    const noPayment = dash.fees?.students_no_payment || 0;
    const arrears   = dash.fees?.total_arrears       || 0;
    const annCount  = dash.announcements             || 0;

    if (noPayment > 0) {
        alerts.push({
            cls:   'danger',
            icon:  'fas fa-exclamation-circle',
            title: 'Outstanding Fees Alert',
            body:  noPayment + ' student' + (noPayment !== 1 ? 's' : '') +
                   ' have made no payment this term — ' + fmtKes(arrears) + ' owed'
        });
    }

    // Low attendance classes today (below 75%)
    const lowAtt = (attSummary || []).filter(c => c.attendance_rate < 75);
    if (lowAtt.length) {
        alerts.push({
            cls:   'warning',
            icon:  'fas fa-user-clock',
            title: 'Low Attendance Today',
            body:  lowAtt.map(c => (c.class || 'Class') + ' (' + c.attendance_rate + '%)').join(', ')
        });
    }

    if (annCount > 0) {
        alerts.push({
            cls:   'info',
            icon:  'fas fa-bullhorn',
            title: annCount + ' Announcement' + (annCount !== 1 ? 's' : '') + ' Active',
            body:  'Check the announcements board for the latest notices'
        });
    }

    if (!alerts.length) {
        alerts.push({
            cls: 'info', icon: 'fas fa-check-circle',
            title: 'All Clear',
            body:  'No critical alerts at this time'
        });
    }

    list.innerHTML = alerts.map(a =>
        `<div class="alert-item ${a.cls}">
            <i class="${a.icon}"></i>
            <div class="alert-content">
                <h4>${a.title}</h4>
                <p>${a.body}</p>
            </div>
        </div>`
    ).join('');
}

// ── Last synced stamp ────────────────────────────────────────
function stampSync() {
    const el = document.getElementById('lastSync');
    if (el) el.textContent = 'Updated: ' + new Date().toLocaleTimeString('en-GB');
}

// ── Main load — all data from DB ─────────────────────────────
async function loadDashboard() {
    setSyncState(true);
    try {
        const today   = new Date().toISOString().slice(0, 10);
        const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

        // Fire all requests in parallel for speed
        const [
            dashRes,
            attTodayRes,
            attRecentRes,
            gradesRes,
            announcementsRes
        ] = await Promise.all([
            fetch(API_BASE_URL + '/api/dashboard'),
            fetch(API_BASE_URL + '/api/attendance/summary?date=' + today),
            fetch(API_BASE_URL + '/api/attendance?date_from=' + sevenDaysAgo + '&date_to=' + today),
            fetch(API_BASE_URL + '/api/grades?limit=5'),
            fetch(API_BASE_URL + '/api/announcements')
        ]);

        if (!dashRes.ok) throw new Error('Dashboard API returned ' + dashRes.status);

        const dash          = await dashRes.json();
        const attToday      = attTodayRes.ok      ? await attTodayRes.json()      : [];
        const attRecent     = attRecentRes.ok     ? await attRecentRes.json()     : [];
        const grades        = gradesRes.ok        ? await gradesRes.json()        : [];
        const announcements = announcementsRes.ok ? await announcementsRes.json() : [];

        // dashboard endpoint already has recent_payments and recent_students
        const recentPayments = dash.recent_payments || [];
        const recentStudents = dash.recent_students || [];
        const recentGrades   = grades.slice(0, 5);

        // Update every section
        updateStatCards(dash, attToday);
        updateEnrollmentChart(dash.students?.by_grade || []);
        updateFeeChart(dash.fees || {});
        updateGradeChart(dash.students?.by_grade || []);
        updateAttendanceChart(attRecent);
        updateActivity(recentPayments, recentStudents, recentGrades);
        updateAlerts(dash, attToday);
        updateEvents(announcements);
        stampSync();

        showToast('Dashboard data loaded from database');
    } catch (err) {
        console.error('Dashboard load failed:', err);
        showToast('Failed to load: ' + err.message, true);
    } finally {
        setSyncState(false);
    }
}

// ── Boot ─────────────────────────────────────────────────────
window.addEventListener('load', () => {
    loadUserInfo();
    loadDashboard();
});
