// ai-logic.js — upgraded
class AI {
    constructor(database, options = {}) {
        this.database = database;
        this.symbol = null;
        this.opponentSymbol = null;
        this.history = [];
        this.gameCount = 0;

        // Epsilon-greedy dengan decay
        this.epsilonStart  = options.epsilonStart  ?? 0.3;   // eksplorasi awal tinggi
        this.epsilonMin    = options.epsilonMin    ?? 0.05;  // minimal tetap sedikit eksplorasi
        this.epsilonDecay  = options.epsilonDecay  ?? 0.995; // makin banyak game, makin kecil epsilon
        this.epsilon       = this.epsilonStart;

        // Temporal credit: move akhir lebih berpengaruh
        this.discountFactor = options.discountFactor ?? 0.9;

        // Decay periodik: terapkan decay setiap N game
        this.gamesSinceLastDecay = 0;
        this.decayInterval = options.decayInterval ?? 100;
    }

    setSymbol(symbol) {
        this.symbol = symbol;
        this.opponentSymbol = symbol === 'X' ? 'O' : 'X';
    }

    // Normalisasi board — pakai canonical form (rotasi & refleksi terkecil)
    // Ini bikin state yang "sama secara strategi" dianggap satu state
    // Return { key, transform } agar action bisa dikonversi ke canonical index
    _canonicalize(board) {
        const transforms = [
            b => b,                                                          // original
            b => [b[6],b[3],b[0],b[7],b[4],b[1],b[8],b[5],b[2]],          // rotate 90
            b => [b[8],b[7],b[6],b[5],b[4],b[3],b[2],b[1],b[0]],          // rotate 180
            b => [b[2],b[5],b[8],b[1],b[4],b[7],b[0],b[3],b[6]],          // rotate 270
            b => [b[2],b[1],b[0],b[5],b[4],b[3],b[8],b[7],b[6]],          // flip H
            b => [b[6],b[7],b[8],b[3],b[4],b[5],b[0],b[1],b[2]],          // flip V
            b => [b[0],b[3],b[6],b[1],b[4],b[7],b[2],b[5],b[8]],          // flip diag
            b => [b[8],b[5],b[2],b[7],b[4],b[1],b[6],b[3],b[0]],          // flip anti-diag
        ];

        let bestKey = null;
        let bestTransform = null;
        for (const t of transforms) {
            const key = t(board).join('');
            if (bestKey === null || key < bestKey) {
                bestKey = key;
                bestTransform = t;
            }
        }
        return { key: bestKey, transform: bestTransform };
    }

    // Mapping index asli → index di board yang ter-transform
    // Digunakan untuk mengonversi action asli ke canonical action
    _transformIndex(transform, idx) {
        const dummy = Array(9).fill('').map((_, i) => i);
        return transform(dummy)[idx];
    }

    // Inverse transform: canonical index → index asli
    // Digunakan saat inference untuk mengonversi canonical action kembali ke board asli
    _inverseTransformIndex(transform, canonicalIdx) {
        const dummy = Array(9).fill('').map((_, i) => i);
        const mapped = transform(dummy);
        return mapped.indexOf(canonicalIdx);
    }

    getStateKey(board) {
        // Poin 5 fix: gunakan this.symbol (simbol AI yang sedang bermain) sebagai suffix
        // — lebih tepat dari hitung xCount/oCount karena:
        //   1. getStateKey hanya dipanggil saat giliran AI, jadi nextPlayer selalu this.symbol
        //   2. tidak menyimpan state giliran lawan yang tidak pernah dipakai AI sebagai pemain aktif
        //   3. konsisten jika AI berganti sisi (X atau O) antar game
        return this._canonicalize(board).key + '_' + this.symbol;
    }

    getLegalMoves(board) {
        return board.reduce((moves, cell, idx) => {
            if (cell === '') moves.push(idx);
            return moves;
        }, []);
    }

