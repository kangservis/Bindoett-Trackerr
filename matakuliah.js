// ==========================================================================
// KONFIGURASI FIREBASE SDK (Sesuai Kredensial Asli Milik Anda) [6]
// ==========================================================================
const firebaseConfig = {
    apiKey: "AIzaSyDr2afVRUsGP6SiTGAEB0Gwx7voHpVTeX4",
    authDomain: "bindoet-tracker.firebaseapp.com",
    projectId: "bindoet-tracker",
    storageBucket: "bindoet-tracker.firebasestorage.app",
    messagingSenderId: "105475447262",
    appId: "1:105475447262:web:70f79d2b387b5da09c654f",
    measurementId: "G-VC0S1KZS1H"
};

// STATE MANAGEMENT & DATA PERSISTENCE
let appData = [];
let currentSemesterId = null;
let currentCourseId = null;
let currentUser = null; 
let auth = null;        
let db = null;          // Instansi Firestore Database
let unsubscribeSnapshot = null; // Menyimpan fungsi penutup listener real-time
let isRegistering = false;      // Bendera penanda pendaftaran akun baru agar tidak otomatis masuk [10]
let activeSessionIdForStatus = null; // Menyimpan ID sesi yang statusnya sedang diubah

// KONFIGURASI DATABASE LOKAL (IndexedDB untuk Menyimpan File Asli PDF) [1, 2]
const DB_NAME = 'edutracker_db';
const DB_VERSION = 1;
const STORE_NAME = 'files';

function getDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };
        request.onsuccess = (e) => resolve(e.target.result);
        request.onerror = (e) => reject(e.target.error);
    });
}

async function saveFileToDB(key, fileBlob) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.put(fileBlob, key);
        request.onsuccess = () => resolve();
        request.onerror = (e) => reject(e.target.error);
    });
}

async function getFileFromDB(key) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.get(key);
        request.onsuccess = (e) => resolve(e.target.result);
        request.onerror = (e) => reject(e.target.error);
    });
}

async function deleteFileFromDB(key) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.delete(key);
        request.onsuccess = () => resolve();
        request.onerror = (e) => reject(e.target.error);
    });
}

// PENYELARAS STATUS LOGIN SECARA REAL-TIME
function listenAuthState() {
    if (!auth) return;
    auth.onAuthStateChanged((user) => {
        if (user) {
            // Mencegah masuk otomatis setelah sukses melakukan registrasi akun baru [10]
            if (isRegistering) {
                auth.signOut(); // Langsung paksa keluar [10]
                isRegistering = false;
                return;
            }
            currentUser = user;
            startRealtimeSync(user.uid); 
            navigateTo('dashboard-view'); 
            clearAuthInputs();            
        } else {
            currentUser = null;
            appData = [];
            if (unsubscribeSnapshot) unsubscribeSnapshot(); 
            navigateTo('welcome-view');
        }
    });
}

// INISIALISASI PERTAMA KALI (Sinkronisasi Event Popstate Navigator - Goal 1) [14, 15]
document.addEventListener("DOMContentLoaded", () => {
    setupKeyboardListeners(); 
    
    // Inisiasi awal stack history agar sistem gestur Android bekerja sinkron [14]
    history.replaceState({ viewId: 'welcome-view', currentSemesterId: null, currentCourseId: null }, '', '#welcome-view');
    navigateTo('welcome-view', false); // Jangan pushState lagi saat pertama dimuat
    
    initFirebase();
});

// EVENT POPSTATE: Interseptor Gestur "Kembali" Android/iOS agar SPA Mundur Sesuai Menu (Goal 1) [15]
window.addEventListener('popstate', (e) => {
    if (e.state && e.state.viewId) {
        currentSemesterId = e.state.currentSemesterId;
        currentCourseId = e.state.currentCourseId;
        navigateTo(e.state.viewId, false); // Navigasi mundur tanpa membuat stack history baru [15]
    } else {
        navigateTo('welcome-view', false);
    }
});

