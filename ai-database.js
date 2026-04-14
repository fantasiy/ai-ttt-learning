// ai-database.js — upgraded
class AIDatabase {
    constructor() {
        this.storageKey = 'ticTacToeAIExperience';
        this.version = 2;
        this.maxEntries = 5000;   // batas ukuran database
        this.decayFactor = 0.95;  // pengalaman lama bobotnya turun 5% tiap game
        this.smoothingAlpha = 0.5; // additive smoothing — mencegah overconfidence pada sampel kecil
        this.normalizeInterval = 200; // normalisasi bobot setiap N update experience
        this._updatesSinceNormalize = 0;
        this._saveDebounceTimer = null; // debounce save agar tidak terlalu sering
        this.data = this.load();
        // Poin 3: jamin data tersimpan saat tab/browser ditutup — batalkan debounce dan tulis langsung
        window.addEventListener('beforeunload', () => this.saveImmediate());
    }

    load() {
        try {
            const stored = localStorage.getItem(this.storageKey);
            if (!stored) return { version: this.version, states: {} };

            const parsed = JSON.parse(stored);

            // migrasi dari versi lama (v1 tidak punya wrapper version/states)
            if (!parsed.version || parsed.version < 2) {
                console.log('[AIDatabase] Migrating from v1 to v2...');
                return { version: this.version, states: parsed };
            }

            return parsed;
        } catch (e) {
            console.warn('[AIDatabase] Corrupt data, resetting.', e);
            return { version: this.version, states: {} };
        }
    }

    save() {
        // Debounce: tunda write ke localStorage max 500ms agar tidak throttle
        // saat AI bermain cepat berturut-turut
        if (this._saveDebounceTimer) clearTimeout(this._saveDebounceTimer);
        this._saveDebounceTimer = setTimeout(() => {
            this._saveDebounceTimer = null;
            try {
                localStorage.setItem(this.storageKey, JSON.stringify(this.data));
            } catch (e) {
                // localStorage penuh — pruning entri terlama
                console.warn('[AIDatabase] Storage full, pruning...', e);
                this._pruneOldest();
                try {
                    localStorage.setItem(this.storageKey, JSON.stringify(this.data));
                } catch (e2) {
                    console.error('[AIDatabase] Save failed even after pruning.', e2);
                }
            }
        }, 500);
    }

    // Paksa save segera — dipanggil saat user akan meninggalkan halaman
    saveImmediate() {
        if (this._saveDebounceTimer) {
            clearTimeout(this._saveDebounceTimer);
            this._saveDebounceTimer = null;
        }
        try {
            localStorage.setItem(this.storageKey, JSON.stringify(this.data));
        } catch (e) {
            console.warn('[AIDatabase] Storage full, pruning...', e);
            this._pruneOldest();
            localStorage.setItem(this.storageKey, JSON.stringify(this.data));
        }
    }

    get states() {
        return this.data.states;
    }

    getStats(stateKey, action) {
        const stateEntry = this.states[stateKey];
        if (!stateEntry) return null;
        // Poin 4: update _lastAccessed saat state dibaca (bukan hanya saat ditulis)
        // agar state yang aktif dipakai untuk eksploitasi tidak terhapus pruning
        stateEntry._lastAccessed = Date.now();
        return stateEntry[action] || null;
    }

    // Decay semua entry — hanya dipanggil saat pruning, bukan setiap game
    // Mencegah bobot turun terlalu cepat saat jumlah game besar
    _applyDecay() {
        for (const stateKey of Object.keys(this.states)) {
            for (const action of Object.keys(this.states[stateKey])) {
                const stats = this.states[stateKey][action];
                stats.wins    *= this.decayFactor;
                stats.losses  *= this.decayFactor;
                stats.draws   *= this.decayFactor;
            }
        }
    }

