// ai-learning.js - Mode Belajar Mandiri untuk AI TicTacToe
// Tambahkan script ini setelah ai-database.js dan ai-logic.js di index.html
//
// [UPGRADE] Fitur tambahan:
// - Auto-save checkpoint periodik (default tiap 10 game)
// - Resume learning dari checkpoint terakhir
// - Pause & Resume
// - Adaptive epsilon decay per game
// - Moving average winrate untuk monitoring
// - Logging ke console dengan level detail

class AILearning {
    constructor(database, aiInstance) {
        this.database = database;
        this.ai = aiInstance;
        this.isLearning = false;
        this.currentGames = 0;
        this.totalGames = 0;
        this.results = { wins: 0, losses: 0, draws: 0 };
        this.onProgress = null;
        this.onComplete = null;
        
        // ========== FITUR TAMBAHAN (UPGRADE) ==========
        this.checkpointInterval = 10;      // simpan checkpoint setiap N game
        this.lastCheckpoint = 0;
        this.checkpointKey = 'ai_learning_checkpoint';
        this.autoSave = true;               // auto-save periodik ke localStorage
        this.verbose = true;                // log detail ke console
        this.movingWindowSize = 20;         // untuk moving average winrate
        this.recentResults = [];             // array hasil game terakhir (win/loss/draw)
        this.isPaused = false;
        this.pausePromise = null;
        this.pauseResolve = null;
        this.batchSize = 50;                 // ukuran batch per iterasi (dapat berubah otomatis)
        this.adaptiveBatch = true;           // sesuaikan batch size berdasarkan waktu eksekusi
        this.lastBatchDuration = 0;
        
        // Load checkpoint yang tersimpan (jika ada)
        this.loadCheckpoint();
    }

    // Method utama untuk belajar mandiri (VERSI UPGRADE)
    async learn(games = 100, onProgress = null, onComplete = null, resume = true) {
        if (this.isLearning) {
            console.warn('[Learning] Sedang belajar, tunggu selesai');
            return false;
        }

        // Jika resume diaktifkan dan ada checkpoint tersimpan, lanjutkan dari situ
        let startFrom = 0;
        if (resume && this.checkpointData && this.checkpointData.currentGames) {
            startFrom = this.checkpointData.currentGames;
            this.currentGames = startFrom;
            this.totalGames = games;
            this.results = this.checkpointData.results || { wins: 0, losses: 0, draws: 0 };
            this.recentResults = this.checkpointData.recentResults || [];
            // Set epsilon AI dari checkpoint
            if (this.checkpointData.epsilon !== undefined) {
                this.ai.epsilon = this.checkpointData.epsilon;
            }
            this.log(`[Learning] Melanjutkan dari checkpoint: ${this.currentGames}/${this.totalGames} game`);
        } else {
            this.currentGames = 0;
            this.totalGames = games;
            this.results = { wins: 0, losses: 0, draws: 0 };
            this.recentResults = [];
            this.log(`[Learning] Memulai belajar mandiri baru ${games} game...`);
        }
        
        this.isLearning = true;
        this.isPaused = false;
        this.onProgress = onProgress;
        this.onComplete = onComplete;
        this.lastCheckpoint = this.currentGames;

        // Jalankan learning dengan batch adaptif
        const runAdaptiveBatch = async () => {
            if (this.isPaused) {
                await new Promise(resolve => { this.pauseResolve = resolve; });
            }
            if (!this.isLearning) return;
            
            const remaining = this.totalGames - this.currentGames;
            if (remaining <= 0) {
                this.finishLearning();
                return;
            }
            
            // Hitung batch size adaptif (jika diaktifkan)
            let currentBatchSize = this.batchSize;
            if (this.adaptiveBatch && this.lastBatchDuration > 0) {
                // target durasi per batch ~50ms agar UI tetap responsif
                const targetDuration = 50;
                const ratio = targetDuration / Math.max(this.lastBatchDuration, 1);
                let newSize = Math.floor(this.batchSize * Math.min(2, Math.max(0.5, ratio)));
                newSize = Math.min(100, Math.max(10, newSize));
                if (Math.abs(newSize - this.batchSize) > 5) {
                    this.batchSize = newSize;
                    this.log(`[Adaptive] Batch size disesuaikan: ${this.batchSize} (durasi terakhir: ${this.lastBatchDuration}ms)`);
                }
                currentBatchSize = this.batchSize;
            }
            
            const batch = Math.min(currentBatchSize, remaining);
            const startTime = performance.now();
            
            for (let i = 0; i < batch; i++) {
                if (this.isPaused || !this.isLearning) break;
                this.playOneSelfGame();
            }
            
            const duration = performance.now() - startTime;
            this.lastBatchDuration = duration;
            
            // Update progress callback
            if (this.onProgress) {
                const winRate = this.getMovingWinRate();
                this.onProgress({
                    current: this.currentGames,
                    total: this.totalGames,
                    wins: this.results.wins,
                    losses: this.results.losses,
                    draws: this.results.draws,
                    epsilon: this.ai.epsilon,
                    winRate: winRate,
                    batchSize: this.batchSize
                });
            }
            
            // Auto-save checkpoint periodik
            if (this.autoSave && (this.currentGames - this.lastCheckpoint) >= this.checkpointInterval) {
                this.saveCheckpoint();
                this.lastCheckpoint = this.currentGames;
            }
            
            // Lanjutkan batch berikutnya
            if (this.isLearning && !this.isPaused && this.currentGames < this.totalGames) {
                setTimeout(() => runAdaptiveBatch(), 5);
            } else if (this.currentGames >= this.totalGames) {
                this.finishLearning();
            }
        };
        
        runAdaptiveBatch();
        return true;
    }