// INISIALISASI FIREBASE SECARA AMAN + OFFLINE & SESSION PERSISTENCE (Bebas Crash pada Firefox) [12]
function initFirebase() {
    try {
        if (typeof firebase !== 'undefined') {
            if (!firebase.apps.length) {
                firebase.initializeApp(firebaseConfig);
            }
            auth = firebase.auth();
            db = firebase.firestore();

            // Mengaktifkan fitur persistence secara aman dan terisolasi
            try {
                db.enablePersistence().catch((err) => {
                    console.warn("Firestore offline persistence gagal diaktifkan (Async):", err.code);
                });
            } catch (persistenceError) {
                console.warn("Browser memblokir inisialisasi offline persistence (Sync):", persistenceError.message);
            }

            // ATUR PERSISTENSI: Sesi hanya disimpan per-tab browser aktif saja (SESSION) [12]
            auth.setPersistence(firebase.auth.Auth.Persistence.SESSION)
                .then(() => {
                    listenAuthState(); // Jalankan listener login setelah konfigurasi tab disetujui [12]
                })
                .catch((err) => {
                    console.error("Gagal menetapkan persistensi sesi:", err);
                    listenAuthState();
                });
            
        } else {
            console.warn("Firebase SDK tidak terdeteksi. Berjalan dalam mode tamu offline.");
            loadDataOffline();
        }
    } catch (error) {
        console.error("Gagal menginisialisasi Firebase SDK:", error);
        loadDataOffline();
    }
}

// SISTEM SINKRONISASI CLOUD REAL-TIME (Saling mengupdate antar-device secara instan) [9]
function startRealtimeSync(uid) {
    if (unsubscribeSnapshot) unsubscribeSnapshot();

    const userDocRef = db.collection('users').doc(uid);

    unsubscribeSnapshot = userDocRef.onSnapshot((doc) => {
        if (doc.exists) {
            const data = doc.data();
            appData = data.semesters || [];
        } else {
            appData = [];
        }
        localStorage.setItem(`edutracker_data_${uid}`, JSON.stringify(appData));
        renderCurrentView();
    }, (error) => {
        console.error("Kesalahan sinkronisasi Firestore:", error);
        loadDataOffline();
    });
}

// PENGENDALIAN RENDERING SECARA DINAMIS (Bebas Bug Focus Stealing saat Mengetik Catatan)
function renderCurrentView() {
    const dashboardVisible = !document.getElementById('dashboard-view').classList.contains('hidden');
    const semesterVisible = !document.getElementById('semester-view').classList.contains('hidden');
    const trackerVisible = !document.getElementById('tracker-view').classList.contains('hidden');

    if (dashboardVisible) {
        renderDashboard();
    } else if (semesterVisible) {
        renderSemester();
    } else if (trackerVisible) {
        // PERBAIKAN BUG UTAMA: Jangan render ulang jika kursor pengguna sedang aktif mengetik di kolom catatan
        const isTyping = document.activeElement && document.activeElement.classList.contains('session-note-input');
        if (!isTyping) {
            renderTracker();
        }
    }
}

// FALLBACK METODE LOKAL JIKA OFFLINE
function loadDataOffline() {
    const uid = currentUser ? currentUser.uid : "guest";
    const savedData = localStorage.getItem(`edutracker_data_${uid}`);
    if (savedData) {
        appData = JSON.parse(savedData);
    } else {
        appData = [];
    }
    navigateTo('dashboard-view');
}

// SIMPAN DATA KE CLOUD DAN CADANGAN LOKAL SECARA BERSAMAAN
async function saveData() {
    if (!currentUser) return;
    
    // Cadangan lokal darurat
    localStorage.setItem(`edutracker_data_${currentUser.uid}`, JSON.stringify(appData));

    if (db) {
        try {
            await db.collection('users').doc(currentUser.uid).set({
                semesters: appData
            });
        } catch (error) {
            console.error("Gagal menyinkronkan data ke Cloud Firestore:", error);
        }
    }
}

