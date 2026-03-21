const API_BASE_URL = 'https://emalashira-primary-school.onrender.com';

// ── Cached data ────────────────────────────────────────────
let _allPayments  = [];
let _feesSummary  = [];
let _activeTab    = 'all';
let _finChart     = null;
let _expChart     = null;

// ── Core helpers ───────────────────────────────────────────
function logout() {
    sessionStorage.removeItem('currentUser');
    window.location.href = 'login.html';
}

function loadUserInfo() {
    const userData = sessionStorage.getItem('currentUser');
    if (!userData) { logout(); return; }
    try {
        const user = JSON.parse(userData);
        const nameEl = document.getElementById('userNameDisplay');
        const roleEl = document.getElementById('roleBadge');
        if (nameEl) nameEl.textContent = user.fullName || user.email || 'User';
        if (roleEl) roleEl.textContent  = user.role    || 'User';
    } catch (err) { logout(); }
}

function fmt(n) {
    return 'Ksh ' + Number(n || 0).toLocaleString('en-KE', { minimumFractionDigits: 0 });
}

function fmtDate(d) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ── Toast ──────────────────────────────────────────────────
function showToast(msg, isError = false) {
    let t = document.getElementById('finToast');
    if (!t) {
        t = document.createElement('div');
        t.id = 'finToast';
        t.style.cssText = 'position:fixed;bottom:24px;right:24px;padding:12px 20px;border-radius:8px;' +
            'font-size:.92rem;z-index:9999;color:#fff;box-shadow:0 4px 16px rgba(0,0,0,.2);' +
            'transition:opacity .35s;pointer-events:none;';
        document.body.appendChild(t);
    }
    t.style.background = isError ? '#dc2626' : '#065f46';
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(t._timer);
    t._timer = setTimeout(() => { t.style.opacity = '0'; }, 3500);
}

// ── Sync button state ──────────────────────────────────────
function setSyncState(loading) {
    const btn  = document.getElementById('syncDbBtn');
    const icon = document.getElementById('syncIcon');
    const text = document.getElementById('syncText');
    if (!btn) return;
    btn.disabled = loading;
    if (icon) icon.className = loading ? 'fas fa-spinner fa-spin' : 'fas fa-sync-alt';
    if (text) text.textContent = loading ? 'Syncing...' : 'Sync from DB';
}

// ── Summary cards ──────────────────────────────────────────
function updateSummaryCards(data) {
    const collected  = data.fees?.total_collected    || 0;
    const arrears    = data.fees?.total_arrears       || 0;
    const billed     = data.fees?.total_billed        || 0;
    const paidCount  = data.fees?.students_paid       || 0;
    const noPay      = data.fees?.students_no_payment || 0;
    const rate       = data.fees?.collection_rate     || 0;
    const net        = collected - arrears;

    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };

    set('cardTotalIncome',   fmt(collected));
    set('cardTotalExpenses', fmt(arrears));
    set('cardNetProfit',     fmt(Math.max(0, net)));
    set('cardPendingFees',   fmt(arrears));

    set('cardIncomeChange',   rate.toFixed(1) + '% collection rate');
    set('cardExpensesChange', noPay + ' student' + (noPay !== 1 ? 's' : '') + ' with no payment');
    set('cardProfitChange',   paidCount + ' student' + (paidCount !== 1 ? 's' : '') + ' paid in full');
    set('cardPendingChange',  ((data.students?.total || 0) - paidCount) + ' students outstanding');
}