    // Mainkan satu game self-play (AI vs AI) - [DITINGKATKAN dengan logging & moving average]
    playOneSelfGame() {
        const lines = [
            [0,1,2],[3,4,5],[6,7,8],
            [0,3,6],[1,4,7],[2,5,8],
            [0,4,8],[2,4,6]
        ];

        const checkWinner = (board, sym) => {
            return lines.some(([a,b,c]) => board[a] === sym && board[b] === sym && board[c] === sym);
        };

        // Buat dua instance AI dengan simbol berbeda, database SAMA
        const aiX = new AI(this.database, {
            epsilonStart: this.ai.epsilon,      // gunakan epsilon AI utama saat ini
            epsilonMin: this.ai.epsilonMin,
            epsilonDecay: this.ai.epsilonDecay,
            discountFactor: this.ai.discountFactor
        });
        aiX.setSymbol('X');

        const aiO = new AI(this.database, {
            epsilonStart: this.ai.epsilon,
            epsilonMin: this.ai.epsilonMin,
            epsilonDecay: this.ai.epsilonDecay,
            discountFactor: this.ai.discountFactor
        });
        aiO.setSymbol('O');

        const board = Array(9).fill('');
        let current = aiX;
        let other = aiO;
        
        let gameResult = null; // 'winX', 'winO', 'draw'
        
        while (true) {
            const move = current.chooseMove(board);
            if (move === null) {
                gameResult = 'draw';
                aiX.endGame('draw');
                aiO.endGame('draw');
                this.results.draws++;
                break;
            }

            current.recordMove(board, move);
            board[move] = current.symbol;

            if (checkWinner(board, current.symbol)) {
                if (current === aiX) {
                    gameResult = 'winX';
                    aiX.endGame('win');
                    aiO.endGame('loss');
                    this.results.wins++;
                } else {
                    gameResult = 'winO';
                    aiX.endGame('loss');
                    aiO.endGame('win');
                    this.results.losses++;
                }
                break;
            }

            if (board.every(cell => cell !== '')) {
                gameResult = 'draw';
                aiX.endGame('draw');
                aiO.endGame('draw');
                this.results.draws++;
                break;
            }

            [current, other] = [other, current];
        }

        // Catat hasil ke moving window
        this.recentResults.push(gameResult);
        if (this.recentResults.length > this.movingWindowSize) {
            this.recentResults.shift();
        }
        
        this.currentGames++;
        
        // ========== UPGRADE: Adaptive epsilon decay per game ==========
        // Kurangi epsilon secara bertahap (tidak hanya tiap 10 game)
        if (this.ai.epsilon > this.ai.epsilonMin) {
            // Decay per game: epsilon = epsilon * decayFactor
            this.ai.epsilon = Math.max(
                this.ai.epsilonMin,
                this.ai.epsilon * this.ai.epsilonDecay
            );
        }
        
        // Logging verbose setiap 50 game
        if (this.verbose && this.currentGames % 50 === 0) {
            const winRate = this.getMovingWinRate();
            this.log(`[Game ${this.currentGames}] Win:${this.results.wins} Loss:${this.results.losses} Draw:${this.results.draws} | Epsilon:${this.ai.epsilon.toFixed(4)} | WR:${(winRate*100).toFixed(1)}%`);
        }
    }

    // ========== METHOD TAMBAHAN UNTUK UPGRADE ==========
    