// FUNGSI PEMBERSIH INPUT LOGIN & DAFTAR (Solusi Masalah 2)
function clearAuthInputs() {
    const ids = ['auth-email', 'auth-password', 'reg-email', 'reg-password'];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
}

// ALUR NAVIGASI SPA DENGAN SINKRONISASI STACK RIWAYAT BROWSER (Goal 1) [14]
function navigateTo(viewId, pushToHistory = true) {
    document.querySelectorAll('.view-section').forEach(view => {
        view.classList.add('hidden');
    });
    
    document.getElementById(viewId).classList.remove('hidden');

    // Catat perpindahan halaman di history stack browser agar tombol "Kembali" Android sinkron [14]
    if (pushToHistory) {
        history.pushState({ viewId, currentSemesterId, currentCourseId }, '', `#${viewId}`);
    }

    if (viewId === 'welcome-view') {
        document.body.className = 'on-welcome';
        clearAuthInputs(); // Otomatis bersihkan saat kembali ke Welcome Screen
        setTimeout(() => {
            const authEmail = document.getElementById('auth-email');
            if (authEmail) authEmail.focus();
        }, 100);
    } else {
        document.body.className = '';
        renderCurrentView();
    }
}

// MANIPULASI MODAL POPUP INPUT
function openModal(modalId) {
    document.getElementById(modalId).classList.remove('hidden');
    if (modalId === 'semester-modal') {
        document.getElementById('input-semester-name').focus();
    } else if (modalId === 'course-modal') {
        document.getElementById('input-course-name').focus();
    }
}

function closeModal(modalId) {
    document.getElementById(modalId).classList.add('hidden');
    const inputs = document.querySelectorAll(`#${modalId} input[type="text"]`);
    inputs.forEach(input => input.value = '');
    
    if (modalId === 'course-modal') {
        const tutonRadio = document.querySelector('input[name="course-type"][value="Tuton"]');
        if (tutonRadio) tutonRadio.checked = true;
    }
}

// PEMBACA KEYBOARD ENTER PADA SEMUA INPUT BOX (MODAL & LOGIN) [3]
function setupKeyboardListeners() {
    // 1. Input Modal Semester & Matkul
    document.getElementById('input-semester-name').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            addSemester();
        }
    });

    document.getElementById('input-course-name').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            addCourse();
        }
    });

    // 2. Form Login (Email enter -> Fokus ke Password dengan jeda aman, Password enter -> Trigger Login)
    document.getElementById('auth-email').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.keyCode === 13) {
            e.preventDefault();
            e.stopPropagation();
            setTimeout(() => {
                const passInput = document.getElementById('auth-password');
                if (passInput) passInput.focus();
            }, 20);
        }
    });

    document.getElementById('auth-password').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.keyCode === 13) {
            e.preventDefault();
            e.stopPropagation();
            handleLogin(); 
        }
    });

    // 3. Form Register (Email enter -> Fokus ke Password baru dengan jeda aman, Password enter -> Trigger Daftar)
    document.getElementById('reg-email').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.keyCode === 13) {
            e.preventDefault();
            e.stopPropagation();
            setTimeout(() => {
                const regPassInput = document.getElementById('reg-password');
                if (regPassInput) regPassInput.focus();
            }, 20);
        }
    });

    document.getElementById('reg-password').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.keyCode === 13) {
            e.preventDefault();
            e.stopPropagation();
            handleRegister(); 
        }
    });
}

/* ==========================================================================
   FUNGSI TRANSAKSI AUTENTIKASI (FIREBASE ENGINE)
   ========================================================================== */
function toggleAuthMode(showRegister) {
    clearAuthInputs(); // Bersihkan input saat berganti mode Login / Daftar
    if (showRegister) {
        document.getElementById('login-card').classList.add('hidden');
        document.getElementById('register-card').classList.remove('hidden');
        setTimeout(() => document.getElementById('reg-email').focus(), 50); 
    } else {
        document.getElementById('register-card').classList.add('hidden');
        document.getElementById('login-card').classList.remove('hidden');
        setTimeout(() => document.getElementById('auth-email').focus(), 50); 
    }
}