    // Hapus state yang paling tidak berguna: kombinasi skor rendah + lama tidak diakses
    // Ini lebih baik dari LRU murni — state sering diakses tapi selalu kalah tetap bisa terhapus
    // Decay TIDAK dipanggil di sini — sudah diurus periodik oleh ai-logic setiap N game
    _pruneOldest() {
        const now = Date.now();
        const entries = Object.entries(this.states).map(([key, actions]) => {
            const lastAccessed = actions._lastAccessed ?? 0;
            // Hitung rata-rata skor semua action di state ini
            const actionKeys = Object.keys(actions).filter(k => k !== '_lastAccessed');
            let totalScore = 0;
            let count = 0;
            for (const ak of actionKeys) {
                const s = actions[ak];
                const tot = s.wins + s.losses + s.draws;
                if (tot > 0) {
                    totalScore += (s.wins + 0.5 * s.draws) / tot;
                    count++;
                }
            }
            const avgScore = count > 0 ? totalScore / count : 0.5;
            // Nilai guna: gabungkan recency (log) dan skor — skala logaritmik agar
            // state yang lama tidak diakses tidak mendapat penalti berlebihan
            const recencySeconds = (now - lastAccessed) / 1000;
            const recencyPenalty = Math.log1p(recencySeconds) * 0.01; // tumbuh lambat
            const utility = avgScore - recencyPenalty;
            return { key, utility };
        });

        // Urutkan dari yang paling tidak berguna (utility terkecil)
        entries.sort((a, b) => a.utility - b.utility);

        const toDelete = Math.floor(entries.length * 0.2); // hapus 20% terbawah
        for (let i = 0; i < toDelete; i++) {
            delete this.states[entries[i].key];
        }
    }

    updateExperience(experience) {
        const now = Date.now();
        for (const exp of experience) {
            const { stateKey, action, result, weight = 1 } = exp;
            if (!this.states[stateKey]) this.states[stateKey] = { _lastAccessed: now };
            if (!this.states[stateKey][action]) {
                this.states[stateKey][action] = { wins: 0, losses: 0, draws: 0 };
            }
            this.states[stateKey]._lastAccessed = now;
            const stats = this.states[stateKey][action];
            if      (result === 'win')  stats.wins   += weight;
            else if (result === 'loss') stats.losses += weight;
            else if (result === 'draw') stats.draws  += weight;
        }

        // Poin 5: normalisasi berkala agar bobot tidak membesar tak terbatas
        this._updatesSinceNormalize++;
        if (this._updatesSinceNormalize >= this.normalizeInterval) {
            this._normalizeWeights();
            this._updatesSinceNormalize = 0;
        }

        // Pruning kalau database terlalu besar
        if (Object.keys(this.states).length > this.maxEntries) {
            this._pruneOldest();
        }

        this.save();
    }

    // Poin 5: normalisasi — bagi semua statistik dengan faktor agar total per action ≤ maxWeight
    // Mencegah pengalaman lama mendominasi sepenuhnya sehingga game baru tidak berpengaruh
    _normalizeWeights() {
        const maxWeight = 100; // target batas atas total (wins+losses+draws) per action
        for (const stateKey of Object.keys(this.states)) {
            for (const action of Object.keys(this.states[stateKey])) {
                if (action === '_lastAccessed') continue;
                const stats = this.states[stateKey][action];
                const total = stats.wins + stats.losses + stats.draws;
                if (total > maxWeight) {
                    const factor = maxWeight / total;
                    stats.wins   *= factor;
                    stats.losses *= factor;
                    stats.draws  *= factor;
                }
            }
        }
    }

    getActionsForState(stateKey) {
        return this.states[stateKey]
            ? Object.keys(this.states[stateKey]).filter(k => k !== '_lastAccessed').map(Number)
            : [];
    }

    getScore(stateKey, action) {
        const stats = this.getStats(stateKey, action);
        // Poin 2: optimistic initial value 0.5 untuk action yang belum pernah dicoba
        // (bukan 0) agar action baru tetap kompetitif saat fase eksploitasi
        if (!stats) return 0.5;
        const total = stats.wins + stats.losses + stats.draws;
        if (total === 0) return 0.5;
        // Poin 1: additive smoothing — (wins + α) / (total + 2α)
        // Mencegah AI terlalu yakin pada action yang hanya dicoba 1-2 kali
        // α = smoothingAlpha (default 0.5): semakin besar total, semakin kecil pengaruh smoothing
        const α = this.smoothingAlpha;
        return (stats.wins + 0.5 * stats.draws + α) / (total + 2 * α);
    }

    // Info debug — berapa banyak state yang tersimpan
    getInfo() {
        const stateCount = Object.keys(this.states).length;
        const actionCount = Object.values(this.states).reduce((sum, actions) => {
            return sum + Object.keys(actions).filter(k => k !== '_lastAccessed').length;
        }, 0);
        return { version: this.version, stateCount, actionCount };
    }

    reset() {
        this.data = { version: this.version, states: {} };
        this.save();
    }
}