// ── Transactions table ─────────────────────────────────────
function renderTransactions(payments, tab) {
    const tbody = document.querySelector('#transactionsTable tbody');
    if (!tbody) return;

    let rows = [...payments];
    if (tab === 'fees')    rows = rows.filter(p => (p.status||'').toLowerCase() === 'completed');
    if (tab === 'pending') rows = rows.filter(p => (p.status||'').toLowerCase() === 'pending');
    if (tab === 'overdue') rows = rows.filter(p => (p.status||'').toLowerCase() === 'overdue');

    if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:2rem;color:#9ca3af;">' +
            '<i class="fas fa-receipt" style="font-size:1.8rem;display:block;margin-bottom:.5rem;"></i>' +
            'No transactions found for this filter.</td></tr>';
        return;
    }

    tbody.innerHTML = rows.slice(0, 50).map(function(p) {
        var status   = (p.status || 'completed').toLowerCase();
        var badgeCls = status === 'completed' ? 'status-paid'
                     : status === 'pending'   ? 'status-pending'
                     : status === 'overdue'   ? 'status-overdue' : 'status-paid';
        var label    = status === 'completed' ? 'Paid'
                     : status.charAt(0).toUpperCase() + status.slice(1);
        var student  = p.fullName || p.studentName || '—';
        var cls      = p.studentClass ? ' – ' + p.studentClass : '';
        var desc     = p.term ? 'Term ' + p.term + ' Fee' + cls : 'Fee Payment';
        var amount   = fmt(p.amount || 0);
        var actionBtn = status === 'completed'
            ? '<button class="btn btn-outline btn-sm" onclick="viewReceipt(\'' + p.id + '\')">View</button>'
            : status === 'pending'
            ? '<button class="btn btn-outline btn-sm" onclick="sendReminder(\'' + p.id + '\')">Remind</button>'
            : '<button class="btn btn-primary btn-sm" onclick="collectPayment(\'' + p.id + '\')">Collect</button>';

        return '<tr>' +
            '<td>' + fmtDate(p.created_at) + '</td>' +
            '<td>' + desc + '</td>' +
            '<td>' + student + '</td>' +
            '<td>Fee Payment</td>' +
            '<td>' + amount + '</td>' +
            '<td><span class="status ' + badgeCls + '">' + label + '</span></td>' +
            '<td>' + actionBtn + '</td>' +
        '</tr>';
    }).join('');
}

// ── Charts ─────────────────────────────────────────────────
function buildMonthlyData(payments) {
    var monthly = Array(12).fill(0);
    payments.forEach(function(p) {
        if (!p.created_at) return;
        var m = new Date(p.created_at).getMonth();
        monthly[m] += (p.amount || 0);
    });
    return monthly;
}

function updateCharts(payments, feesSummary) {
    var labels  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var income  = buildMonthlyData(payments.filter(function(p){ return p.status === 'completed'; }));
    var pending = buildMonthlyData(payments.filter(function(p){ return p.status !== 'completed'; }));

    var finCtx = document.getElementById('financialChart');
    if (finCtx) {
        if (_finChart) { _finChart.destroy(); _finChart = null; }
        _finChart = new Chart(finCtx.getContext('2d'), {
            type: 'line',
            data: {
                labels: labels,
                datasets: [
                    { label: 'Fees Collected', data: income,
                      borderColor: '#059669', backgroundColor: 'rgba(5,150,105,0.12)',
                      tension: 0.35, fill: true, borderWidth: 3 },
                    { label: 'Outstanding', data: pending,
                      borderColor: '#dc2626', backgroundColor: 'rgba(220,38,38,0.10)',
                      tension: 0.35, fill: true, borderWidth: 2 }
                ]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { position: 'top' } },
                scales: { y: { beginAtZero: true,
                    ticks: { callback: function(v){ return 'Ksh ' + (v/1000).toFixed(0) + 'k'; } } } }
            }
        });
    }

    // Pie: outstanding balance by fee status
    var expCtx = document.getElementById('expenseChart');
    if (expCtx) {
        if (_expChart) { _expChart.destroy(); _expChart = null; }
        var byStatus = { Paid: 0, Partial: 0, Pending: 0 };
        feesSummary.forEach(function(s) {
            var k = s.status === 'No Structure' ? 'Pending' : (s.status || 'Pending');
            if (k in byStatus) byStatus[k] += (s.balance || 0);
            else byStatus['Pending'] += (s.balance || 0);
        });
        var entries = Object.entries(byStatus).filter(function(e){ return e[1] > 0; });
        _expChart = new Chart(expCtx.getContext('2d'), {
            type: 'pie',
            data: {
                labels: entries.map(function(e){ return e[0]; }),
                datasets: [{ data: entries.map(function(e){ return e[1]; }),
                    backgroundColor: ['#059669','#f59e0b','#dc2626','#6b7280'], borderWidth: 1 }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'bottom', labels: { padding: 16 } },
                    tooltip: { callbacks: { label: function(ctx){ return ' Ksh ' + ctx.parsed.toLocaleString(); } } }
                }
            }
        });
    }
}