async function handleLogin() {
    if (!auth) {
        showCustomDialog({ title: "Offline", message: "Gagal menghubungkan ke layanan Firebase. Silakan periksa koneksi internet atau konfigurasi API Key Anda.", showCancel: false });
        return;
    }

    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value;

    if (!email || !password) {
        showCustomDialog({ title: "Gagal", message: "Email dan password wajib diisi!", showCancel: false });
        return;
    }

    try {
        await auth.signInWithEmailAndPassword(email, password);
    } catch (error) {
        console.error(error);
        showCustomDialog({ title: "Gagal Masuk", message: "Email atau password salah / tidak terdaftar.", showCancel: false });
    }
}

async function handleRegister() {
    if (!auth) {
        showCustomDialog({ title: "Offline", message: "Gagal menghubungkan ke layanan Firebase.", showCancel: false });
        return;
    }

    const email = document.getElementById('reg-email').value.trim();
    const password = document.getElementById('reg-password').value;

    if (!email || !password) {
        showCustomDialog({ title: "Gagal", message: "Email dan password tidak boleh kosong!", showCancel: false });
        return;
    }

    if (password.length < 6) {
        showCustomDialog({ title: "Peringatan", message: "Password minimal harus berisi 6 karakter!", showCancel: false });
        return;
    }

    try {
        isRegistering = true; // Tandai sedang melakukan registrasi
        await auth.createUserWithEmailAndPassword(email, password);
        
        // Memunculkan pop-up sukses pendaftaran
        showCustomDialog({ 
            title: "Daftar Berhasil", 
            message: "Akun baru Anda berhasil didaftarkan! Silakan masukkan email dan password di kolom masuk untuk login.", 
            showCancel: false 
        });
        
        toggleAuthMode(false); // Otomatis balikkan form ke mode Login utama
    } catch (error) {
        isRegistering = false;
        console.error(error);
        showCustomDialog({ title: "Pendaftaran Gagal", message: error.message, showCancel: false });
    }
}

async function handleLogout() {
    if (!auth) {
        currentUser = null;
        appData = [];
        navigateTo('welcome-view');
        return;
    }

    const isConfirmed = await showCustomDialog({
        title: "Konfirmasi Keluar",
        message: "Apakah Anda yakin ingin keluar dari akun Anda?"
    });

    if (isConfirmed) {
        auth.signOut();
    }
}

/* ==========================================================================
   KUSTOM DIALOG POP-UP (PROMISE ASINKRON + ALIH FOKUS KEYBOARD ENTER) [3, 8]
   ========================================================================== */
function showCustomDialog({ title, message, showCancel = true, confirmText = "OK" }) {
    return new Promise((resolve) => {
        const dialog = document.getElementById('custom-dialog');
        const dTitle = document.getElementById('dialog-title');
        const dMsg = document.getElementById('dialog-message');
        const dBtnConfirm = document.getElementById('dialog-btn-confirm');
        const dBtnCancel = document.getElementById('dialog-btn-cancel');

        dTitle.innerText = title;
        dMsg.innerText = message;
        dBtnConfirm.innerText = confirmText;

        if (showCancel) {
            dBtnCancel.classList.remove('hidden');
        } else {
            dBtnCancel.classList.add('hidden');
        }

        dialog.classList.remove('hidden');

        // Fungsi pembersihan event listeners agar tidak menumpuk di memori
        const cleanupAndResolve = (result) => {
            dialog.classList.add('hidden');
            newConfirm.removeEventListener('click', onConfirmClick);
            newCancel.removeEventListener('click', onCancelClick);
            window.removeEventListener('keydown', onKeydown); 
            resolve(result);
        };

        const onConfirmClick = () => cleanupAndResolve(true);
        const onCancelClick = () => cleanupAndResolve(false);

        // Fungsi pendengar keyboard kustom
        const onKeydown = (e) => {
            if (e.key === 'Enter' || e.keyCode === 13) {
                e.preventDefault();
                onConfirmClick();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                onCancelClick();
            }
        };

        // Kloning node untuk membersihkan event listeners sebelumnya secara mutlak
        const newConfirm = dBtnConfirm.cloneNode(true);
        const newCancel = dBtnCancel.cloneNode(true);
        dBtnConfirm.replaceWith(newConfirm);
        dBtnCancel.replaceWith(newCancel);

        newConfirm.addEventListener('click', onConfirmClick);
        newCancel.addEventListener('click', onCancelClick);

        // ALIH FOKUS: Hilangkan kedipan fokus di kolom password saat pop-up muncul [8]
        if (document.activeElement) {
            document.activeElement.blur(); 
        }

        // Menunda pemasangan Keydown Event agar tidak bertabrakan dengan input Enter sebelumnya
        setTimeout(() => {
            window.addEventListener('keydown', onKeydown); 
            newConfirm.focus(); // Fokuskan kursor browser ke tombol konfirmasi baru agar siap ditekan Enter [8]
        }, 50);
    });
}

