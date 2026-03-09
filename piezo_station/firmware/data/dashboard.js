// ========================
// GLOBAL VARIABLES
// ========================
let activeSlotId = null;
let localLogs = [];
let chartInstance = null;
let peakVoltageSession = 0.0;
let sessionStartTime = Date.now();

// SYSTEM FLAGS
let isSystemBusy = false;
let adminClicks = 0;
let adminTimer = null;
let fetchInProgress = false;

// Slot state cache to prevent race conditions
let slotStateCache = {
    1: { occupied: false, lastUpdate: 0 },
    2: { occupied: false, lastUpdate: 0 },
    3: { occupied: false, lastUpdate: 0 }
};

// ========================
// INITIALIZATION
// ========================
document.addEventListener('DOMContentLoaded', () => {
    console.log('PiezoStation Dashboard Loading...');
    
    // 1. Load stored logs from localStorage
    try {
        const stored = localStorage.getItem('piezo_logs');
        if (stored) {
            localLogs = JSON.parse(stored);
            console.log(`Loaded ${localLogs.length} log entries`);
        }
    } catch(e) {
        console.warn('Failed to load logs:', e);
        localLogs = [];
    }
    
    // 2. Theme Init
    if (localStorage.getItem('theme') === 'dark') {
        document.body.classList.add('dark-mode');
    }
    
    // 3. Chart Init
    initChart();

    // 4. Event Listeners
    initEventListeners();

    // 5. Initial data fetch
    fetchData();
    
    // 6. Start Loops
    setInterval(fetchData, 2000);
    setInterval(updateUptime, 1000);
    
    console.log('Dashboard initialized successfully');
});

function initChart() {
    const ctx = document.getElementById('energyChart');
    if (!ctx) return;
    
    chartInstance = new Chart(ctx.getContext('2d'), {
        type: 'line',
        data: { 
            labels: [], 
            datasets: [
                { 
                    label: 'Voltage (V)', 
                    borderColor: '#4CAF50', 
                    backgroundColor: 'rgba(76,175,80,0.1)', 
                    fill: true, 
                    data: [], 
                    yAxisID: 'yV',
                    tension: 0.4
                },
                { 
                    label: 'Energy (J)', 
                    borderColor: '#3f51b5', 
                    backgroundColor: 'rgba(63,81,181,0.1)', 
                    fill: true, 
                    data: [], 
                    yAxisID: 'yA',
                    tension: 0.4
                }
            ]
        },
        options: {
            responsive: true, 
            maintainAspectRatio: false,
            scales: {
                yV: { 
                    position: 'left', 
                    title: {display: true, text: 'Volts'},
                    beginAtZero: false
                },
                yA: { 
                    position: 'right', 
                    title: {display: true, text: 'Joules'},
                    beginAtZero: true,
                    grid: { drawOnChartArea: false }
                }
            },
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: true, position: 'top' }
            }
        }
    });
}

function initEventListeners() {
    // Theme Toggle
    document.getElementById('theme-toggle')?.addEventListener('click', () => {
        document.body.classList.toggle('dark-mode');
        localStorage.setItem('theme', document.body.classList.contains('dark-mode') ? 'dark' : 'light');
    });

    // Admin Trigger (Logo) - 5 taps in 2 seconds
    const logo = document.getElementById('admin-trigger');
    if(logo) {
        logo.addEventListener('click', () => {
            adminClicks++;
            logo.style.opacity = '0.5';
            setTimeout(() => logo.style.opacity = '1', 100);

            if (adminTimer) clearTimeout(adminTimer);
            adminTimer = setTimeout(() => { adminClicks = 0; }, 2000);

            if (adminClicks === 5) {
                adminClicks = 0;
                document.getElementById('adm-user').value = '';
                document.getElementById('adm-pass').value = '';
                document.getElementById('adminLoginError').textContent = '';
                openModal('modal-login');
            }
        });
    }

    // Modal Close Buttons
    document.querySelectorAll('.close-btn').forEach(btn => 
        btn.addEventListener('click', closeModals)
    );
    
    // Close modals on overlay click
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                closeModals();
            }
        });
    });
    
    // Admin Actions
    document.getElementById('adminLoginBtn')?.addEventListener('click', submitAdminLogin);
    document.getElementById('adminUnlockBtn')?.addEventListener('click', adminUnlock);
    document.getElementById('adminResetBtn')?.addEventListener('click', adminReset);
    document.getElementById('downloadCSVBtn')?.addEventListener('click', downloadCSV);
    document.getElementById('clearLogsBtn')?.addEventListener('click', clearLogs);

    // User Actions
    document.getElementById('confirmCodeBtn')?.addEventListener('click', confirmLock);
    document.getElementById('unlockBtn')?.addEventListener('click', submitUnlock);
    
    // Slot Clicks
    document.querySelectorAll('.slot').forEach(el => {
        el.addEventListener('click', () => {
            const slotId = el.dataset.slot;
            handleSlotClick(slotId);
        });
    });

    // Team Card Expansion
    document.querySelectorAll('.team-card').forEach(card => {
        card.addEventListener('click', () => card.classList.toggle('expanded'));
    });
    
    // Enter key support for inputs
    document.getElementById('input-code')?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') submitUnlock();
    });
    
    document.getElementById('adm-pass')?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') submitAdminLogin();
    });
}