// ── Payment integrations ───────────────────────────────────
function updateIntegrations(payments) {
    function sum(arr) { return arr.reduce(function(s,p){ return s + (p.amount||0); }, 0); }
    var mpesa = payments.filter(function(p){ var m=(p.method||'').toLowerCase(); return m.includes('mpesa')||m.includes('m-pesa'); });
    var bank  = payments.filter(function(p){ return (p.method||'').toLowerCase().includes('bank'); });
    var cash  = payments.filter(function(p){ return (p.method||'').toLowerCase().includes('cash'); });
    var set = function(id,val){ var el=document.getElementById(id); if(el) el.textContent=val; };
    set('intMpesa', fmt(sum(mpesa)));
    set('intBank',  fmt(sum(bank)));
    set('intCash',  fmt(sum(cash)));
}

// ── Main sync ──────────────────────────────────────────────
async function syncFromDatabase() {
    setSyncState(true);
    try {
        const [dashRes, paymentsRes, feesRes] = await Promise.all([
            fetch(API_BASE_URL + '/api/dashboard'),
            fetch(API_BASE_URL + '/api/fees/payments/all'),
            fetch(API_BASE_URL + '/api/fees/all')
        ]);

        if (!dashRes.ok)     throw new Error('Dashboard API error ' + dashRes.status);
        if (!paymentsRes.ok) throw new Error('Payments API error ' + paymentsRes.status);

        const dashData    = await dashRes.json();
        const allPayments = paymentsRes.ok ? await paymentsRes.json() : [];
        const feesData    = feesRes.ok     ? await feesRes.json()     : { students: [] };

        _allPayments = allPayments;
        _feesSummary = feesData.students || [];

        updateSummaryCards(dashData);
        renderTransactions(_allPayments, _activeTab);
        updateCharts(_allPayments, _feesSummary);
        updateIntegrations(_allPayments);

        const stamp = document.getElementById('lastSyncTime');
        if (stamp) stamp.textContent = 'Last synced: ' + new Date().toLocaleTimeString('en-GB');

        showToast('Finance data synced from database');
    } catch (err) {
        console.error('Sync failed:', err);
        showToast('Sync failed: ' + err.message, true);
    } finally {
        setSyncState(false);
    }
}

// ── Tab switching ──────────────────────────────────────────
function switchTab(tabName, el) {
    _activeTab = tabName;
    document.querySelectorAll('.tab').forEach(function(t){ t.classList.remove('active'); });
    if (el) el.classList.add('active');
    renderTransactions(_allPayments, _activeTab);
}

// ── Placeholder handlers ───────────────────────────────────
function createInvoice()    { alert('Create Invoice - feature coming soon'); }
function exportReport()     { alert('Exporting report...'); }
function logExpense()       { alert('Log new expense'); }
function generateReport()   { alert('Generating financial report'); }
function viewTax()          { alert('Opening tax calculator'); }
function setBudget()        { alert('Budget settings'); }
function connectGateway()   { alert('Configuring payment gateway'); }
function viewReceipt(id)    { alert('Viewing receipt #' + id); }
function sendReminder(id)   { alert('Sending reminder for #' + id); }
function collectPayment(id) { alert('Collecting payment #' + id); }

// ── Charts init (empty placeholder until first sync) ───────
function initFinanceCharts() {
    function getCtx(id) { var c=document.getElementById(id); return c ? c.getContext('2d') : null; }
    var finCtx = getCtx('financialChart');
    if (finCtx && !_finChart) {
        _finChart = new Chart(finCtx, {
            type: 'line',
            data: { labels: ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'],
                datasets: [
                    { label: 'Fees Collected', data: Array(12).fill(0), borderColor: '#059669', backgroundColor: 'rgba(5,150,105,0.12)', tension: 0.35, fill: true, borderWidth: 3 },
                    { label: 'Outstanding',    data: Array(12).fill(0), borderColor: '#dc2626', backgroundColor: 'rgba(220,38,38,0.10)', tension: 0.35, fill: true, borderWidth: 2 }
                ]
            },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'top' } }, scales: { y: { beginAtZero: true } } }
        });
    }
    var expCtx = getCtx('expenseChart');
    if (expCtx && !_expChart) {
        _expChart = new Chart(expCtx, {
            type: 'pie',
            data: { labels: ['Paid','Partial','Pending'], datasets: [{ data: [1,1,1], backgroundColor: ['#059669','#f59e0b','#dc2626'], borderWidth: 1 }] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { padding: 16 } } } }
        });
    }
}

// ── Boot ───────────────────────────────────────────────────
window.addEventListener('load', function() {
    loadUserInfo();
    initFinanceCharts();
    syncFromDatabase(); // auto-sync on page load
});