/* ==========================================================================
   KUSTOM PEMILIH STATUS / STATUS PICKER OVERLAY (Goal 2) [8]
   ========================================================================== */
function openStatusPicker(sessionId) {
    activeSessionIdForStatus = sessionId;
    document.getElementById('status-picker-dialog').classList.remove('hidden');
    
    // Matikan kedipan kursor input yang aktif jika ada
    if (document.activeElement) {
        document.activeElement.blur();
    }
}

function closeStatusPicker() {
    document.getElementById('status-picker-dialog').classList.add('hidden');
    activeSessionIdForStatus = null;
}

function selectStatusOption(statusValue) {
    if (activeSessionIdForStatus) {
        updateSessionStatus(activeSessionIdForStatus, statusValue);
        closeStatusPicker();
    }
}


/* ==========================================================================
   1. DASHBOARD VIEW - MANAJEMEN SEMESTER
   ========================================================================== */
function renderDashboard() {
    const semesterListContainer = document.getElementById('semester-list');
    semesterListContainer.innerHTML = '';

    if (appData.length === 0) {
        semesterListContainer.innerHTML = `
            <div style="text-align: center; padding: 2rem; color: var(--text-sub); font-size: 0.85rem;">
                Belum ada semester. Klik "+ Semester" untuk memulai.
            </div>`;
        return;
    }

    appData.forEach(sem => {
        const totalCourses = sem.courses.length;
        const progress = calculateSemesterProgress(sem);

        const card = document.createElement('div');
        card.className = 'item-card';
        
        card.addEventListener('click', (e) => {
            if (!e.target.closest('.btn-delete')) {
                selectSemester(sem.id);
            }
        });

        card.innerHTML = `
            <div class="item-info">
                <h4>${escapeHTML(sem.name)}</h4>
                <p>${totalCourses} Mata Kuliah • Progres: ${progress}%</p>
            </div>
            <div class="card-actions">
                <button class="btn-delete" onclick="deleteSemester('${sem.id}', event)">Hapus</button>
            </div>
        `;
        semesterListContainer.appendChild(card);
    });
}

function addSemester() {
    const input = document.getElementById('input-semester-name');
    const name = input.value.trim();

    if (!name) {
        showCustomDialog({ title: "Peringatan", message: "Nama semester tidak boleh kosong!", showCancel: false });
        return;
    }

    const newSemester = {
        id: 'sem_' + Date.now(),
        name: name,
        billingFile: null,
        nilaiFile: null,
        courses: []
    };

    appData.push(newSemester);
    saveData();
    closeModal('semester-modal');
    renderDashboard(); // Instantly update UI locally
}

async function deleteSemester(id, event) {
    event.stopPropagation();
    
    const isConfirmed = await showCustomDialog({
        title: "Konfirmasi Hapus",
        message: "Apakah Anda yakin ingin menghapus semester ini beserta isinya?"
    });

    if (isConfirmed) {
        const uid = currentUser ? currentUser.uid : "guest";
        await deleteFileFromDB(`${uid}_${id}_billing`);
        await deleteFileFromDB(`${uid}_${id}_nilai`);

        appData = appData.filter(sem => sem.id !== id);
        saveData();
        renderDashboard(); // Instantly update UI locally
    }
}