// ========================
// UI UPDATER (Race-condition safe)
// ========================
function setSlotState(id, isOccupied, forceUpdate = false) {
    const el = document.getElementById('slot-' + id);
    if (!el) {
        console.error(`Slot element not found: slot-${id}`);
        return;
    }
    
    const now = Date.now();
    const cache = slotStateCache[id];
    
    // Only update if forced OR if state actually changed AND enough time passed
    if (!forceUpdate && cache.occupied === isOccupied && (now - cache.lastUpdate) < 500) {
        return;
    }
    
    // Update cache
    slotStateCache[id].occupied = isOccupied;
    slotStateCache[id].lastUpdate = now;
    
    // Update UI
    if (isOccupied) {
        el.classList.remove('vacant');
        el.classList.add('occupied');
    } else {
        el.classList.remove('occupied');
        el.classList.add('vacant');
    }

    const desc = el.querySelector('.slot-desc');
    if (desc) {
        desc.textContent = isOccupied ? 'Charging' : 'Available';
    }
    
    console.log(`Slot ${id} state updated: ${isOccupied ? 'OCCUPIED' : 'VACANT'}`);
}

// ========================
// DATA FETCHING
// ========================
async function fetchData() {
    // Prevent concurrent fetches
    if (fetchInProgress) return;
    
    fetchInProgress = true;
    
    try {
        const res = await fetch('/getData', {
            method: 'GET',
            headers: { 'Cache-Control': 'no-cache' }
        });
        
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }
        
        const data = await res.json();

        const volt = parseFloat(data.voltage || 0);
        const joules = parseFloat(data.harvestedEnergy || 0);
        const amps = parseFloat(data.current || 0);

        // Update Dashboard Cards
        updateElement('home-joules', joules.toFixed(2) + ' J');
        updateElement('home-volt', volt.toFixed(2) + ' V');
        updateElement('home-current', amps.toFixed(3) + ' A');

        // Update Stats Tab
        updateElement('sc-voltage-stat', volt.toFixed(2));
        updateElement('total-joules', joules.toFixed(2));
        
        if (volt > peakVoltageSession) {
            peakVoltageSession = volt;
            updateElement('peak-voltage', peakVoltageSession.toFixed(2));
        }

        // Update Harvest Status
        const st = document.getElementById('harvest-status');
        if(st) {
            if(volt > 12.0) { 
                st.textContent = "OPTIMAL"; 
                st.style.color = "var(--green)"; 
            } else if(volt > 0.5) { 
                st.textContent = "ACTIVE"; 
                st.style.color = "var(--primary)"; 
            } else { 
                st.textContent = "IDLE"; 
                st.style.color = "var(--muted)"; 
            }
        }

        // Update Chart
        updateChart(volt, joules);

        // Store Logs
        localLogs.push({ 
            time: new Date().toLocaleString(), 
            v: volt.toFixed(2), 
            j: joules.toFixed(2) 
        });
        if(localLogs.length > 1000) localLogs.shift();
        
        try {
            localStorage.setItem('piezo_logs', JSON.stringify(localLogs));
        } catch(e) {
            console.warn('localStorage full, clearing old logs');
            localLogs = localLogs.slice(-500);
            localStorage.setItem('piezo_logs', JSON.stringify(localLogs));
        }

        // Update Slots ONLY if no active user interaction
        if (data.slots && !activeSlotId && !isSystemBusy) {
            [1, 2, 3].forEach(id => {
                const sData = data.slots[id];
                if (sData) {
                    const isOcc = sData.occupied === true || 
                                  sData.occupied === "true" || 
                                  sData.occupied === 1;
                    setSlotState(id, isOcc);
                }
            });
        }

        // Reset error indicator
        const liveIndicator = document.querySelector('.live-indicator');
        if (liveIndicator) {
            liveIndicator.style.background = 'var(--green)';
            liveIndicator.style.boxShadow = '0 0 8px var(--green)';
        }

    } catch (e) { 
        console.error("Data Fetch Error:", e);
        
        // Show error indicator
        const liveIndicator = document.querySelector('.live-indicator');
        if (liveIndicator) {
            liveIndicator.style.background = 'var(--red)';
            liveIndicator.style.boxShadow = '0 0 8px var(--red)';
        }
    } finally {
        fetchInProgress = false;
    }
}