    // Cek apakah move tertentu akan langsung menang/block
    _checkInstantWin(board, moves, sym) {
        const lines = [
            [0,1,2],[3,4,5],[6,7,8],
            [0,3,6],[1,4,7],[2,5,8],
            [0,4,8],[2,4,6]
        ];
        for (const move of moves) {
            const testBoard = [...board];
            testBoard[move] = sym;
            for (const [a,b,c] of lines) {
                if (testBoard[a] === sym && testBoard[b] === sym && testBoard[c] === sym) {
                    return move; // langsung return move yang menang
                }
            }
        }
        return null;
    }

    get currentEpsilon() {
        return this.epsilon;
    }

    chooseMove(board) {
        const legalMoves = this.getLegalMoves(board);
        if (legalMoves.length === 0) return null;

        // ── Prioritas 1: langsung menang kalau bisa ──
        const winMove = this._checkInstantWin(board, legalMoves, this.symbol);
        if (winMove !== null) return winMove;

        // ── Prioritas 2: block lawan kalau mau menang ──
        const blockMove = this._checkInstantWin(board, legalMoves, this.opponentSymbol);
        if (blockMove !== null) return blockMove;

        // ── Prioritas 3: epsilon-greedy dari database ──
        // Dapatkan canonical state + transform yang dipakai
        const { transform } = this._canonicalize(board);
        const stateKey = this.getStateKey(board); // ✅ konsisten dengan recordMove

        if (Math.random() < this.epsilon) {
            // Eksplorasi: random, tapi bedakan move yang belum pernah dicoba (skor null) vs yang pernah kalah
            const untried = legalMoves.filter(m => {
                const canonicalM = this._transformIndex(transform, m);
                return this.database.getStats(stateKey, canonicalM) === null;
            });
            const pool = untried.length > 0 ? untried : legalMoves;
            return pool[Math.floor(Math.random() * pool.length)];
        }

        // Eksploitasi: pilih canonical action dengan skor tertinggi, lalu inverse transform ke index asli
        let bestMoves = [];
        let bestScore = -Infinity;
        for (const move of legalMoves) {
            const canonicalMove = this._transformIndex(transform, move);
            const score = this.database.getScore(stateKey, canonicalMove);
            if (score > bestScore) {
                bestScore = score;
                bestMoves = [move];
            } else if (Math.abs(score - bestScore) < 1e-6) {
                bestMoves.push(move);
            }
        }

        return bestMoves.length > 0
            ? bestMoves[Math.floor(Math.random() * bestMoves.length)]
            : legalMoves[Math.floor(Math.random() * legalMoves.length)];
    }

    recordMove(boardBeforeMove, action) {
        // Simpan transform yang dipakai saat canonicalisasi agar action bisa dikonversi konsisten
        // boardState tidak disimpan — tidak pernah dipakai dan hanya membuang memori (poin 8)
        // Poin 1 fix: gunakan getStateKey() agar stateKey di history SELALU identik
        // dengan key yang dipakai chooseMove() saat query database (termasuk suffix _nextPlayer)
        const { transform } = this._canonicalize(boardBeforeMove);
        const stateKey = this.getStateKey(boardBeforeMove); // ✅ konsisten dengan chooseMove
        this.history.push({
            stateKey,
            action,
            transform
        });
    }

    endGame(result) {
        // Temporal credit assignment:
        // Move paling akhir dapat weight 1.0, sebelumnya dikali discountFactor terus
        const n = this.history.length;
        const experience = this.history.map((entry, i) => {
            const weight = Math.pow(this.discountFactor, n - 1 - i);
            // Konversi action asli → canonical action menggunakan transform yang disimpan saat recordMove
            const canonicalAction = this._transformIndex(entry.transform, entry.action);
            return {
                stateKey: entry.stateKey,   // ✅ pakai stateKey yang sudah disimpan di history
                action:   canonicalAction,   // ✅ konsisten dengan canonical stateKey
                result,
                weight
            };
        });

        this.database.updateExperience(experience);
        this.history = [];
        this.gameCount++;
        this.gamesSinceLastDecay++;

        // Decay periodik setiap N game
        if (this.gamesSinceLastDecay >= this.decayInterval) {
            this.database._applyDecay();
            this.gamesSinceLastDecay = 0;
        }

        // Epsilon decay setelah tiap game
        this.epsilon = Math.max(
            this.epsilonMin,
            this.epsilon * this.epsilonDecay
        );
    }