function selectSemester(id) {
    currentSemesterId = id;
    navigateTo('semester-view');
}


/* ==========================================================================
   2. SEMESTER VIEW - MANAJEMEN MATA KULIAH & BERKAS (SINKRONISASI INDEXEDDB)
   ========================================================================== */
function renderSemester() {
    const sem = appData.find(s => s.id === currentSemesterId);
    if (!sem) {
        navigateTo('dashboard-view');
        return;
    }

    document.getElementById('current-semester-title').innerText = sem.name;
    
    const semProgress = calculateSemesterProgress(sem);
    document.getElementById('semester-progress-text').innerText = `${semProgress}%`;
    document.getElementById('semester-progress-bar').style.width = `${semProgress}%`;

    // Render Status Berkas
    renderFileStatus('billing', sem.billingFile);
    renderFileStatus('nilai', sem.nilaiFile);

    const courseListContainer = document.getElementById('course-list');
    courseListContainer.innerHTML = '';

    if (sem.courses.length === 0) {
        courseListContainer.innerHTML = `
            <div style="text-align: center; padding: 2.5rem; color: var(--text-sub);">
                Belum ada mata kuliah di semester ini.
            </div>`;
        return;
    }

    sem.courses.forEach(course => {
        const progress = calculateCourseProgress(course);
        const typeLabel = course.type === 'Praktik' ? 'Praktik (3 Sesi)' : 'Tuton (8 Sesi)';

        const card = document.createElement('div');
        card.className = 'item-card';

        card.addEventListener('click', (e) => {
            if (!e.target.closest('.btn-delete')) {
                selectCourse(course.id);
            }
        });

        card.innerHTML = `
            <div class="item-info">
                <h4>${escapeHTML(course.name)}</h4>
                <p>${typeLabel} • Progres: ${progress}%</p>
            </div>
            <div class="card-actions">
                <button class="btn-delete" onclick="deleteCourse('${course.id}', event)">Hapus</button>
            </div>
        `;
        courseListContainer.appendChild(card);
    });
}

async function uploadLocalFile(type) {
    const sem = appData.find(s => s.id === currentSemesterId);
    if (!sem) return;

    const fileInput = document.getElementById(`file-${type}`);
    if (fileInput.files.length > 0) {
        const file = fileInput.files[0];
        const uid = currentUser ? currentUser.uid : "guest";
        const dbKey = `${uid}_${currentSemesterId}_${type}`; 

        try {
            await saveFileToDB(dbKey, file);

            const fileMeta = {
                name: file.name,
                uploadedAt: new Date().toLocaleDateString('id-ID'),
                dbKey: dbKey
            };

            if (type === 'billing') {
                sem.billingFile = fileMeta;
            } else {
                sem.nilaiFile = fileMeta;
            }

            saveData();
            renderSemester(); // Instantly update UI locally
            
            showCustomDialog({ title: "Berhasil", message: `Berkas "${file.name}" berhasil diunggah & diamankan di browser!`, showCancel: false });
        } catch (error) {
            console.error(error);
            showCustomDialog({ title: "Gagal", message: "Browser gagal mengamankan file di database lokal.", showCancel: false });
        }
    }
}

function renderFileStatus(type, fileMeta) {
    const statusEl = document.getElementById(`${type}-status`);
    const deleteBtn = document.getElementById(`btn-delete-${type}`);

    if (fileMeta) {
        statusEl.innerHTML = `
            <span class="file-link" onclick="viewLocalFile('${fileMeta.dbKey}')">📄 ${escapeHTML(fileMeta.name)}</span>
            <br><span style="font-size:0.7rem;">Diupload: ${fileMeta.uploadedAt}</span>
        `;
        deleteBtn.classList.remove('hidden');
    } else {
        statusEl.innerText = "Belum ada file";
        deleteBtn.classList.add('hidden');
    }
}