function updateElement(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

function updateChart(volt, joules) {
    if (!chartInstance) return;
    
    const now = new Date().toLocaleTimeString();
    const maxPoints = 15;
    
    if (chartInstance.data.labels.length >= maxPoints) {
        chartInstance.data.labels.shift(); 
        chartInstance.data.datasets[0].data.shift(); 
        chartInstance.data.datasets[1].data.shift();
    }
    
    chartInstance.data.labels.push(now);
    chartInstance.data.datasets[0].data.push(volt);
    chartInstance.data.datasets[1].data.push(joules);
    chartInstance.update('none');
}

function updateUptime() {
    const diff = Math.floor((Date.now() - sessionStartTime) / 1000);
    const h = Math.floor(diff / 3600).toString().padStart(2, '0');
    const m = Math.floor((diff % 3600) / 60).toString().padStart(2, '0');
    const s = (diff % 60).toString().padStart(2, '0');
    updateElement('home-uptime', `${h}:${m}:${s}`);
}

// ========================
// USER INTERACTIONS
// ========================
window.handleSlotClick = async (id) => {
    if (isSystemBusy) {
        showToast('⏳ System is busy, please wait...', 'warning');
        return;
    }

    const slotId = parseInt(id);
    activeSlotId = slotId;
    const el = document.getElementById('slot-' + slotId);

    if (el.classList.contains('occupied')) {
        // Already Locked → Show Unlock Modal
        document.getElementById('input-code').value = '';
        document.getElementById('errorCode').textContent = '';
        openModal('modal-unlock');
    } else {
        // Available → Request Lock Code
        isSystemBusy = true;
        
        try {
            const res = await fetch(`/requestLock?slot=${slotId}`, {
                method: 'GET',
                headers: { 'Cache-Control': 'no-cache' }
            });
            
            const d = await res.json();
            
            if(d.success) {
                setSlotState(slotId, true, true); // Force update to occupied
                document.getElementById('disp-code').textContent = d.code;
                openModal('modal-code');
                console.log(`Slot ${slotId} reserved with code: ${d.code}`);
            } else {
                showToast('❌ ' + (d.error || 'Slot unavailable'), 'error');
                activeSlotId = null;
                fetchData(); // Refresh from server
            }
        } catch(e) {
            showToast('❌ Connection Failed. Check ESP32.', 'error');
            console.error('Request lock error:', e);
            activeSlotId = null;
        } finally {
            isSystemBusy = false;
        }
    }
};

async function confirmLock() {
    if (!activeSlotId) {
        console.error('No active slot ID');
        return;
    }
    
    closeModals();
    
    // Lock UI during motor operation
    isSystemBusy = true;
    showToast('🔒 Closing slot door...', 'info');
    
    const timeoutId = setTimeout(() => { 
        isSystemBusy = false; 
        activeSlotId = null;
    }, 4000);

    try {
        const res = await fetch(`/confirmLock?slot=${activeSlotId}`, {
            method: 'GET',
            headers: { 'Cache-Control': 'no-cache' }
        });
        
        const data = await res.json();
        
        if (data.success) {
            setSlotState(activeSlotId, true, true);
            showToast('✅ Slot secured! Your device is charging.', 'success');
            console.log(`Slot ${activeSlotId} locked successfully`);
        } else {
            showToast('❌ Failed to lock slot', 'error');
        }
    } catch(e) {
        console.error("Confirm lock failed:", e);
        showToast('❌ Failed to confirm lock', 'error');
    } finally {
        clearTimeout(timeoutId);
        setTimeout(() => {
            isSystemBusy = false;
            activeSlotId = null;
        }, 1000);
    }
}

async function submitUnlock() {
    const code = document.getElementById('input-code').value.trim();
    const err = document.getElementById('errorCode');
    
    if (!code || code.length !== 4) {
        err.textContent = 'Please enter a 4-digit code';
        return;
    }
    
    if (!activeSlotId) {
        err.textContent = 'Invalid session. Please try again.';
        return;
    }
    
    isSystemBusy = true;
    err.textContent = ''; // Clear previous errors
    
    try {
        const res = await fetch(`/unlockSlot?slot=${activeSlotId}&code=${code}`, {
            method: 'GET',
            headers: { 'Cache-Control': 'no-cache' }
        });
        
        const data = await res.json();
        
        if (data.success) {
            setSlotState(activeSlotId, false, true);
            closeModals();
            showToast('✅ Slot unlocked! Please retrieve your device.', 'success');
            console.log(`Slot ${activeSlotId} unlocked successfully`);
            
            setTimeout(() => { 
                isSystemBusy = false; 
                activeSlotId = null; 
            }, 3000);
        } else {
            err.textContent = data.error || 'Invalid Code. Please try again.';
            isSystemBusy = false;
        }
    } catch(e) {
        err.textContent = 'Network Error. Check connection.';
        console.error('Unlock error:', e);
        isSystemBusy = false;
    }
}

// ========================
// ADMIN FUNCTIONS
// ========================
async function submitAdminLogin() {
    const u = document.getElementById('adm-user').value.trim();
    const p = document.getElementById('adm-pass').value;
    const errEl = document.getElementById('adminLoginError');
    
    if (!u || !p) {
        errEl.textContent = 'Please fill in all fields';
        return;
    }
    
    // Check credentials
    if (u === 'admin' && p === 'piezo2026') {
        closeModals();
        openModal('modal-admin');
        showToast('🔓 Admin access granted', 'success');
    } else {
        errEl.textContent = 'Invalid Credentials';
    }
}

async function adminUnlock() {
    const id = parseInt(document.getElementById('adm-slot').value);
    
    if(!id || id < 1 || id > 3) {
        showToast("⚠️ Enter a valid Slot # (1-3)", 'warning');
        return;
    }
    
    if (isSystemBusy) {
        showToast('⏳ System is busy, please wait...', 'warning');
        return;
    }
    
    if (!confirm(`Force unlock Slot ${id}?\n\nThis will clear the code and open the door.`)) {
        return;
    }
    
    isSystemBusy = true;
    setSlotState(id, false, true);
    
    const timeoutId = setTimeout(() => { isSystemBusy = false; }, 4000);
    
    try {
        const res = await fetch(`/adminUnlock?slot=${id}&key=PZSTAT001`, {
            method: 'GET',
            headers: { 'Cache-Control': 'no-cache' }
        });
        
        const data = await res.json();
        
        if (data.success) {
            showToast(`✅ Slot ${id} unlocked by admin`, 'success');
        } else {
            showToast('❌ Failed to unlock slot', 'error');
        }
    } catch(e) {
        showToast('❌ Connection error', 'error');
        console.error('Admin unlock error:', e);
    } finally {
        clearTimeout(timeoutId);
        isSystemBusy = false;
    }
}

async function adminReset() {
    if (!confirm('⚠️ RESET ALL SLOTS?\n\nThis will:\n• Unlock all slots\n• Clear all codes\n• Open all doors\n\nContinue?')) {
        return;
    }
    
    if (isSystemBusy) {
        showToast('⏳ System is busy, please wait...', 'warning');
        return;
    }
    
    [1, 2, 3].forEach(id => setSlotState(id, false, true));
    
    isSystemBusy = true;
    showToast('🔄 Resetting all slots...', 'info');
    
    const timeoutId = setTimeout(() => { isSystemBusy = false; }, 6000);
    
    try {
        const res = await fetch(`/adminReset?key=PZSTAT001`, {
            method: 'GET',
            headers: { 'Cache-Control': 'no-cache' }
        });
        
        const data = await res.json();
        
        if (data.success) {
            showToast('✅ System Reset Complete - All slots available', 'success');
            closeModals();
        } else {
            showToast('❌ Reset failed', 'error');
        }
    } catch(e) {
        showToast('❌ Reset failed. Check connection.', 'error');
        console.error('Admin reset error:', e);
    } finally {
        clearTimeout(timeoutId);
        setTimeout(() => { isSystemBusy = false; }, 1000);
    }
}

function downloadCSV() {
    if (!localLogs.length) {
        showToast("⚠️ No data available to export", 'warning');
        return;
    }
    
    // Get date filter value
    const dateFilter = document.getElementById('log-date-filter')?.value;
    let filteredLogs = localLogs;
    
    // Filter by date if specified
    if (dateFilter) {
        filteredLogs = localLogs.filter(log => {
            // Extract date from log.time (format: "MM/DD/YYYY, HH:MM:SS AM/PM")
            const logDate = new Date(log.time).toISOString().split('T')[0];
            return logDate === dateFilter;
        });
        
        if (filteredLogs.length === 0) {
            showToast(`⚠️ No logs found for ${dateFilter}`, 'warning');
            return;
        }
    }
    
    // Build CSV
    let csv = "Time,Voltage (V),Energy (J)\n";
    filteredLogs.forEach(r => csv += `${r.time},${r.v},${r.j}\n`);
    
    // Download
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const filename = dateFilter 
        ? `PiezoLog_${dateFilter}.csv` 
        : `PiezoLog_${new Date().toISOString().split('T')[0]}.csv`;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    
    const msg = dateFilter 
        ? `✅ Exported ${filteredLogs.length} logs for ${dateFilter}`
        : `✅ Exported all ${filteredLogs.length} logs`;
    showToast(msg, 'success');
}

function clearLogs() {
    if (confirm("Clear all session logs?\n\nThis cannot be undone.")) {
        localLogs = [];
        localStorage.removeItem('piezo_logs');
        showToast("✅ Logs cleared successfully", 'success');
    }
}

// ========================
// UTILS
// ========================
window.showTab = (id) => {
    document.querySelectorAll('.content-section').forEach(e => e.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(e => e.classList.remove('active'));
    
    const tab = document.getElementById('tab-' + id);
    if (tab) tab.classList.add('active');
    
    const btn = event.target.closest('.nav-btn');
    if (btn && !btn.id) btn.classList.add('active');
    
    if (id === 'stats' && chartInstance) {
        setTimeout(() => chartInstance.resize(), 100);
    }
};

function openModal(id) { 
    const m = document.getElementById(id);
    if(m) {
        m.classList.add('show');
        const firstInput = m.querySelector('input');
        if (firstInput) setTimeout(() => firstInput.focus(), 100);
    }
}

function closeModals() { 
    document.querySelectorAll('.modal-overlay').forEach(el => el.classList.remove('show')); 
    
    const clearInputs = ['adm-pass', 'input-code', 'adm-user', 'adm-slot'];
    clearInputs.forEach(id => {
        const el = document.getElementById(id);
        if(el) el.value = '';
    });
    
    document.querySelectorAll('.error-message').forEach(el => el.textContent = '');
    
    // Don't clear activeSlotId immediately - let the operations complete
}

function showToast(message, type = 'info') {
    // Remove existing toasts
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();
    
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    
    // Add toast styles if not already present
    if (!document.getElementById('toast-styles')) {
        const style = document.createElement('style');
        style.id = 'toast-styles';
        style.textContent = `
            .toast {
                position: fixed;
                bottom: 30px;
                right: 30px;
                background: var(--card);
                color: var(--text);
                padding: 15px 20px;
                border-radius: 8px;
                box-shadow: var(--shadow);
                border-left: 4px solid var(--primary);
                z-index: 9999;
                animation: slideIn 0.3s ease;
                max-width: 400px;
                font-weight: 500;
            }
            .toast-success { border-left-color: var(--green); }
            .toast-error { border-left-color: var(--red); }
            .toast-warning { border-left-color: #ff9800; }
            .toast-info { border-left-color: var(--primary); }
            @keyframes slideIn {
                from { transform: translateX(400px); opacity: 0; }
                to { transform: translateX(0); opacity: 1; }
            }
            @keyframes slideOut {
                from { transform: translateX(0); opacity: 1; }
                to { transform: translateX(400px); opacity: 0; }
            }
        `;
        document.head.appendChild(style);
    }
    
    document.body.appendChild(toast);
    
    setTimeout(() => {
        toast.style.animation = 'slideOut 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// Prevent accidental navigation away
window.addEventListener('beforeunload', (e) => {
    if (isSystemBusy) {
        e.preventDefault();
        e.returnValue = 'A slot operation is in progress. Are you sure you want to leave?';
        return e.returnValue;
    }
});