    // Info debug
    getInfo() {
        return {
            gameCount:      this.gameCount,
            currentEpsilon: +this.epsilon.toFixed(4),
            dbInfo:         this.database.getInfo()
        };
    }

    resetEpsilon() {
        this.epsilon = this.epsilonStart;
    }

    // Reset penuh untuk melatih ulang dari awal:
    // hapus database + reset epsilon + reset gameCount secara otomatis
    retrain() {
        this.database.reset();
        this.resetEpsilon();
        this.gameCount = 0;
        this.history = [];
        console.log('[AI] Retrain initiated: database cleared, epsilon reset to', this.epsilonStart);
    }

    // Poin 4: self-play — AI bermain melawan dirinya sendiri sebanyak `games` kali
    // Digunakan untuk melatih AI secara mandiri tanpa perlu lawan manusia
    // opponent: instance AI lain (atau this sendiri dengan simbol berbeda)
    train(games = 1000, onProgress = null) {
        const lines = [
            [0,1,2],[3,4,5],[6,7,8],
            [0,3,6],[1,4,7],[2,5,8],
            [0,4,8],[2,4,6]
        ];

        const checkWinner = (board, sym) =>
            lines.some(([a,b,c]) => board[a] === sym && board[b] === sym && board[c] === sym);

        // Buat dua instance AI dengan simbol berbeda
        const aiX = new AI(this.database, {
            epsilonStart:  this.epsilon,
            epsilonMin:    this.epsilonMin,
            epsilonDecay:  this.epsilonDecay,
            discountFactor: this.discountFactor,
            decayInterval: this.decayInterval
        });
        aiX.setSymbol('X');

        const aiO = new AI(this.database, {
            epsilonStart:  this.epsilon,
            epsilonMin:    this.epsilonMin,
            epsilonDecay:  this.epsilonDecay,
            discountFactor: this.discountFactor,
            decayInterval: this.decayInterval
        });
        aiO.setSymbol('O');

        let wins = 0, losses = 0, draws = 0;

        for (let g = 0; g < games; g++) {
            const board = Array(9).fill('');
            let current = aiX; // X mulai duluan
            let other   = aiO;

            while (true) {
                const move = current.chooseMove(board);
                if (move === null) { draws++; aiX.endGame('draw'); aiO.endGame('draw'); break; }

                current.recordMove(board, move);
                board[move] = current.symbol;

                if (checkWinner(board, current.symbol)) {
                    // current menang
                    if (current === aiX) { wins++; aiX.endGame('win'); aiO.endGame('loss'); }
                    else                 { losses++; aiX.endGame('loss'); aiO.endGame('win'); }
                    break;
                }

                if (board.every(c => c !== '')) {
                    draws++; aiX.endGame('draw'); aiO.endGame('draw');
                    break;
                }

                // ganti giliran
                [current, other] = [other, current];
            }

            if (onProgress && (g + 1) % 100 === 0) {
                onProgress({ game: g + 1, total: games, wins, losses, draws });
            }
        }

        // Sync epsilon hasil latihan kembali ke instance ini
        this.epsilon     = Math.min(aiX.epsilon, aiO.epsilon);
        this.gameCount  += games;

        // Pastikan semua pengalaman tersimpan
        this.database.saveImmediate();

        console.log(`[AI] Self-play selesai: ${games} game | W:${wins} L:${losses} D:${draws}`);
        return { wins, losses, draws };
    }
}