async function viewLocalFile(dbKey) {
    const newTab = window.open('about:blank', '_blank');
    if (!newTab) {
        showCustomDialog({ title: "Popup Terblokir", message: "Harap aktifkan perizinan popup pada pengaturan browser Anda untuk membuka file.", showCancel: false });
        return;
    }

    try {
        const fileBlob = await getFileFromDB(dbKey);
        if (fileBlob) {
            const fileURL = URL.createObjectURL(fileBlob);
            newTab.location.href = fileURL; 
        } else {
            newTab.close();
            // Informasi bahwa file terikat dengan perangkat lokal (Goal 3.1)
            showCustomDialog({ title: "Tidak Ditemukan", message: "Berkas fisik PDF tersimpan di perangkat Anda yang lain. Harap unggah berkas di perangkat ini untuk membukanya.", showCancel: false });
        }
    } catch (error) {
        newTab.close();
        console.error(error);
        showCustomDialog({ title: "Error", message: "Gagal memproses berkas PDF Anda.", showCancel: false });
    }
}

async function deleteLocalFile(type) {
    const sem = appData.find(s => s.id === currentSemesterId);
    if (!sem) return;

    const isConfirmed = await showCustomDialog({
        title: "Konfirmasi Hapus Berkas",
        message: `Apakah Anda yakin ingin melepas lampiran berkas ${type} ini?`
    });

    if (isConfirmed) {
        const uid = currentUser ? currentUser.uid : "guest";
        const dbKey = `${uid}_${currentSemesterId}_${type}`;
        try {
            await deleteFileFromDB(dbKey);

            if (type === 'billing') {
                sem.billingFile = null;
            } else {
                sem.nilaiFile = null;
            }
            saveData();
            renderSemester(); // Instantly update UI locally
            document.getElementById(`file-${type}`).value = '';
        } catch (error) {
            console.error(error);
        }
    }
}

// TAMBAH MATA KULIAH DENGAN PILIHAN DINAMIS
function addCourse() {
    const input = document.getElementById('input-course-name');
    const name = input.value.trim();

    if (!name) {
        showCustomDialog({ title: "Peringatan", message: "Nama mata kuliah tidak boleh kosong!", showCancel: false });
        return;
    }

    const sem = appData.find(s => s.id === currentSemesterId);
    if (!sem) return;

    const type = document.querySelector('input[name="course-type"]:checked').value;
    const sessions = [];

    if (type === 'Tuton') {
        let tugasCounter = 1;
        let diskusiCounter = 1;
        for (let s = 1; s <= 8; s++) {
            let isTugas = (s === 3 || s === 5 || s === 7);
            sessions.push({
                id: 'sess_' + s + '_' + Date.now(),
                sessionNum: s,
                type: isTugas ? 'Tugas' : 'Diskusi',
                title: isTugas ? `Tugas ${tugasCounter++}` : `Diskusi ${diskusiCounter++}`,
                status: 'Belum Disentuh',
                note: ''
            });
        }
    } else {
        for (let s = 1; s <= 3; s++) {
            sessions.push({
                id: 'sess_' + s + '_' + Date.now(),
                sessionNum: s,
                type: 'Tugas',
                title: `Tugas ${s}`,
                status: 'Belum Disentuh',
                note: ''
            });
        }
    }

    const newCourse = {
        id: 'course_' + Date.now(),
        name: name,
        type: type,
        sessions: sessions
    };

    sem.courses.push(newCourse);
    saveData();
    closeModal('course-modal');
    renderSemester(); // Instantly update UI locally
}

async function deleteCourse(id, event) {
    event.stopPropagation();
    
    const isConfirmed = await showCustomDialog({
        title: "Konfirmasi Hapus",
        message: "Apakah Anda yakin ingin menghapus mata kuliah ini?"
    });

    if (isConfirmed) {
        const sem = appData.find(s => s.id === currentSemesterId);
        if (sem) {
            sem.courses = sem.courses.filter(c => c.id !== id);
            saveData();
            renderSemester(); // Instantly update UI locally
        }
    }
}