    // Menyimpan checkpoint ke localStorage
    saveCheckpoint() {
        const checkpoint = {
            currentGames: this.currentGames,
            totalGames: this.totalGames,
            results: this.results,
            recentResults: this.recentResults,
            epsilon: this.ai.epsilon,
            timestamp: Date.now()
        };
        try {
            localStorage.setItem(this.checkpointKey, JSON.stringify(checkpoint));
            if (this.verbose) {
                this.log(`[Checkpoint] Disimpan pada game ${this.currentGames}/${this.totalGames}`);
            }
            this.checkpointData = checkpoint;
        } catch(e) {
            console.warn('[Learning] Gagal menyimpan checkpoint:', e);
        }
    }
    
    // Memuat checkpoint dari localStorage
    loadCheckpoint() {
        try {
            const raw = localStorage.getItem(this.checkpointKey);
            if (raw) {
                this.checkpointData = JSON.parse(raw);
                if (this.verbose) {
                    this.log(`[Checkpoint] Ditemukan progress sebelumnya: ${this.checkpointData.currentGames} game (${new Date(this.checkpointData.timestamp).toLocaleString()})`);
                }
                return true;
            }
        } catch(e) {}
        this.checkpointData = null;
        return false;
    }
    
    // Menghapus checkpoint
    clearCheckpoint() {
        localStorage.removeItem(this.checkpointKey);
        this.checkpointData = null;
        this.log('[Checkpoint] Dihapus');
    }
    
    // Mendapatkan moving win rate (kemenangan AI X dalam self-play)
    getMovingWinRate() {
        if (this.recentResults.length === 0) return 0;
        const wins = this.recentResults.filter(r => r === 'winX').length;
        return wins / this.recentResults.length;
    }
    
    // Pause belajar
    pause() {
        if (this.isLearning && !this.isPaused) {
            this.isPaused = true;
            this.log('[Learning] Dijeda. Panggil resume() untuk melanjutkan.');
            return true;
        }
        return false;
    }
    
    // Resume belajar
    resume() {
        if (this.isLearning && this.isPaused) {
            this.isPaused = false;
            if (this.pauseResolve) {
                this.pauseResolve();
                this.pauseResolve = null;
            }
            this.log('[Learning] Dilanjutkan...');
            // Trigger batch berikutnya
            setTimeout(() => {
                if (this.isLearning && !this.isPaused && this.currentGames < this.totalGames) {
                    // panggil ulang learn logic via method internal
                    this.learn(this.totalGames, this.onProgress, this.onComplete, false);
                }
            }, 10);
            return true;
        }
        return false;
    }
    
    // Stop belajar dan hapus checkpoint (opsional)
    stopLearning(clearCheckpointFlag = false) {
        if (this.isLearning) {
            this.isLearning = false;
            this.isPaused = false;
            if (clearCheckpointFlag) {
                this.clearCheckpoint();
            } else {
                // simpan checkpoint terakhir sebelum berhenti
                this.saveCheckpoint();
            }
            this.log('[Learning] Belajar dihentikan paksa');
            return true;
        }
        return false;
    }
    
    // Logging dengan timestamp
    log(message) {
        if (this.verbose) {
            console.log(`[AILearning ${new Date().toLocaleTimeString()}] ${message}`);
        }
    }

    finishLearning() {
        this.isLearning = false;
        this.isPaused = false;
        
        // Simpan semua data ke localStorage
        this.database.saveImmediate();
        
        // Hapus checkpoint karena belajar selesai
        this.clearCheckpoint();
        
        const winRate = this.getMovingWinRate();
        console.log(`[Learning] Selesai! ${this.totalGames} game | Win:${this.results.wins} Loss:${this.results.losses} Draw:${this.results.draws} | Final WinRate:${(winRate*100).toFixed(1)}%`);
        
        if (this.onComplete) {
            this.onComplete({
                total: this.totalGames,
                wins: this.results.wins,
                losses: this.results.losses,
                draws: this.results.draws,
                epsilon: this.ai.epsilon,
                stateCount: this.database.getInfo().stateCount,
                winRate: winRate
            });
        }
    }

    getStats() {
        return {
            isLearning: this.isLearning,
            isPaused: this.isPaused,
            progress: this.isLearning ? `${this.currentGames}/${this.totalGames}` : 'Idle',
            results: this.results,
            databaseInfo: this.database.getInfo(),
            epsilon: this.ai.epsilon,
            movingWinRate: this.getMovingWinRate(),
            checkpointExists: this.checkpointData !== null,
            batchSize: this.batchSize,
            adaptiveBatch: this.adaptiveBatch
        };
    }
  }