function selectCourse(id) {
    currentCourseId = id;
    navigateTo('tracker-view');
}


/* ==========================================================================
   3. TRACKER VIEW - DETAIL SESI & CATATAN (MENGGUNAKAN BADGE PEMILIH KUSTOM - Goal 2)
   ========================================================================== */
function renderTracker() {
    const sem = appData.find(s => s.id === currentSemesterId);
    if (!sem) {
        navigateTo('dashboard-view');
        return;
    }

    const course = sem.courses.find(c => c.id === currentCourseId);
    if (!course) {
        navigateTo('semester-view');
        return;
    }

    document.getElementById('current-course-title').innerText = course.name;
    document.getElementById('current-course-parent-semester').innerText = sem.name;

    const courseProgress = calculateCourseProgress(course);
    document.getElementById('course-progress-text').innerText = `${courseProgress}%`;
    document.getElementById('course-progress-bar').style.width = `${courseProgress}%`;

    const sessionListContainer = document.getElementById('session-list');
    sessionListContainer.innerHTML = '';

    course.sessions.forEach(session => {
        const card = document.createElement('div');
        card.className = 'session-card';

        let selectClass = 'status-todo';
        if (session.status === 'Proses') selectClass = 'status-process';
        if (session.status === 'Done') selectClass = 'status-done';

        // GANTI SELECT DROPDOWN MENJADI TOMBOL STATUS KLIK (Goal: Estetika Monokrom) [8]
        card.innerHTML = `
            <div class="session-main-row">
                <div class="session-title">
                    <h5>Sesi ${session.sessionNum}: ${session.title}</h5>
                    <span>Kategori: ${session.type}</span>
                </div>
                <div>
                    <div class="status-badge-trigger ${selectClass}" onclick="openStatusPicker('${session.id}')">
                        ${session.status}
                    </div>
                </div>
            </div>
            
            <div class="session-note-row">
                <textarea 
                    class="session-note-input" 
                    placeholder="Tambahkan catatan untuk Sesi ${session.sessionNum}..." 
                    oninput="updateSessionNote('${session.id}', this.value)"
                >${escapeHTML(session.note || '')}</textarea>
            </div>
        `;
        sessionListContainer.appendChild(card);
    });
}

function updateSessionStatus(sessionId, newStatus) {
    const sem = appData.find(s => s.id === currentSemesterId);
    if (!sem) return;

    const course = sem.courses.find(c => c.id === currentCourseId);
    if (!course) return;

    const session = course.sessions.find(s => s.id === sessionId);
    if (session) {
        session.status = newStatus;
        saveData();
        renderTracker(); // Instantly update UI locally
    }
}

function updateSessionNote(sessionId, textContent) {
    const sem = appData.find(s => s.id === currentSemesterId);
    if (!sem) return;

    const course = sem.courses.find(c => c.id === currentCourseId);
    if (!course) return;

    const session = course.sessions.find(s => s.id === sessionId);
    if (session) {
        session.note = textContent;
        saveData();
    }
}


/* ==========================================================================
   KALKULATOR METODE PERHITUNGAN PROGRESS & UTILITY HELPER
   ========================================================================= */
function calculateCourseProgress(course) {
    if (!course.sessions || course.sessions.length === 0) return 0;
    
    let totalPoints = 0;
    course.sessions.forEach(sess => {
        if (sess.status === 'Done') totalPoints += 100;
        else if (sess.status === 'Proses') totalPoints += 50;
    });

    const maxPoints = course.sessions.length * 100;
    return Math.round((totalPoints / maxPoints) * 100);
}

function calculateSemesterProgress(sem) {
    if (!sem.courses || sem.courses.length === 0) return 0;

    let totalProgress = 0;
    sem.courses.forEach(course => {
        totalProgress += calculateCourseProgress(course);
    });

    return Math.round(totalProgress / sem.courses.length);
}

function escapeHTML(str) {
    return str.replace(/[&<>'"]/g, 
        tag => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            "'": '&#39;',
            '"': '&quot;'
        }[tag] || tag)
    );
}
