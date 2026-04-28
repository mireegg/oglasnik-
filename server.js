const fetch2 = require('node-fetch');
const axios = require('axios');
const bcrypt = require('bcrypt');
const SALT_ROUNDS = 10;
const express = require('express');
const nodemailer = require('nodemailer');
const https = require('https');
const { Pool } = require('pg');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));
app.use(express.json());
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function initDB() {
    await pool.query(`CREATE TABLE IF NOT EXISTS korisnici (id SERIAL PRIMARY KEY, ime VARCHAR(100), email VARCHAR(100) UNIQUE, lozinka VARCHAR(100), datum TIMESTAMP DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS prijave (id SERIAL PRIMARY KEY, ime VARCHAR(100), email VARCHAR(100), telefon VARCHAR(50), datum TIMESTAMP DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS pracenja (id SERIAL PRIMARY KEY, korisnik_email VARCHAR(100), pretraga VARCHAR(200), aktivno BOOLEAN DEFAULT true, datum TIMESTAMP DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS live_oglasi (id SERIAL PRIMARY KEY, naslov TEXT, cijena TEXT, slika TEXT, link TEXT UNIQUE, platforma VARCHAR(50) DEFAULT 'olx', kategorija VARCHAR(100), datum TIMESTAMP DEFAULT NOW())`);
    await pool.query(`ALTER TABLE pracenja ADD COLUMN IF NOT EXISTS link TEXT`);
    await pool.query(`ALTER TABLE pracenja ADD COLUMN IF NOT EXISTS slika TEXT`);
    await pool.query(`ALTER TABLE live_oglasi ADD COLUMN IF NOT EXISTS kategorija VARCHAR(100)`);
    await pool.query(`ALTER TABLE live_oglasi ADD COLUMN IF NOT EXISTS brand_id INTEGER`);
    // Kolone za praćenje prodanih oglasa i statistike
    await pool.query(`ALTER TABLE live_oglasi ADD COLUMN IF NOT EXISTS available BOOLEAN DEFAULT true`);
    await pool.query(`ALTER TABLE live_oglasi ADD COLUMN IF NOT EXISTS datum_nestanka TIMESTAMP`);
    await pool.query(`ALTER TABLE live_oglasi ADD COLUMN IF NOT EXISTS dana_do_prodaje INTEGER`);
    await pool.query(`ALTER TABLE live_oglasi ADD COLUMN IF NOT EXISTS cijena_num NUMERIC`);
    await pool.query(`ALTER TABLE live_oglasi ADD COLUMN IF NOT EXISTS godiste INTEGER`);
    await pool.query(`ALTER TABLE live_oglasi ADD COLUMN IF NOT EXISTS boja VARCHAR(50)`);
    await pool.query(`ALTER TABLE live_oglasi ADD COLUMN IF NOT EXISTS gorivo VARCHAR(50)`);
    await pool.query(`ALTER TABLE live_oglasi ADD COLUMN IF NOT EXISTS km INTEGER`);
    await pool.query(`ALTER TABLE live_oglasi ADD COLUMN IF NOT EXISTS grad VARCHAR(100)`);
    // Index za brže upite
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_live_oglasi_kategorija ON live_oglasi(kategorija)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_live_oglasi_available ON live_oglasi(available)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_live_oglasi_datum ON live_oglasi(datum)`);
    await pool.query(`ALTER TABLE korisnici ADD COLUMN IF NOT EXISTS plan VARCHAR(50) DEFAULT 'free'`);
    await pool.query(`ALTER TABLE korisnici ADD COLUMN IF NOT EXISTS plan_datum_isteka TIMESTAMP`);
    console.log('Baza inicijalizovana!');
}
initDB();

app.get('/', (req, res) => res.sendFile(__dirname + '/public/index.html'));

// ── AUTH ─────────────────────────────────────────────────
app.post('/prijava', async (req, res) => {
    const { ime, email, telefon } = req.body;
    await pool.query('INSERT INTO prijave (ime, email, telefon) VALUES ($1, $2, $3)', [ime, email, telefon]);
    transporter.sendMail({ from: process.env.EMAIL_USER, to: email, subject: 'Dobro dosli na Oglix!', html: `<h2>Zdravo ${ime}!</h2>` }).catch(() => {});
    res.json({ uspjeh: true });
});

app.post('/register', async (req, res) => {
    const { ime, email, lozinka } = req.body;
    if (!ime || !email || !lozinka) return res.json({ uspjeh: false, poruka: 'Sva polja su obavezna!' });
    if (lozinka.length < 6) return res.json({ uspjeh: false, poruka: 'Lozinka mora imati min. 6 karaktera!' });
    try {
        const hash = await bcrypt.hash(lozinka, SALT_ROUNDS);
        const result = await pool.query('INSERT INTO korisnici (ime, email, lozinka) VALUES ($1, $2, $3) RETURNING ime, email', [ime, email, hash]);
        transporter.sendMail({ from: process.env.EMAIL_USER, to: email, subject: 'Dobro došli na Oglix!', html: `<h2>Zdravo ${ime}!</h2><p>Vaš account je kreiran.</p>` }).catch(() => {});
        res.json({ uspjeh: true, korisnik: result.rows[0] });
    } catch (e) {
        res.json({ uspjeh: false, poruka: e.code === '23505' ? 'Email je već registrovan!' : 'Greška pri registraciji.' });
    }
});

app.post('/login', async (req, res) => {
    const { email, lozinka } = req.body;
    if (!email || !lozinka) return res.json({ uspjeh: false, poruka: 'Unesite email i lozinku!' });
    try {
        const result = await pool.query('SELECT * FROM korisnici WHERE email = $1', [email]);
        if (!result.rows.length) return res.json({ uspjeh: false, poruka: 'Pogrešan email ili lozinka!' });
        const ok = await bcrypt.compare(lozinka, result.rows[0].lozinka);
        if (ok) res.json({ uspjeh: true, korisnik: { ime: result.rows[0].ime, email: result.rows[0].email } });
        else res.json({ uspjeh: false, poruka: 'Pogrešan email ili lozinka!' });
    } catch (e) { res.json({ uspjeh: false, poruka: 'Greška pri prijavi.' }); }
});

// ── PRAĆENJA ─────────────────────────────────────────────
app.post('/pracenje', async (req, res) => {
    const { email, pretraga, link, slika } = req.body;
    await pool.query('INSERT INTO pracenja (korisnik_email, pretraga, link, slika) VALUES ($1, $2, $3, $4)', [email, pretraga, link || null, slika || null]);
    res.json({ uspjeh: true });
});
app.delete('/pracenje/:id', async (req, res) => {
    await pool.query('DELETE FROM pracenja WHERE id = $1', [req.params.id]);
    res.json({ uspjeh: true });
});
app.get('/moja-pracenja', async (req, res) => {
    const result = await pool.query('SELECT * FROM pracenja WHERE korisnik_email = $1 AND aktivno = true ORDER BY datum DESC', [req.query.email]);
    res.json(result.rows);
});

// ── AI ANALIZA LISTE ──────────────────────────────────────
app.post('/ai-analiza', async (req, res) => {
    const { oglasi, pretraga } = req.body;
    const prompt = `Ti si iskusan savjetnik za kupovinu u Bosni i Hercegovini.
Kupac traži: "${pretraga}"
Oglasi:
${oglasi.map((o, i) => `${i+1}. ${o.naslov} — ${o.cijenaStr}`).join('\n')}
Za svaki oglas daj kratku OCJENU i AI SCORE (0-100). Na kraju ZAKLJUCAK koji je najisplativiji.
Odgovaraj na bosanskom. Budi konkretan.`;
    const body = JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], max_tokens: 1500 });
    const options = {
        hostname: 'api.groq.com', path: '/openai/v1/chat/completions', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.GROQ_API_KEY, 'Content-Length': Buffer.byteLength(body) }
    };
    const apiReq = https.request(options, apiRes => {
        let data = '';
        apiRes.on('data', chunk => data += chunk);
        apiRes.on('end', () => {
            try { res.json({ uspjeh: true, analiza: JSON.parse(data).choices[0].message.content }); }
            catch(e) { res.json({ uspjeh: false, poruka: 'Greška pri analizi' }); }
        });
    });
    apiReq.on('error', e => res.json({ uspjeh: false, poruka: e.message }));
    apiReq.write(body); apiReq.end();
});

// ── HELPER FUNKCIJE ───────────────────────────────────────
function parseCijena(str) {
    if (!str) return 0;
    return parseFloat(str.toString().replace(/\./g,'').replace(',','.').replace(/[^0-9.]/g,'')) || 0;
}

async function dohvatiOlxDetalje(id) {
    const det = await axios.get(`https://olx.ba/api/listings/${id}`, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://www.olx.ba/' },
        timeout: 8000
    });
    const attrs = {};
    (det.data.attributes || []).forEach(a => { attrs[a.attr_code] = a.value; });
    return { data: det.data, attrs, images: det.data.images || [] };
}

async function groqAI(prompt, maxTokens = 500) {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens, temperature: 0.4 })
    });
    const data = await response.json();
    return data.choices?.[0]?.message?.content || null;
}

// ── OLX DETALJI OGLASA ────────────────────────────────────
app.get('/api/oglas-detalji/:id', async (req, res) => {
    try {
        const { data, attrs } = await dohvatiOlxDetalje(req.params.id);
        const categoryId = data.category_id;

        let kategorija_tip = 'ostalo';
        if ([31, 1495, 2076, 252].includes(categoryId)) kategorija_tip = 'mobiteli';
        else if ([38, 39].includes(categoryId)) kategorija_tip = 'racunari';
        else if ([23, 24, 25, 29].includes(categoryId)) kategorija_tip = 'nekretnine';
        else if (categoryId === 18) kategorija_tip = 'vozila';

        res.json({
            uspjeh: true,
            detalji: {
                id: data.id, naslov: data.title,
                category_id: categoryId, kategorija_tip,
                brand: data.brand?.name || '',
                model: data.model?.name || '',
                brand_id: data.brand?.id || null,
                model_id: data.model?.id || null,
                grad: data.cities?.[0]?.name || 'BiH',
                slike: data.images || [],
                // Vozila
                godiste: attrs['godiste'] || null,
                gorivo: attrs['gorivo'] || null,
                transmisija: attrs['transmisija'] || null,
                km: attrs['kilometra-a'] || null,
                kubikaza: attrs['kubikaza'] || null,
                kw: attrs['kilovata-kw'] || null,
                boja: attrs['boja'] || null,
                tip_vozila: attrs['tip'] || null,
                pogon: attrs['pogon'] || null,
                // Mobiteli
                os: attrs['os-operativni-sistem'] || null,
                interna_memorija: attrs['interna-memorija'] || null,
                ram_mob: attrs['ram'] || null,
                // Racunari
                procesor: attrs['procesor'] || null,
                ram_pc: attrs['ram'] || null,
                ssd: attrs['ssd-kapacitet-gb'] || null,
                graficka: attrs['grafi-ka-karta'] || null,
                os_pc: attrs['operativni-sistem'] || null,
                // Nekretnine
                broj_soba: attrs['broj-soba'] || null,
                kvadrata: attrs['kvadrata'] || null,
                sprat: attrs['sprat'] || null,
                namjesten: attrs['namjesten'] || null,
                grijanje: attrs['vrsta-grijanja'] || null,
                vrsta_nekretnine: attrs['vrsta-nekretnine'] || null,
            }
        });
    } catch(e) { res.json({ uspjeh: false, poruka: e.message }); }
});


// ── AUTOBUM DETALJI OGLASA ────────────────────────────────
app.get('/api/autobum-detalji/:id', async (req, res) => {
    try {
        const id = req.params.id;
        const response = await fetch2(`https://api.autobum.ba/api/v1/articles/${id}`, {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://autobum.ba/' }
        });
        const data = await response.json();
        const o = data.data || data;

        // Izvuci atribute
        const attrs = {};
        if (o.attributes) o.attributes.forEach(a => { attrs[a.name] = a.value; });
        if (o.fields) o.fields.forEach(f => { attrs[f.name] = f.value; });

        res.json({
            uspjeh: true,
            detalji: {
                id: o.id,
                naslov: o.title,
                kategorija_tip: 'vozila',
                brand: o.brand?.name || o.make || '',
                model: o.model?.name || o.model_name || '',
                brand_id: null,
                model_id: null,
                grad: o.city?.name || o.location || 'BiH',
                slike: o.images || (o.image ? [o.image] : []),
                // Vozila
                godiste: attrs['Godina'] || attrs['year'] || o.year || null,
                gorivo: attrs['Gorivo'] || attrs['fuel_type'] || o.fuel_type || null,
                transmisija: attrs['Mjenjač'] || attrs['transmission'] || o.transmission || null,
                km: attrs['Kilometraža'] || attrs['mileage'] || o.mileage || null,
                kubikaza: attrs['Zapremina motora'] || attrs['engine_displacement'] || o.engine_displacement || null,
                kw: attrs['Snaga motora'] || attrs['engine_power'] || o.engine_power || null,
                boja: attrs['Boja'] || attrs['color'] || o.color || null,
                tip_vozila: attrs['Tip vozila'] || o.body_type || null,
                pogon: attrs['Pogon'] || o.drive_type || null,
            }
        });
    } catch(e) {
        res.json({ uspjeh: false, poruka: e.message });
    }
});


// ── SLIČNI OGLASI PO NAZIVU (za Autobum i Facebook) ──────
// Pretražuje OLX po brand_id + keyword, koristi special_labels za detalje
app.post('/api/slicni-po-nazivu', async (req, res) => {
    try {
        const { naslov, cijena, brand_id, gorivo, godiste, km } = req.body;
        if (!naslov && !brand_id) return res.json({ uspjeh: false, grupa1: [], grupa2: [] });

        const cijenaNum = parseCijena(cijena);
        const cijenaOd = cijenaNum > 0 ? Math.round(cijenaNum * 0.55) : 0;
        const cijenaDo = cijenaNum > 0 ? Math.round(cijenaNum * 1.55) : 999999;

        // Izvuci kljucne rijeci iz naslova (prve 3 rijeci bez godina i brojeva)
        const kljucneRijeci = naslov
            .split(/\s+/)
            .filter(w => w.length > 2 && !/^\d+$/.test(w))
            .slice(0, 3)
            .join(' ');

        let searchUrl = `https://olx.ba/api/search?category_id=18&per_page=40`;
        if (brand_id) searchUrl += `&brand=${brand_id}&brands=${brand_id}`;
        if (cijenaOd > 0) searchUrl += `&price_from=${cijenaOd}&price_to=${cijenaDo}`;

        const searchRes = await axios.get(searchUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://www.olx.ba/' },
            timeout: 12000
        });

        const sviOglasi = searchRes.data.data || [];

        // Mapiraj oglase koristeći special_labels
        const mapirani = sviOglasi.map(o => {
            const labels = {};
            (o.special_labels || []).forEach(l => {
                labels[l.label] = l.value;
            });
            return {
                id: o.id,
                naslov: o.title,
                cijena: o.display_price || 'Na upit',
                cijena_num: parseCijena(o.display_price),
                slika: o.image || '',
                link: `https://www.olx.ba/artikal/${o.id}`,
                platforma: 'olx',
                godiste: labels['Godište'] ? parseInt(labels['Godište']) : null,
                gorivo: labels['Gorivo'] || null,
                km: labels['Kilometraža'] ? parseInt(String(labels['Kilometraža']).replace(/[^0-9]/g,'')) : null,
            };
        });

        // Filtriraj slicne — isti gorivo i godiste ±2
        const godNum = parseInt(godiste) || 0;
        let grupa1 = mapirani.filter(o => {
            if (gorivo && o.gorivo && o.gorivo.toLowerCase() !== gorivo.toLowerCase()) return false;
            if (godNum && o.godiste && Math.abs(o.godiste - godNum) > 2) return false;
            return true;
        }).slice(0, 6);

        // Ako nema dovoljno — uzmi sve
        if (grupa1.length < 2) {
            grupa1 = mapirani.slice(0, 6);
        }

        const g1ids = new Set(grupa1.map(o => o.id));
        const grupa2 = mapirani.filter(o => !g1ids.has(o.id)).slice(0, 4);

        // AI analiza
        let aiAnaliza = null;
        if (grupa1.length > 0) {
            const aiPrompt = `Ti si direktan savjetnik za kupovinu vozila u BiH.

OGLAS KOJI KUPAC GLEDA:
- Naziv: ${naslov}
- Cijena: ${cijena}
- Godište: ${godiste||'—'} | Gorivo: ${gorivo||'—'} | KM: ${km ? parseInt(km).toLocaleString()+' km' : '—'}

SLIČNI OGLASI SA OLX.BA:
${grupa1.map((o,i) => {
    const c = parseCijena(o.cijena);
    const odnos = c && cijenaNum ? (c < cijenaNum ? ` (−${Math.round((cijenaNum-c)/cijenaNum*100)}% jeftiniji)` : c > cijenaNum ? ` (+${Math.round((c-cijenaNum)/cijenaNum*100)}% skuplji)` : ' (ista cijena)') : '';
    return `Oglas #${i+1}: ${o.naslov}
  Cijena: ${o.cijena}${odnos}
  KM: ${o.km ? o.km.toLocaleString()+' km' : '—'} | Godište: ${o.godiste||'—'} | Gorivo: ${o.gorivo||'—'}`;
}).join('\n\n')}

Format odgovora:
ZAKLJUČAK: [3-4 rečenice — koja je prosječna cijena, koji oglas ima najmanje km, koliko je ovaj oglas jeftiniji/skuplji od prosjeka]
PREPORUKA: [Jedna direktna rečenica]
UPOZORENJE: [Samo ako ima konkretan razlog. Ako je sve OK preskoči.]

Bosanski. Direktno.`;
            aiAnaliza = await groqAI(aiPrompt, 500);
        }

        res.json({ uspjeh: true, grupa1, grupa2, preciznost: 'Isti brend, slična cijena', aiAnaliza });
    } catch(e) {
        console.log('Slicni po nazivu greška:', e.message);
        res.json({ uspjeh: false, grupa1: [], grupa2: [], poruka: e.message });
    }
});

// ── LIVE OGLASI ───────────────────────────────────────────
app.post('/api/sacuvaj-oglase', async (req, res) => {
    const { oglasi } = req.body;
    if (!oglasi || !oglasi.length) return res.json({ uspjeh: false });
    try {
        for (const o of oglasi) {
            await pool.query(
                `INSERT INTO live_oglasi (naslov, cijena, slika, link, platforma, kategorija) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (link) DO UPDATE SET kategorija = $6`,
                [o.naslov, o.cijena, o.slika, o.link, o.platforma, o.kategorija || null]
            );
        }
        // Provjeri alertе za nove oglase
        provjeriAlerte(oglasi).catch(() => {});
        res.json({ uspjeh: true, sacuvano: oglasi.length });
    } catch(e) { res.json({ uspjeh: false, poruka: e.message }); }
});

app.get('/api/live-oglasi', async (req, res) => {
    try {
        const { q, kategorija } = req.query;
        const offset = parseInt(req.query.offset) || 0;
        const limit = parseInt(req.query.limit) || 48;
        let uvjeti = [], params = [], i = 1;
        if (q) { uvjeti.push(`naslov ILIKE $${i++}`); params.push(`%${q}%`); }
        if (kategorija) {
            const kats = kategorija.split(',').map(k => k.trim());
            uvjeti.push(`kategorija IN (${kats.map(() => `$${i++}`).join(',')})`);
            params.push(...kats);
        }
        const platforma = req.query.platforma;
        if (platforma) {
            const plats = platforma.split(',').map(p => p.trim());
            uvjeti.push(`platforma IN (${plats.map(() => `$${i++}`).join(',')})`);
            params.push(...plats);
        }
        const where = uvjeti.length ? 'WHERE ' + uvjeti.join(' AND ') : '';
        const countResult = await pool.query(`SELECT COUNT(*) FROM live_oglasi ${where}`, params);
        const ukupno = parseInt(countResult.rows[0].count);
        params.push(limit, offset);
        const result = await pool.query(
            `SELECT * FROM live_oglasi ${where} ORDER BY datum DESC LIMIT $${i++} OFFSET $${i++}`,
            params
        );
        res.json({ uspjeh: true, oglasi: result.rows, ukupno, offset, limit });
    } catch(e) { res.json({ uspjeh: false, oglasi: [] }); }
});

app.get('/api/kategorije', async (req, res) => {
    try {
        const result = await pool.query(`SELECT kategorija, COUNT(*) as broj FROM live_oglasi WHERE kategorija IS NOT NULL GROUP BY kategorija ORDER BY broj DESC`);
        res.json({ uspjeh: true, kategorije: result.rows });
    } catch(e) { res.json({ uspjeh: false, kategorije: [] }); }
});

// ── AI ANALIZA JEDNOG OGLASA ──────────────────────────────
app.post('/api/analiza-jednog-oglasa', async (req, res) => {
    const { oglas, slicni } = req.body;
    const d = oglas.detalji || {};
    const katTip = d.kategorija_tip || 'ostalo';

    let prompt = '';
    if (katTip === 'vozila') {
        prompt = `Ti si iskusan savjetnik za kupovinu vozila u BiH.
Oglas: ${oglas.naslov} — ${oglas.cijenaStr}
Godište: ${d.godiste||'—'} | Gorivo: ${d.gorivo||'—'} | KM: ${d.km ? Number(d.km).toLocaleString()+' km' : '—'}
Kubikaža: ${d.kubikaza||'—'} | Snaga: ${d.kw ? d.kw+' kW' : '—'} | Transmisija: ${d.transmisija||'—'} | Boja: ${d.boja||'—'}
Daj analizu: OCJENA: [ODLIČNO/FER/PREVISOKO/IZBJEGAVAJ] CIJENA: [komentar] SAVJET: [preporuka] SCORE: [0-100]`;
    } else if (katTip === 'mobiteli') {
        prompt = `Ti si iskusan savjetnik za kupovinu mobitela u BiH.
Oglas: ${oglas.naslov} — ${oglas.cijenaStr}
OS: ${d.os||'—'} | Memorija: ${d.interna_memorija||'—'} | RAM: ${d.ram_mob||'—'}
Daj analizu: OCJENA: [ODLIČNO/FER/PREVISOKO/IZBJEGAVAJ] CIJENA: [je li fer za ovaj model] SAVJET: [preporuka i šta fizički provjeriti] SCORE: [0-100]`;
    } else if (katTip === 'racunari') {
        prompt = `Ti si iskusan savjetnik za kupovinu računara u BiH.
Oglas: ${oglas.naslov} — ${oglas.cijenaStr}
CPU: ${d.procesor||'—'} | RAM: ${d.ram_pc||'—'} | SSD: ${d.ssd ? d.ssd+'GB' : '—'} | GPU: ${d.graficka||'—'}
Daj analizu: OCJENA: [ODLIČNO/FER/PREVISOKO/IZBJEGAVAJ] CIJENA: [vrijednost komponenti] SAVJET: [preporuka i šta provjeriti] SCORE: [0-100]`;
    } else if (katTip === 'nekretnine') {
        const m2 = d.kvadrata && parseCijena(oglas.cijenaStr) ? Math.round(parseCijena(oglas.cijenaStr)/parseFloat(d.kvadrata)) : 0;
        prompt = `Ti si iskusan agent za nekretnine u BiH.
Oglas: ${oglas.naslov} — ${oglas.cijenaStr} ${m2 ? '('+m2+' KM/m²)' : ''}
Površina: ${d.kvadrata||'—'}m² | Sobe: ${d.broj_soba||'—'} | Sprat: ${d.sprat||'—'} | Namješteno: ${d.namjesten||'—'}
Daj analizu: OCJENA: [ODLIČNO/FER/PREVISOKO/IZBJEGAVAJ] CIJENA: [cijena/m² komentar] SAVJET: [preporuka i šta pravno provjeriti] SCORE: [0-100]`;
    } else {
        prompt = `Ti si iskusan savjetnik za kupovinu u BiH.
Oglas: ${oglas.naslov} — ${oglas.cijenaStr}
Daj analizu: OCJENA: [ODLIČNO/FER/PREVISOKO/IZBJEGAVAJ] CIJENA: [komentar] SAVJET: [preporuka] SCORE: [0-100]`;
    }

    try {
        const tekst = await groqAI(prompt, 350);
        const scoreMatch = (tekst||'').match(/SCORE:\s*(\d+)/);
        res.json({ uspjeh: true, analiza: tekst || 'Analiza nije dostupna.', score: scoreMatch ? parseInt(scoreMatch[1]) : 70 });
    } catch(e) { res.json({ uspjeh: false, analiza: 'Analiza nije dostupna.', score: 70 }); }
});

// ── STARI ENDPOINT (kompatibilnost) ───────────────────────
app.get('/api/slicni-oglasi', async (req, res) => res.json({ uspjeh: true, oglasi: [] }));

// ════════════════════════════════════════════════════════════
// ── GLAVNA LOGIKA: SLIČNI OGLASI — SVE KATEGORIJE ─────────
// POST /api/slicni-dvije-grupe
// ════════════════════════════════════════════════════════════
app.post('/api/slicni-dvije-grupe', async (req, res) => {
    try {
        const d = req.body; // sve detalje šalje frontend
        const kategorija_tip = d.kategorija_tip || 'ostalo';
        const olx_id = d.olx_id;
        const cijenaNum = parseCijena(d.cijena);

        let grupa1 = [], grupa2 = [], preciznost = '', aiAnaliza = null;

        // ════════════════════════════════════════════════════
        // VOZILA
        // ════════════════════════════════════════════════════
        if (kategorija_tip === 'vozila') {
            if (!d.brand_id || !d.model_id) return res.json({ uspjeh: false, grupa1: [], grupa2: [], poruka: 'Nema brand/model za vozilo' });

            const cijenaOd = cijenaNum > 0 ? Math.round(cijenaNum * 0.55) : 0;
            const cijenaDo = cijenaNum > 0 ? Math.round(cijenaNum * 1.55) : 999999;
            let searchUrl = `https://olx.ba/api/search?category_id=18&per_page=40&brand=${d.brand_id}&brands=${d.brand_id}&models=${d.model_id}`;
            if (cijenaOd > 0) searchUrl += `&price_from=${cijenaOd}&price_to=${cijenaDo}`;

            const searchRes = await axios.get(searchUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://www.olx.ba/' },
                timeout: 12000
            });

            const kandidati = (searchRes.data.data || []).filter(o => String(o.id) !== String(olx_id));
            const detaljPromises = kandidati.slice(0, 20).map(async (o) => {
                try {
                    const { attrs, images } = await dohvatiOlxDetalje(o.id);
                    return {
                        id: o.id, naslov: o.title,
                        cijena: o.display_price || 'Na upit',
                        cijena_num: parseCijena(o.display_price),
                        slika: o.image || images[0] || '',
                        link: `https://www.olx.ba/artikal/${o.id}`,
                        platforma: 'olx',
                        godiste: attrs['godiste'] ? parseInt(attrs['godiste']) : null,
                        gorivo: attrs['gorivo'] || null,
                        transmisija: attrs['transmisija'] || null,
                        km: attrs['kilometra-a'] ? parseInt(attrs['kilometra-a']) : null,
                        kubikaza: attrs['kubikaza'] ? parseFloat(attrs['kubikaza']) : null,
                        kw: attrs['kilovata-kw'] ? parseInt(attrs['kilovata-kw']) : null,
                        boja: attrs['boja'] || null,
                    };
                } catch(e) { return null; }
            });

            const svi = (await Promise.all(detaljPromises)).filter(Boolean);
            const godNum = parseInt(d.godiste) || 0;
            const kubNum = parseFloat(d.kubikaza) || 0;
            const kwNum = parseInt(d.kw) || 0;

            // Pokušaj 1: gorivo + kubikaza + kw + godiste±1 + boja
            grupa1 = svi.filter(o => {
                if (d.gorivo && o.gorivo && o.gorivo.toLowerCase() !== d.gorivo.toLowerCase()) return false;
                if (kubNum && o.kubikaza !== null && Math.abs(o.kubikaza - kubNum) > 0.1) return false;
                if (kwNum && o.kw !== null && Math.abs(o.kw - kwNum) > 5) return false;
                if (godNum && o.godiste !== null && Math.abs(o.godiste - godNum) > 1) return false;
                if (d.boja && o.boja && o.boja.toLowerCase() !== d.boja.toLowerCase()) return false;
                return true;
            });
            if (grupa1.length >= 2) preciznost = 'Isti motor, godište i boja';

            if (grupa1.length < 2) {
                grupa1 = svi.filter(o => {
                    if (d.gorivo && o.gorivo && o.gorivo.toLowerCase() !== d.gorivo.toLowerCase()) return false;
                    if (kubNum && o.kubikaza !== null && Math.abs(o.kubikaza - kubNum) > 0.1) return false;
                    if (kwNum && o.kw !== null && Math.abs(o.kw - kwNum) > 5) return false;
                    if (godNum && o.godiste !== null && Math.abs(o.godiste - godNum) > 1) return false;
                    return true;
                });
                if (grupa1.length >= 2) preciznost = 'Isti motor i godište';
            }
            if (grupa1.length < 2) {
                grupa1 = svi.filter(o => {
                    if (d.gorivo && o.gorivo && o.gorivo.toLowerCase() !== d.gorivo.toLowerCase()) return false;
                    if (kubNum && o.kubikaza !== null && Math.abs(o.kubikaza - kubNum) > 0.1) return false;
                    if (godNum && o.godiste !== null && Math.abs(o.godiste - godNum) > 2) return false;
                    return true;
                });
                if (grupa1.length >= 2) preciznost = 'Isti motor, godište ±2';
            }
            if (grupa1.length < 2) {
                grupa1 = svi.filter(o => {
                    if (d.gorivo && o.gorivo && o.gorivo.toLowerCase() !== d.gorivo.toLowerCase()) return false;
                    if (godNum && o.godiste !== null && Math.abs(o.godiste - godNum) > 3) return false;
                    return true;
                });
                preciznost = 'Isti model i gorivo';
            }

            grupa1 = grupa1.sort((a,b) => (a.km||999999)-(b.km||999999)).slice(0, 6);
            const g1ids = new Set(grupa1.map(o=>o.id));
            grupa2 = svi.filter(o => !g1ids.has(o.id) && (!d.gorivo || !o.gorivo || o.gorivo.toLowerCase()===d.gorivo.toLowerCase()))
                .sort((a,b) => (a.km||999999)-(b.km||999999)).slice(0, 4);

            // AI za vozila
            if (grupa1.length > 0) {
                const aiPrompt = `Ti si direktan savjetnik za kupovinu vozila u BiH.

OGLAS KOJI KUPAC GLEDA:
- Cijena: ${d.cijena} | Godište: ${d.godiste||'—'} | Gorivo: ${d.gorivo||'—'}
- Kubikaža: ${d.kubikaza ? d.kubikaza+'L' : '—'} | Snaga: ${d.kw ? d.kw+' kW' : '—'}
- Transmisija: ${d.transmisija||'—'} | Boja: ${d.boja||'—'} | KM: ${d.km ? parseInt(d.km).toLocaleString()+' km' : '—'}

IDENTIČNI OGLASI (${preciznost}):
${grupa1.map((o,i) => {
    const c = parseCijena(o.cijena);
    const odnos = c && cijenaNum ? (c < cijenaNum ? ` (−${Math.round((cijenaNum-c)/cijenaNum*100)}% jeftiniji)` : c > cijenaNum ? ` (+${Math.round((c-cijenaNum)/cijenaNum*100)}% skuplji)` : ' (ista cijena)') : '';
    return `Oglas #${i+1}: ${o.naslov}
  Cijena: ${o.cijena}${odnos}
  KM: ${o.km ? o.km.toLocaleString()+' km' : '—'} | Godište: ${o.godiste||'—'} | Boja: ${o.boja||'—'} | Transmisija: ${o.transmisija||'—'}`;
}).join('\n\n')}

Format odgovora:
ZAKLJUČAK: [3-4 rečenice sa konkretnim brojevima — koja je prosječna cijena, koji oglas ima najmanje km, koliko je ovaj oglas jeftiniji/skuplji od prosjeka]
PREPORUKA: [Jedna direktna rečenica — "Kupi oglas #X jer..." ili "Pregovaraj — tržišna vrijednost je X KM" ili "Dobar deal, kupi odmah"]
UPOZORENJE: [Samo ako ima konkretan razlog — previše km, previše skupo. Ako je sve OK preskoči.]

Bosanski. Direktno. Bez diplomatisanja.`;
                aiAnaliza = await groqAI(aiPrompt, 500);
            }
        }

        // ════════════════════════════════════════════════════
        // MOBITELI
        // ════════════════════════════════════════════════════
        else if (kategorija_tip === 'mobiteli') {
            if (!d.brand_id && !d.model_id) return res.json({ uspjeh: false, grupa1: [], grupa2: [], poruka: 'Nema brand/model za mobitel' });

            const cijenaOd = cijenaNum > 0 ? Math.round(cijenaNum * 0.60) : 0;
            const cijenaDo = cijenaNum > 0 ? Math.round(cijenaNum * 1.50) : 999999;

            let searchUrl = `https://olx.ba/api/search?category_id=31&per_page=40`;
            if (d.brand_id) searchUrl += `&brand=${d.brand_id}&brands=${d.brand_id}`;
            if (d.model_id) searchUrl += `&models=${d.model_id}`;
            if (cijenaOd > 0) searchUrl += `&price_from=${cijenaOd}&price_to=${cijenaDo}`;

            const searchRes = await axios.get(searchUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://www.olx.ba/' },
                timeout: 12000
            });

            const kandidati = (searchRes.data.data || []).filter(o => String(o.id) !== String(olx_id));
            const detaljPromises = kandidati.slice(0, 20).map(async (o) => {
                try {
                    const { attrs, images } = await dohvatiOlxDetalje(o.id);
                    return {
                        id: o.id, naslov: o.title,
                        cijena: o.display_price || 'Na upit',
                        cijena_num: parseCijena(o.display_price),
                        slika: o.image || images[0] || '',
                        link: `https://www.olx.ba/artikal/${o.id}`,
                        platforma: 'olx',
                        os: attrs['os-operativni-sistem'] || null,
                        interna_memorija: attrs['interna-memorija'] || null,
                        ram: attrs['ram'] || null,
                    };
                } catch(e) { return null; }
            });

            const svi = (await Promise.all(detaljPromises)).filter(Boolean);

            // Pokušaj 1: isti model + ista interna memorija
            if (d.model_id && d.interna_memorija) {
                grupa1 = svi.filter(o => o.interna_memorija === d.interna_memorija);
                if (grupa1.length >= 2) preciznost = 'Isti model i memorija';
            }
            // Pokušaj 2: isti model, različita memorija
            if (grupa1.length < 2) {
                grupa1 = svi.filter(o => true); // već filtrirani po modelu
                preciznost = 'Isti model';
            }

            grupa1 = grupa1.sort((a,b) => (a.cijena_num||999999)-(b.cijena_num||999999)).slice(0, 6);
            const g1ids = new Set(grupa1.map(o=>o.id));
            // Alternativa: isti brand, drugačiji model
            grupa2 = svi.filter(o => !g1ids.has(o.id)).slice(0, 4);

            // AI za mobitele
            if (grupa1.length > 0) {
                const aiPrompt = `Ti si iskusan savjetnik za kupovinu mobitela u BiH. Dobro poznaješ tržište i znaš procijeniti stanje uređaja.

MOBITEL KOJI KUPAC GLEDA:
- Naziv: ${d.brand} ${d.model}
- Cijena: ${d.cijena}
- OS: ${d.os||'—'} | Interna memorija: ${d.interna_memorija||'—'} | RAM: ${d.ram_mob||'—'}
- Stanje: Polovan

IDENTIČNI OGLASI NA TRŽIŠTU (${preciznost}):
${grupa1.map((o,i) => {
    const c = parseCijena(o.cijena);
    const odnos = c && cijenaNum ? (c < cijenaNum ? ` (−${Math.round((cijenaNum-c)/cijenaNum*100)}% jeftiniji)` : c > cijenaNum ? ` (+${Math.round((c-cijenaNum)/cijenaNum*100)}% skuplji)` : ' (ista cijena)') : '';
    return `Oglas #${i+1}: ${o.naslov}
  Cijena: ${o.cijena}${odnos}
  Memorija: ${o.interna_memorija||'—'} | RAM: ${o.ram||'—'}`;
}).join('\n\n')}

Napravi analizu u TAČNO ovom formatu:
ZAKLJUČAK: [3-4 rečenice. Koja je prosječna tržišna cijena ovog modela? Je li ova cijena fer? Koji oglas je najisplativiji?]
PREPORUKA: [Direktna preporuka — "Kupi oglas #X" ili "Ova cijena je realna, kupi odmah" ili "Pregovaraj do X KM"]
UPOZORENJE: [Šta provjeriti pri kupovini — baterija, ekran, oštećenja, originalni dijelovi, FaceID/TouchID. Uvijek napiši ovo za mobitele.]
SAVJET ZA PREGLED: [3 konkretne stvari koje kupac treba fizički provjeriti kod preuzimanja — npr. baterija %, tragovi pada, radi li kamera]

Bosanski. Direktno.`;
                aiAnaliza = await groqAI(aiPrompt, 600);
            }
        }

        // ════════════════════════════════════════════════════
        // RAČUNARI (Desktop i Laptop)
        // ════════════════════════════════════════════════════
        else if (kategorija_tip === 'racunari') {
            const categoryId = d.category_id || 38;
            const cijenaOd = cijenaNum > 0 ? Math.round(cijenaNum * 0.55) : 0;
            const cijenaDo = cijenaNum > 0 ? Math.round(cijenaNum * 1.55) : 999999;

            let searchUrl = `https://olx.ba/api/search?category_id=${categoryId}&per_page=40`;
            if (d.brand_id) searchUrl += `&brand=${d.brand_id}&brands=${d.brand_id}`;
            if (cijenaOd > 0) searchUrl += `&price_from=${cijenaOd}&price_to=${cijenaDo}`;

            const searchRes = await axios.get(searchUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://www.olx.ba/' },
                timeout: 12000
            });

            const kandidati = (searchRes.data.data || []).filter(o => String(o.id) !== String(olx_id));
            const detaljPromises = kandidati.slice(0, 20).map(async (o) => {
                try {
                    const { attrs, images } = await dohvatiOlxDetalje(o.id);
                    return {
                        id: o.id, naslov: o.title,
                        cijena: o.display_price || 'Na upit',
                        cijena_num: parseCijena(o.display_price),
                        slika: o.image || images[0] || '',
                        link: `https://www.olx.ba/artikal/${o.id}`,
                        platforma: 'olx',
                        procesor: attrs['procesor'] || null,
                        ram: attrs['ram'] || null,
                        ssd: attrs['ssd-kapacitet-gb'] || null,
                        graficka: attrs['grafi-ka-karta'] || null,
                        os_pc: attrs['operativni-sistem'] || null,
                    };
                } catch(e) { return null; }
            });

            const svi = (await Promise.all(detaljPromises)).filter(Boolean);

            // Pokušaj 1: isti procesor + isti RAM + ista grafička
            if (d.procesor && d.ram_pc && d.graficka) {
                grupa1 = svi.filter(o =>
                    o.procesor === d.procesor &&
                    o.ram === d.ram_pc &&
                    o.graficka === d.graficka
                );
                if (grupa1.length >= 2) preciznost = 'Isti procesor, RAM i grafička';
            }
            // Pokušaj 2: isti procesor + isti RAM
            if (grupa1.length < 2 && d.procesor && d.ram_pc) {
                grupa1 = svi.filter(o => o.procesor === d.procesor && o.ram === d.ram_pc);
                if (grupa1.length >= 2) preciznost = 'Isti procesor i RAM';
            }
            // Pokušaj 3: samo isti procesor
            if (grupa1.length < 2 && d.procesor) {
                grupa1 = svi.filter(o => o.procesor === d.procesor);
                if (grupa1.length >= 2) preciznost = 'Isti procesor';
            }
            // Pokušaj 4: slična cijena, ista kategorija
            if (grupa1.length < 2) {
                grupa1 = svi;
                preciznost = 'Slična kategorija i cijena';
            }

            grupa1 = grupa1.sort((a,b) => (a.cijena_num||999999)-(b.cijena_num||999999)).slice(0, 6);
            const g1ids = new Set(grupa1.map(o=>o.id));
            grupa2 = svi.filter(o => !g1ids.has(o.id)).slice(0, 4);

            // AI za računare
            if (grupa1.length > 0) {
                const aiPrompt = `Ti si iskusan savjetnik za kupovinu računara u BiH. Dobro razumiješ hardver i znaš realne cijene komponenti.

RAČUNAR KOJI KUPAC GLEDA:
- Naziv: ${d.naslov||'—'}
- Cijena: ${d.cijena}
- Procesor: ${d.procesor||'—'} | RAM: ${d.ram_pc||'—'} | SSD: ${d.ssd ? d.ssd+'GB' : '—'}
- Grafička: ${d.graficka||'—'} | OS: ${d.os_pc||'—'}

SLIČNI RAČUNARI NA TRŽIŠTU (${preciznost}):
${grupa1.map((o,i) => {
    const c = parseCijena(o.cijena);
    const odnos = c && cijenaNum ? (c < cijenaNum ? ` (−${Math.round((cijenaNum-c)/cijenaNum*100)}% jeftiniji)` : c > cijenaNum ? ` (+${Math.round((c-cijenaNum)/cijenaNum*100)}% skuplji)` : ' (ista cijena)') : '';
    return `Oglas #${i+1}: ${o.naslov}
  Cijena: ${o.cijena}${odnos}
  CPU: ${o.procesor||'—'} | RAM: ${o.ram||'—'} | SSD: ${o.ssd ? o.ssd+'GB' : '—'} | GPU: ${o.graficka||'—'}`;
}).join('\n\n')}

Napravi analizu u TAČNO ovom formatu:
ZAKLJUČAK: [3-4 rečenice. Koliko vrijede ove komponente na tržištu? Je li ova cijena fer za te specifikacije? Koji oglas nudi najviše za novac?]
PREPORUKA: [Direktna preporuka — "Kupi oglas #X — bolja grafička za istu cijenu" ili "Ova konfiguracija vrijedi X KM, pregovaraj" ili "Odličan deal, kupi odmah"]
UPOZORENJE: [Šta provjeriti — da li GPU radi stabilno, koliko je SSD iskorišten, stanje matične ploče, napajanje, garancija. Uvijek napiši ovo.]
PERFORMANSE: [Za šta je ovaj računar dobar — gaming na kojim settingsima, video editing, kancelarijski rad]

Bosanski. Direktno. Kao stručnjak za IT.`;
                aiAnaliza = await groqAI(aiPrompt, 600);
            }
        }

        // ════════════════════════════════════════════════════
        // NEKRETNINE
        // ════════════════════════════════════════════════════
        else if (kategorija_tip === 'nekretnine') {
            const categoryId = d.category_id || 23;
            const cijenaOd = cijenaNum > 0 ? Math.round(cijenaNum * 0.65) : 0;
            const cijenaDo = cijenaNum > 0 ? Math.round(cijenaNum * 1.40) : 999999;
            const kvadrati = parseFloat(d.kvadrata) || 0;

            let searchUrl = `https://olx.ba/api/search?category_id=${categoryId}&per_page=40`;
            if (cijenaOd > 0) searchUrl += `&price_from=${cijenaOd}&price_to=${cijenaDo}`;

            const searchRes = await axios.get(searchUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://www.olx.ba/' },
                timeout: 12000
            });

            const kandidati = (searchRes.data.data || []).filter(o => String(o.id) !== String(olx_id));
            const detaljPromises = kandidati.slice(0, 20).map(async (o) => {
                try {
                    const { data: oData, attrs, images } = await dohvatiOlxDetalje(o.id);
                    const kv = parseFloat(attrs['kvadrata']) || 0;
                    return {
                        id: o.id, naslov: o.title,
                        cijena: o.display_price || 'Na upit',
                        cijena_num: parseCijena(o.display_price),
                        slika: o.image || images[0] || '',
                        link: `https://www.olx.ba/artikal/${o.id}`,
                        platforma: 'olx',
                        kvadrata: kv || null,
                        broj_soba: attrs['broj-soba'] || null,
                        sprat: attrs['sprat'] || null,
                        namjesten: attrs['namjesten'] || null,
                        grijanje: attrs['vrsta-grijanja'] || null,
                        grad: oData.cities?.[0]?.name || null,
                        // Cijena po m2
                        cijena_m2: kv > 0 && parseCijena(o.display_price) > 0 ? Math.round(parseCijena(o.display_price) / kv) : null,
                    };
                } catch(e) { return null; }
            });

            const svi = (await Promise.all(detaljPromises)).filter(Boolean);
            const cijenaM2Trenutni = kvadrati > 0 && cijenaNum > 0 ? Math.round(cijenaNum / kvadrati) : 0;

            // Pokušaj 1: isti broj soba + kvadratura ±15m2 + isti grad
            if (d.broj_soba) {
                grupa1 = svi.filter(o => {
                    if (o.broj_soba !== d.broj_soba) return false;
                    if (kvadrati && o.kvadrata && Math.abs(o.kvadrata - kvadrati) > 15) return false;
                    if (d.grad && o.grad && !o.grad.toLowerCase().includes(d.grad.toLowerCase().split(' ')[0])) return false;
                    return true;
                });
                if (grupa1.length >= 2) preciznost = `Isti tip (${d.broj_soba}), slična kvadratura, isti grad`;
            }
            // Pokušaj 2: isti broj soba + isti grad, bez kvadrature
            if (grupa1.length < 2 && d.broj_soba) {
                grupa1 = svi.filter(o => o.broj_soba === d.broj_soba);
                if (grupa1.length >= 2) preciznost = `Isti tip stana (${d.broj_soba})`;
            }
            // Pokušaj 3: slična kvadratura ±20m2
            if (grupa1.length < 2 && kvadrati) {
                grupa1 = svi.filter(o => o.kvadrata && Math.abs(o.kvadrata - kvadrati) <= 20);
                preciznost = `Slična kvadratura (${kvadrati}m² ±20)`;
            }
            // Pokušaj 4: sve u cijenovnom rangu
            if (grupa1.length < 2) {
                grupa1 = svi;
                preciznost = 'Slična cijena, isti tip nekretnine';
            }

            // Sortiraj po cijeni/m2 (manja = bolja)
            grupa1 = grupa1.sort((a,b) => (a.cijena_m2||999999)-(b.cijena_m2||999999)).slice(0, 6);
            const g1ids = new Set(grupa1.map(o=>o.id));
            grupa2 = svi.filter(o => !g1ids.has(o.id)).slice(0, 4);

            // AI za nekretnine
            if (grupa1.length > 0) {
                const aiPrompt = `Ti si iskusan agent za nekretnine u BiH. Odlično poznaješ tržište i cijene po m².

NEKRETNINA KOJU KUPAC GLEDA:
- Naziv: ${d.naslov||'—'}
- Cijena: ${d.cijena} ${cijenaM2Trenutni > 0 ? `(${cijenaM2Trenutni} KM/m²)` : ''}
- Površina: ${d.kvadrata ? d.kvadrata+'m²' : '—'} | Sobe: ${d.broj_soba||'—'}
- Sprat: ${d.sprat||'—'} | Namješteno: ${d.namjesten||'—'} | Grijanje: ${d.grijanje||'—'}
- Grad: ${d.grad||'—'}

SLIČNE NEKRETNINE NA TRŽIŠTU (${preciznost}):
${grupa1.map((o,i) => {
    const c = parseCijena(o.cijena);
    const odnos = c && cijenaNum ? (c < cijenaNum ? ` (−${Math.round((cijenaNum-c)/cijenaNum*100)}% jeftinija)` : c > cijenaNum ? ` (+${Math.round((c-cijenaNum)/cijenaNum*100)}% skuplja)` : ' (ista cijena)') : '';
    return `Oglas #${i+1}: ${o.naslov}
  Cijena: ${o.cijena}${odnos} ${o.cijena_m2 ? `| ${o.cijena_m2} KM/m²` : ''}
  Površina: ${o.kvadrata ? o.kvadrata+'m²' : '—'} | Sobe: ${o.broj_soba||'—'} | Sprat: ${o.sprat||'—'} | Namješteno: ${o.namjesten||'—'}`;
}).join('\n\n')}

Napravi analizu u TAČNO ovom formatu:
ZAKLJUČAK: [3-4 rečenice. Koja je prosječna cijena po m² za ovaj tip nekretnine u ovom gradu? Je li ova cijena iznad ili ispod tržišne? Koji oglas nudi bolju vrijednost?]
PREPORUKA: [Direktna preporuka — "Kupi oglas #X — ${kvadrati > 0 ? 'X KM/m² jeftinije' : 'bolja lokacija/cijena'}" ili "Pregovaraj do X KM" ili "Fer cijena, kupi odmah"]
UPOZORENJE: [Šta provjeriti — uknjiženo/ZK, stanje instalacija, vlaga, susjedstvo, parking, troškovi režija, procjena vrijednosti od banke. Uvijek napiši ovo.]

Bosanski. Direktno. Kao iskusan agent.`;
                aiAnaliza = await groqAI(aiPrompt, 600);
            }
        }

        res.json({ uspjeh: true, grupa1, grupa2, preciznost, aiAnaliza });

    } catch(e) {
        console.log('Dvije grupe greška:', e.message);
        res.json({ uspjeh: false, grupa1: [], grupa2: [], poruka: e.message });
    }
});


// ── FIX KATEGORIJE PO BRAND_ID ────────────────────────────
// Koristi brand_id iz OLX API-ja — precizniji od keyword matchinga
app.get('/api/fix-kategorije-brand', async (req, res) => {
    const mapa = {
        7: 'vozila-audi',
        11: 'vozila-bmw',
        20: 'vozila-ford',
        29: 'vozila-fiat',
        30: 'vozila-honda',
        35: 'vozila-hyundai',
        39: 'vozila-kia',
        46: 'vozila-mazda',
        55: 'vozila-mazda',
        56: 'vozila-mercedes',
        64: 'vozila-mitsubishi',
        65: 'vozila-peugeot',
        69: 'vozila-porsche',
        71: 'vozila-renault',
        77: 'vozila-skoda',
        89: 'vozila-volkswagen',
        90: 'vozila-volvo',
        2: 'vozila-alfaromeo',
        4: 'vozila-chevrolet',
        9: 'vozila-citroen',
        15: 'vozila-dacia',
        22: 'vozila-jeep',
        33: 'vozila-landrover',
        36: 'vozila-mini',
        41: 'vozila-nissan',
        47: 'vozila-opel',
        57: 'vozila-seat',
        62: 'vozila-subaru',
        66: 'vozila-suzuki',
        72: 'vozila-toyota',
    };
    let ukupno = 0;
    for (const [brandId, kat] of Object.entries(mapa)) {
        const r = await pool.query(
            `UPDATE live_oglasi SET kategorija = $1 WHERE platforma = 'olx' AND kategorija = 'vozila' AND brand_id = $2`,
            [kat, parseInt(brandId)]
        );
        ukupno += r.rowCount;
        if (r.rowCount > 0) console.log(`brand_id ${brandId} -> ${kat}: ${r.rowCount}`);
    }
    res.json({ uspjeh: true, azurirano: ukupno });
});

// ── FIX KATEGORIJE ────────────────────────────────────────
app.get('/api/fix-kategorije', async (req, res) => {
    const brendovi = [
        { kljuc: ['volkswagen', 'vw ', ' vw', 'golf', 'passat', 'tiguan', 'polo', 'touareg', 'touran', 'sharan', 'caddy'], kat: 'vozila-volkswagen' },
        { kljuc: ['audi'], kat: 'vozila-audi' },
        { kljuc: ['mercedes', ' glc', ' gle', ' gla', ' glb', ' cls', ' amg', ' cla', ' slk', 'sprinter'], kat: 'vozila-mercedes' },
        { kljuc: ['bmw'], kat: 'vozila-bmw' },
        { kljuc: ['opel'], kat: 'vozila-opel' },
        { kljuc: ['peugeot'], kat: 'vozila-peugeot' },
        { kljuc: ['renault'], kat: 'vozila-renault' },
        { kljuc: ['toyota'], kat: 'vozila-toyota' },
        { kljuc: ['honda'], kat: 'vozila-honda' },
        { kljuc: ['ford'], kat: 'vozila-ford' },
        { kljuc: ['skoda', 'škoda'], kat: 'vozila-skoda' },
        { kljuc: ['seat'], kat: 'vozila-seat' },
        { kljuc: ['fiat'], kat: 'vozila-fiat' },
        { kljuc: ['citroen', 'citroën'], kat: 'vozila-citroen' },
        { kljuc: ['hyundai'], kat: 'vozila-hyundai' },
        { kljuc: ['kia'], kat: 'vozila-kia' },
        { kljuc: ['mazda'], kat: 'vozila-mazda' },
        { kljuc: ['nissan'], kat: 'vozila-nissan' },
        { kljuc: ['suzuki'], kat: 'vozila-suzuki' },
        { kljuc: ['volvo'], kat: 'vozila-volvo' },
        { kljuc: ['porsche'], kat: 'vozila-porsche' },
        { kljuc: ['land rover', 'landrover', 'range rover', 'defender', 'discovery'], kat: 'vozila-landrover' },
        { kljuc: ['jeep'], kat: 'vozila-jeep' },
        { kljuc: ['mitsubishi'], kat: 'vozila-mitsubishi' },
        { kljuc: ['subaru'], kat: 'vozila-subaru' },
        { kljuc: ['dacia'], kat: 'vozila-dacia' },
        { kljuc: ['alfa romeo', 'alfa-romeo'], kat: 'vozila-alfaromeo' },
        { kljuc: ['mini cooper', 'mini one', 'mini clubman', 'mini countryman'], kat: 'vozila-mini' },
        { kljuc: ['chevrolet'], kat: 'vozila-chevrolet' },
    ];
    let ukupno = 0;
    for (const b of brendovi) {
        const uvjet = b.kljuc.map(k => `LOWER(naslov) LIKE '%${k.toLowerCase()}%'`).join(' OR ');
        const r = await pool.query(`UPDATE live_oglasi SET kategorija = $1 WHERE platforma = 'olx' AND kategorija = 'vozila' AND (${uvjet})`, [b.kat]);
        ukupno += r.rowCount;
    }
    res.json({ uspjeh: true, azurirano: ukupno });
});

// ── OLX FETCH PO BRENDOVIMA ───────────────────────────────
const OLX_BRENDOVI = [
    7, 11, 20, 30, 39, 46, 56, 64, 65, 69, 71, 77, 89, 90,
    2, 3, 4, 5, 6, 8, 9, 10, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 24, 25,
    26, 27, 28, 29, 31, 32, 33, 34, 35, 36, 37, 38, 40, 41, 42, 43, 44, 45, 47,
    48, 49, 50, 51, 52, 53, 54, 55, 57, 58, 59, 60, 61, 62, 63, 66, 67, 68, 70,
    72, 73, 74, 75, 76, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 91, 92, 93
];

async function fetchBrend(brandId) {
    try {
        const prva = await axios.get(`https://olx.ba/api/search?category_id=18&per_page=40&page=1&brand=${brandId}&brands=${brandId}`, {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://www.olx.ba/' }, timeout: 15000
        });
        const lastPage = Math.min(prva.data.meta?.last_page || 1, 50);
        const sveStrane = [prva.data.data || []];
        for (let str = 2; str <= lastPage; str++) {
            try {
                const r = await axios.get(`https://olx.ba/api/search?category_id=18&per_page=40&page=${str}&brand=${brandId}&brands=${brandId}`, {
                    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://www.olx.ba/' }, timeout: 15000
                });
                sveStrane.push(r.data.data || []);
                await new Promise(r => setTimeout(r, 800));
            } catch(e) { if (e.response?.status === 429) await new Promise(r => setTimeout(r, 15000)); }
        }
        let sacuvano = 0;
        for (const stranica of sveStrane) {
            for (const o of stranica) {
                try {
                    const dbRes = await pool.query(
                        `INSERT INTO live_oglasi (naslov, cijena, slika, link, platforma, kategorija, brand_id) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (link) DO NOTHING`,
                        [o.title, o.display_price || 'Na upit', o.image || '', `https://www.olx.ba/artikal/${o.id}`, 'olx', 'vozila', o.brand_id || null]
                    );
                    if (dbRes.rowCount > 0) sacuvano++;
                } catch(e) {}
            }
        }
        if (sacuvano > 0) console.log(`Brend ${brandId}: ${sacuvano} novih oglasa`);
    } catch(e) { console.log(`Brend ${brandId} greška:`, e.message); }
}

async function fetchOLXKategorija(categoryId, kategorija) {
    try {
        const prvaStrana = await axios.get(`https://olx.ba/api/search?category_id=${categoryId}&per_page=40&page=1`, {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://www.olx.ba/' }, timeout: 15000
        });
        const lastPage = Math.min(prvaStrana.data.meta?.last_page || 1, 100);
        for (const o of (prvaStrana.data.data || [])) {
            try {
                await pool.query(`INSERT INTO live_oglasi (naslov, cijena, slika, link, platforma, kategorija) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (link) DO NOTHING`,
                    [o.title, o.display_price || 'Na upit', o.image || '', `https://www.olx.ba/artikal/${o.id}`, 'olx', kategorija]);
            } catch(e) {}
        }
        for (let stranica = 2; stranica <= lastPage; stranica++) {
            try {
                const response = await axios.get(`https://olx.ba/api/search?category_id=${categoryId}&per_page=40&page=${stranica}`, {
                    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://www.olx.ba/' }, timeout: 15000
                });
                const oglasi = response.data.data || [];
                if (!oglasi.length) break;
                for (const o of oglasi) {
                    try {
                        await pool.query(`INSERT INTO live_oglasi (naslov, cijena, slika, link, platforma, kategorija) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (link) DO NOTHING`,
                            [o.title, o.display_price || 'Na upit', o.image || '', `https://www.olx.ba/artikal/${o.id}`, 'olx', kategorija]);
                    } catch(e) {}
                }
                if (stranica % 50 === 0) console.log(`OLX: ${kategorija} stranica ${stranica}/${lastPage}`);
                await new Promise(r => setTimeout(r, 3000));
            } catch(e) {
                if (e.response?.status === 429) { await new Promise(r => setTimeout(r, 30000)); stranica--; }
            }
        }
        console.log(`OLX: ${kategorija} ZAVRŠENA`);
    } catch(e) { console.log(`OLX greška za ${kategorija}:`, e.message); }
}

async function autobumGet(page, katId) {
    const filters = encodeURIComponent('[{"field":"category_id","type":"eq","value":' + katId + '}]');
    const fields = encodeURIComponent('[]');
    const url = `https://api.autobum.ba/api/v1/articles?perPage=15&page=${page}&filters=${filters}&fieldsFilters=${fields}`;
    const response = await fetch2(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://autobum.ba/' } });
    return response.json();
}

async function fetchAutobum() {
    try {
        const prva = await autobumGet(1, 1);
        const sveStrane = [prva.data || []];
        let nextUrl = prva.links?.next;
        let page = 2;
        while (nextUrl && page <= 9999) {
            try {
                const r = await autobumGet(page, 1);
                sveStrane.push(r.data || []);
                nextUrl = r.links?.next;
                page++;
                await new Promise(r => setTimeout(r, 1000));
            } catch(e) { break; }
        }
        let sacuvano = 0;
        for (const stranica of sveStrane) {
            for (const o of stranica) {
                try {
                    const link = `https://autobum.ba/oglas/${o.id}`;
                    const dbRes = await pool.query(`INSERT INTO live_oglasi (naslov, cijena, slika, link, platforma, kategorija) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (link) DO NOTHING`,
                        [o.title, o.price || 'Na upit', o.image || '', link, 'autobum', 'vozila']);
                    if (dbRes.rowCount > 0) sacuvano++;
                } catch(e) {}
            }
        }
        console.log(`Autobum: vozila — ${sacuvano} novih oglasa`);
    } catch(e) { console.log('Autobum greška:', e.message); }
    console.log('Autobum fetch završen!');
}

// ── OLX FETCH SVIH VOZILA (bez filtera po brendu) ─────────
async function fetchSvaVozila() {
    console.log('OLX vozila: počinjem fetch svih 49k+ oglasa...');
    try {
        const prvaStrana = await axios.get('https://olx.ba/api/search?category_id=18&per_page=40&page=1', {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://www.olx.ba/' },
            timeout: 15000
        });
        const lastPage = Math.min(prvaStrana.data.meta?.last_page || 1, 500);
        console.log('OLX vozila: ukupno ' + (prvaStrana.data.meta?.total||0) + ' oglasa, ' + lastPage + ' stranica');

        let sacuvano = 0;
        for (const o of (prvaStrana.data.data || [])) {
            try {
                const dbRes = await pool.query(
                    'INSERT INTO live_oglasi (naslov, cijena, slika, link, platforma, kategorija, brand_id) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (link) DO NOTHING',
                    [o.title, o.display_price || 'Na upit', o.image || '', 'https://www.olx.ba/artikal/' + o.id, 'olx', 'vozila', o.brand_id || null]
                );
                if (dbRes.rowCount > 0) sacuvano++;
            } catch(e) {}
        }

        for (let stranica = 2; stranica <= lastPage; stranica++) {
            try {
                const response = await axios.get('https://olx.ba/api/search?category_id=18&per_page=40&page=' + stranica, {
                    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://www.olx.ba/' },
                    timeout: 15000
                });
                const oglasi = response.data.data || [];
                if (!oglasi.length) break;
                for (const o of oglasi) {
                    try {
                        const dbRes = await pool.query(
                            'INSERT INTO live_oglasi (naslov, cijena, slika, link, platforma, kategorija, brand_id) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (link) DO NOTHING',
                            [o.title, o.display_price || 'Na upit', o.image || '', 'https://www.olx.ba/artikal/' + o.id, 'olx', 'vozila', o.brand_id || null]
                        );
                        if (dbRes.rowCount > 0) sacuvano++;
                    } catch(e) {}
                }
                if (stranica % 50 === 0) console.log('OLX vozila: stranica ' + stranica + '/' + lastPage + ', novo: ' + sacuvano);
                await new Promise(r => setTimeout(r, 1500));
            } catch(e) {
                if (e.response?.status === 429) {
                    console.log('OLX rate limit, čekam 30s...');
                    await new Promise(r => setTimeout(r, 30000));
                    stranica--;
                }
            }
        }
        console.log('OLX vozila ZAVRŠENO. Ukupno novih: ' + sacuvano);
    } catch(e) { console.log('OLX vozila greška:', e.message); }
}


// ════════════════════════════════════════════════════════════
// ── EMAIL NOTIFIKACIJE ────────────────────────────────────
// ════════════════════════════════════════════════════════════

// HTML template za emailove
function emailTemplate(naslov, sadrzaj) {
    return `
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"></head>
    <body style="margin:0;padding:0;background:#f7f5f2;font-family:'Helvetica Neue',Arial,sans-serif;">
      <div style="max-width:580px;margin:0 auto;padding:32px 16px;">
        <div style="text-align:center;margin-bottom:24px;">
          <span style="font-size:24px;font-weight:800;color:#1a1a1a;">oglix<span style="color:#e65c00;">.ba</span></span>
        </div>
        <div style="background:white;border-radius:16px;padding:32px;border:1px solid rgba(0,0,0,0.08);">
          <h2 style="font-size:20px;font-weight:700;color:#1a1a1a;margin:0 0 16px 0;">${naslov}</h2>
          ${sadrzaj}
        </div>
        <p style="text-align:center;font-size:12px;color:#aaa;margin-top:20px;">
          oglix.ba · Agregator oglasa za BiH<br>
          <a href="https://oglasnik-production.up.railway.app/alerti.html" style="color:#e65c00;">Upravljaj alertima</a>
        </p>
      </div>
    </body>
    </html>`;
}

function posaljiEmail(to, subject, html) {
    return transporter.sendMail({
        from: `"Oglix.ba" <${process.env.EMAIL_USER}>`,
        to, subject, html
    }).catch(e => console.log('Email greška:', e.message));
}

// ── ALERT TABELA U BAZI ───────────────────────────────────
async function initAlerti() {
    await pool.query(`CREATE TABLE IF NOT EXISTS alerti (
        id SERIAL PRIMARY KEY,
        korisnik_email VARCHAR(100) NOT NULL,
        naziv VARCHAR(200),
        kljucna_rijec VARCHAR(200),
        kategorija VARCHAR(100),
        cijena_do NUMERIC,
        cijena_od NUMERIC,
        aktivan BOOLEAN DEFAULT true,
        zadnje_slanje TIMESTAMP,
        datum TIMESTAMP DEFAULT NOW()
    )`);
    await pool.query(`ALTER TABLE alerti ADD COLUMN IF NOT EXISTS naziv VARCHAR(200)`);
    // Tabela za praćenje cijena oglasa
    await pool.query(`CREATE TABLE IF NOT EXISTS pracenje_cijena (
        id SERIAL PRIMARY KEY,
        korisnik_email VARCHAR(100) NOT NULL,
        oglas_link TEXT NOT NULL,
        oglas_naslov TEXT,
        oglas_slika TEXT,
        cijena_pocetna NUMERIC,
        cijena_trenutna NUMERIC,
        platforma VARCHAR(50),
        aktivan BOOLEAN DEFAULT true,
        datum TIMESTAMP DEFAULT NOW(),
        UNIQUE(korisnik_email, oglas_link)
    )`);
    console.log('Alerti inicijalizovani!');
}
initAlerti();

// ── ALERT ENDPOINTI ───────────────────────────────────────

// Kreiraj novi alert
app.post('/api/alert', async (req, res) => {
    const { email, naziv, kljucna_rijec, kategorija, cijena_od, cijena_do } = req.body;
    if (!email || !kljucna_rijec) return res.json({ uspjeh: false, poruka: 'Email i ključna riječ su obavezni!' });
    try {
        const result = await pool.query(
            `INSERT INTO alerti (korisnik_email, naziv, kljucna_rijec, kategorija, cijena_od, cijena_do) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
            [email, naziv || kljucna_rijec, kljucna_rijec, kategorija || null, cijena_od || null, cijena_do || null]
        );
        // Potvrdan email
        posaljiEmail(email, '✅ Alert kreiran — Oglix.ba', emailTemplate(
            'Alert je aktiviran!',
            `<p style="color:#555;line-height:1.6;">Obavijestit ćemo te čim se pojavi oglas koji odgovara:</p>
            <div style="background:#f7f5f2;border-radius:10px;padding:16px;margin:16px 0;">
                <strong style="color:#1a1a1a;">${kljucna_rijec}</strong>
                ${kategorija ? `<br><span style="color:#777;font-size:13px;">Kategorija: ${kategorija}</span>` : ''}
                ${cijena_do ? `<br><span style="color:#777;font-size:13px;">Cijena do: ${parseInt(cijena_do).toLocaleString()} KM</span>` : ''}
                ${cijena_od ? `<br><span style="color:#777;font-size:13px;">Cijena od: ${parseInt(cijena_od).toLocaleString()} KM</span>` : ''}
            </div>
            <a href="https://oglasnik-production.up.railway.app" style="display:inline-block;background:#e65c00;color:white;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:600;">Pretraži oglase →</a>`
        ));
        res.json({ uspjeh: true, id: result.rows[0].id });
    } catch(e) { res.json({ uspjeh: false, poruka: e.message }); }
});

// Dohvati alerte korisnika
app.get('/api/alerti', async (req, res) => {
    const { email } = req.query;
    if (!email) return res.json({ uspjeh: false });
    const result = await pool.query(`SELECT * FROM alerti WHERE korisnik_email = $1 AND aktivan = true ORDER BY datum DESC`, [email]);
    res.json({ uspjeh: true, alerti: result.rows });
});

// Obriši alert
app.delete('/api/alert/:id', async (req, res) => {
    await pool.query(`UPDATE alerti SET aktivan = false WHERE id = $1`, [req.params.id]);
    res.json({ uspjeh: true });
});

// Prati oglas (cijena + nestanak)
app.post('/api/prati-oglas-cijenu', async (req, res) => {
    const { email, oglas_link, oglas_naslov, oglas_slika, cijena, platforma } = req.body;
    if (!email || !oglas_link) return res.json({ uspjeh: false });
    try {
        await pool.query(
            `INSERT INTO pracenje_cijena (korisnik_email, oglas_link, oglas_naslov, oglas_slika, cijena_pocetna, cijena_trenutna, platforma)
             VALUES ($1,$2,$3,$4,$5,$5,$6) ON CONFLICT (korisnik_email, oglas_link) DO NOTHING`,
            [email, oglas_link, oglas_naslov, oglas_slika, parseCijena(cijena), platforma || 'olx']
        );
        res.json({ uspjeh: true });
    } catch(e) { res.json({ uspjeh: false, poruka: e.message }); }
});

// Dohvati praćene oglase
app.get('/api/pracenje-cijena', async (req, res) => {
    const { email } = req.query;
    const result = await pool.query(`SELECT * FROM pracenje_cijena WHERE korisnik_email = $1 AND aktivan = true ORDER BY datum DESC`, [email]);
    res.json({ uspjeh: true, pracenja: result.rows });
});

// Obriši praćenje
app.delete('/api/prati-oglas-cijenu/:id', async (req, res) => {
    await pool.query(`UPDATE pracenje_cijena SET aktivan = false WHERE id = $1`, [req.params.id]);
    res.json({ uspjeh: true });
});

// ── PROVJERI ALERTЕ — pokreće se pri svakom fetchu ────────
async function provjeriAlerte(noviOglasi) {
    if (!noviOglasi || !noviOglasi.length) return;
    try {
        const alerti = await pool.query(`SELECT * FROM alerti WHERE aktivan = true`);
        if (!alerti.rows.length) return;

        for (const alert of alerti.rows) {
            // Ne šalji isti alert češće od jednom na sat
            if (alert.zadnje_slanje && (new Date() - new Date(alert.zadnje_slanje)) < 3600000) continue;

            const kljuc = alert.kljucna_rijec.toLowerCase();
            const podudarni = noviOglasi.filter(o => {
                if (!o.naslov.toLowerCase().includes(kljuc)) return false;
                if (alert.kategorija && o.kategorija && !o.kategorija.includes(alert.kategorija)) return false;
                const cijenaNum = parseCijena(o.cijena);
                if (alert.cijena_do && cijenaNum > 0 && cijenaNum > parseFloat(alert.cijena_do)) return false;
                if (alert.cijena_od && cijenaNum > 0 && cijenaNum < parseFloat(alert.cijena_od)) return false;
                return true;
            });

            if (podudarni.length === 0) continue;

            // Pošalji email
            const oglasHtml = podudarni.slice(0, 5).map(o => `
                <a href="${o.link}" style="display:block;text-decoration:none;color:inherit;border:1px solid rgba(0,0,0,0.08);border-radius:10px;padding:14px;margin-bottom:10px;">
                    <div style="display:flex;gap:12px;align-items:center;">
                        ${o.slika ? `<img src="${o.slika}" style="width:72px;height:54px;object-fit:cover;border-radius:6px;flex-shrink:0;">` : ''}
                        <div>
                            <div style="font-weight:600;color:#1a1a1a;font-size:14px;margin-bottom:4px;">${o.naslov.substring(0,80)}</div>
                            <div style="color:#e65c00;font-weight:700;font-size:16px;">${o.cijena}</div>
                            <div style="color:#aaa;font-size:12px;">${o.platforma.toUpperCase()} · ${o.kategorija || ''}</div>
                        </div>
                    </div>
                </a>`).join('');

            await posaljiEmail(
                alert.korisnik_email,
                `🔔 ${podudarni.length} novi oglas${podudarni.length > 1 ? 'a' : ''} za "${alert.naziv}" — Oglix.ba`,
                emailTemplate(
                    `Pronađeno ${podudarni.length} novih oglasa!`,
                    `<p style="color:#555;margin-bottom:16px;">Novi oglasi koji odgovaraju tvom alertu <strong>"${alert.naziv}"</strong>:</p>
                    ${oglasHtml}
                    <a href="https://oglasnik-production.up.railway.app/?q=${encodeURIComponent(alert.kljucna_rijec)}" style="display:inline-block;background:#e65c00;color:white;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:600;margin-top:8px;">Vidi sve oglase →</a>`
                )
            );

            await pool.query(`UPDATE alerti SET zadnje_slanje = NOW() WHERE id = $1`, [alert.id]);
            console.log(`Alert email poslan: ${alert.korisnik_email} — "${alert.naziv}" (${podudarni.length} oglasa)`);
        }
    } catch(e) { console.log('Greška provjere alertā:', e.message); }
}

// ── PROVJERI PAD CIJENA — svakih sat ─────────────────────
async function provjeriPadCijena() {
    try {
        const pracenja = await pool.query(`SELECT * FROM pracenje_cijena WHERE aktivan = true AND platforma = 'olx'`);
        if (!pracenja.rows.length) return;

        for (const p of pracenja.rows) {
            try {
                const olxId = p.oglas_link.split('/artikal/')[1];
                if (!olxId) continue;

                const res = await axios.get(`https://olx.ba/api/listings/${olxId}`, {
                    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
                    timeout: 5000
                });

                const novaCijena = parseCijena(res.data.display_price);
                const staraCijena = parseFloat(p.cijena_trenutna) || 0;

                // Oglas nestao
                if (res.data.available === false) {
                    await pool.query(`UPDATE pracenje_cijena SET aktivan = false WHERE id = $1`, [p.id]);
                    await posaljiEmail(
                        p.korisnik_email,
                        `❌ Oglas koji pratiš je prodan — Oglix.ba`,
                        emailTemplate(
                            'Oglas je prodan ili uklonjen',
                            `<p style="color:#555;margin-bottom:16px;">Oglas koji si pratio više nije dostupan:</p>
                            <div style="border:1px solid rgba(0,0,0,0.08);border-radius:10px;padding:14px;margin-bottom:16px;">
                                ${p.oglas_slika ? `<img src="${p.oglas_slika}" style="width:100%;height:160px;object-fit:cover;border-radius:6px;margin-bottom:10px;">` : ''}
                                <div style="font-weight:600;color:#1a1a1a;">${p.oglas_naslov}</div>
                                <div style="color:#aaa;font-size:13px;margin-top:4px;">Posljednja cijena: ${staraCijena > 0 ? staraCijena.toLocaleString() + ' KM' : 'Na upit'}</div>
                            </div>
                            <a href="https://oglasnik-production.up.railway.app" style="display:inline-block;background:#e65c00;color:white;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:600;">Traži slične oglase →</a>`
                        )
                    );
                    continue;
                }

                // Cijena pala
                if (novaCijena > 0 && staraCijena > 0 && novaCijena < staraCijena - 100) {
                    const razlika = Math.round(staraCijena - novaCijena);
                    const posto = Math.round(razlika / staraCijena * 100);
                    await pool.query(`UPDATE pracenje_cijena SET cijena_trenutna = $1 WHERE id = $2`, [novaCijena, p.id]);
                    await posaljiEmail(
                        p.korisnik_email,
                        `📉 Cijena pala za ${razlika} KM — Oglix.ba`,
                        emailTemplate(
                            `Cijena je snižena za ${razlika} KM (${posto}%)!`,
                            `<p style="color:#555;margin-bottom:16px;">Prodavač je snizio cijenu oglasa koji pratiš:</p>
                            <div style="border:1px solid rgba(0,0,0,0.08);border-radius:10px;padding:14px;margin-bottom:16px;">
                                ${p.oglas_slika ? `<img src="${p.oglas_slika}" style="width:100%;height:160px;object-fit:cover;border-radius:6px;margin-bottom:10px;">` : ''}
                                <div style="font-weight:600;color:#1a1a1a;margin-bottom:8px;">${p.oglas_naslov}</div>
                                <div style="display:flex;align-items:center;gap:12px;">
                                    <span style="color:#aaa;text-decoration:line-through;font-size:16px;">${staraCijena.toLocaleString()} KM</span>
                                    <span style="color:#e65c00;font-weight:800;font-size:22px;">→ ${novaCijena.toLocaleString()} KM</span>
                                </div>
                                <div style="background:#dcfce7;color:#16a34a;padding:6px 12px;border-radius:6px;font-weight:600;font-size:13px;display:inline-block;margin-top:8px;">Uštedjet ćeš ${razlika.toLocaleString()} KM (${posto}%)</div>
                            </div>
                            <a href="${p.oglas_link}" style="display:inline-block;background:#e65c00;color:white;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:600;">Pogledaj oglas →</a>`
                        )
                    );
                    console.log(`Pad cijene: ${p.oglas_naslov} — ${staraCijena} → ${novaCijena} KM`);
                } else if (novaCijena > 0 && novaCijena !== staraCijena) {
                    // Samo ažuriraj cijenu bez emaila
                    await pool.query(`UPDATE pracenje_cijena SET cijena_trenutna = $1 WHERE id = $2`, [novaCijena, p.id]);
                }

                await new Promise(r => setTimeout(r, 800));
            } catch(e) {
                if (e.response?.status === 404) {
                    await pool.query(`UPDATE pracenje_cijena SET aktivan = false WHERE id = $1`, [p.id]);
                }
            }
        }
    } catch(e) { console.log('Greška provjere cijena:', e.message); }
}

// Pokreni provjeru cijena svakih sat
setInterval(provjeriPadCijena, 60 * 60 * 1000);

// Tjedni digest — svaki ponedjeljak u 9:00
async function posaljiTjedniDigest() {
    try {
        const korisnici = await pool.query(`SELECT DISTINCT korisnik_email FROM alerti WHERE aktivan = true`);
        for (const k of korisnici.rows) {
            const alerti = await pool.query(`SELECT * FROM alerti WHERE korisnik_email = $1 AND aktivan = true`, [k.korisnik_email]);
            if (!alerti.rows.length) continue;

            // Za svaki alert nađi zadnjih 5 oglasa
            let sadrzaj = '';
            for (const alert of alerti.rows.slice(0, 3)) {
                const oglasi = await pool.query(
                    `SELECT * FROM live_oglasi WHERE naslov ILIKE $1 AND datum > NOW() - INTERVAL '7 days' ORDER BY datum DESC LIMIT 3`,
                    [`%${alert.kljucna_rijec}%`]
                );
                if (!oglasi.rows.length) continue;
                sadrzaj += `<h3 style="color:#1a1a1a;font-size:15px;margin:20px 0 10px 0;">🔔 ${alert.naziv}</h3>`;
                sadrzaj += oglasi.rows.map(o => `
                    <a href="${o.link}" style="display:block;text-decoration:none;color:inherit;border:1px solid rgba(0,0,0,0.08);border-radius:8px;padding:12px;margin-bottom:8px;">
                        <span style="font-weight:600;color:#1a1a1a;font-size:13px;">${o.naslov.substring(0,70)}</span>
                        <span style="color:#e65c00;font-weight:700;margin-left:8px;">${o.cijena}</span>
                    </a>`).join('');
            }

            if (!sadrzaj) continue;

            await posaljiEmail(
                k.korisnik_email,
                `📊 Tjedni pregled oglasa — Oglix.ba`,
                emailTemplate(
                    'Tvoj tjedni pregled',
                    `<p style="color:#555;margin-bottom:4px;">Evo šta se pojavilo u zadnjih 7 dana za tvoje alertе:</p>
                    ${sadrzaj}
                    <a href="https://oglasnik-production.up.railway.app" style="display:inline-block;background:#e65c00;color:white;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:600;margin-top:16px;">Vidi sve oglase →</a>`
                )
            );
        }
        console.log('Tjedni digest poslan!');
    } catch(e) { console.log('Digest greška:', e.message); }
}

// Provjeri svaki dan u 9:00 je li ponedjeljak
setInterval(() => {
    const now = new Date();
    if (now.getDay() === 1 && now.getHours() === 9 && now.getMinutes() < 5) {
        posaljiTjedniDigest();
    }
}, 5 * 60 * 1000);

async function fetchSveKategorije() {
    console.log('Pokrećem fetch...');
    await fetchSvaVozila();
    const ostale = [
        { id: '21', naziv: 'motocikli' }, { id: '22', naziv: 'bicikli' },
        { id: '426', naziv: 'nautika' }, { id: '2457', naziv: 'atv-quad' },
        { id: '23', naziv: 'nekretnine-stanovi' }, { id: '24', naziv: 'nekretnine-kuce' },
        { id: '29', naziv: 'nekretnine-zemljista' }, { id: '25', naziv: 'nekretnine-poslovni' },
        { id: '31', naziv: 'elektronika-mobiteli' }, { id: '1495', naziv: 'elektronika-tableti' },
        { id: '2076', naziv: 'elektronika-satovi' }, { id: '252', naziv: 'elektronika-dijelovi-mobiteli' },
        { id: '34', naziv: 'elektronika-bluetooth' }, { id: '38', naziv: 'elektronika-desktop' },
        { id: '39', naziv: 'elektronika-laptopi' }, { id: '42', naziv: 'elektronika-oprema' },
        { id: '75', naziv: 'elektronika-serveri' }, { id: '46', naziv: 'elektronika-bijela-tehnika' },
        { id: '45', naziv: 'elektronika-tv' }, { id: '2392', naziv: 'elektronika-zvucnici' },
        { id: '2129', naziv: 'elektronika-vr' }, { id: '225', naziv: 'masine-alati' },
    ];
    for (const kat of ostale) {
        await fetchOLXKategorija(kat.id, kat.naziv);
        await new Promise(r => setTimeout(r, 2000));
    }
    await fetchAutobum();
    console.log('Fetch završen!');
}

app.get('/api/run-autobum', async (req, res) => {
    res.json({ uspjeh: true, poruka: 'Autobum fetch pokrenut!' });
    fetchAutobum();
});
app.get('/api/test-autobum', async (req, res) => {
    try {
        const data = await autobumGet(1, 1);
        res.json({ uspjeh: true, keys: Object.keys(data), count: data.data?.length, oglas: data.data?.[0] });
    } catch(e) { res.json({ uspjeh: false, greska: e.message }); }
});


// ════════════════════════════════════════════════════════════
// ── PRAĆENJE PRODANIH OGLASA ──────────────────────────────
// ════════════════════════════════════════════════════════════

// Checkira koji oglasi su nestali (prodani) — pokreće se svakih sat
async function checkajProdaneOglase() {
    try {
        console.log('Checkam prodane oglase...');
        // Uzmi aktivne OLX oglase iz baze (samo olx jer imamo API)
        const aktivni = await pool.query(
            `SELECT id, link, datum FROM live_oglasi WHERE platforma = 'olx' AND available = true AND datum > NOW() - INTERVAL '90 days' LIMIT 500`
        );
        
        let prodano = 0;
        for (const oglas of aktivni.rows) {
            try {
                const olxId = oglas.link.split('/artikal/')[1];
                if (!olxId) continue;
                
                const res = await axios.get(`https://olx.ba/api/listings/${olxId}`, {
                    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
                    timeout: 5000
                });
                
                const available = res.data.available !== false;
                
                if (!available) {
                    const danaDo = Math.round((new Date() - new Date(oglas.datum)) / (1000 * 60 * 60 * 24));
                    await pool.query(
                        `UPDATE live_oglasi SET available = false, datum_nestanka = NOW(), dana_do_prodaje = $1 WHERE id = $2`,
                        [danaDo, oglas.id]
                    );
                    prodano++;
                }
                
                await new Promise(r => setTimeout(r, 500));
            } catch(e) {
                // 404 = oglas obrisan = prodano
                if (e.response?.status === 404) {
                    const danaDo = Math.round((new Date() - new Date(oglas.datum)) / (1000 * 60 * 60 * 24));
                    await pool.query(
                        `UPDATE live_oglasi SET available = false, datum_nestanka = NOW(), dana_do_prodaje = $1 WHERE id = $2`,
                        [danaDo, oglas.id]
                    );
                    prodano++;
                }
            }
        }
        console.log(`Prodani oglasi: ${prodano} novih prodaja detektovano`);
    } catch(e) {
        console.log('Greška checkanja prodanih:', e.message);
    }
}

// Pokreni checkanje svakih sat
setInterval(checkajProdaneOglase, 60 * 60 * 1000);

// ── STATISTIKE API ────────────────────────────────────────

// Glavni statistike endpoint
app.get('/api/statistike', async (req, res) => {
    try {
        const kategorija = req.query.kategorija || 'vozila';

        // 1. Ukupno oglasa i prodanih
        const ukupno = await pool.query(
            `SELECT COUNT(*) as ukupno, COUNT(CASE WHEN available = false THEN 1 END) as prodano FROM live_oglasi WHERE kategorija LIKE $1`,
            [kategorija + '%']
        );

        // 2. Prosječno dana do prodaje
        const prosjecno = await pool.query(
            `SELECT ROUND(AVG(dana_do_prodaje)) as prosjek, MIN(dana_do_prodaje) as min, MAX(dana_do_prodaje) as max FROM live_oglasi WHERE kategorija LIKE $1 AND dana_do_prodaje IS NOT NULL`,
            [kategorija + '%']
        );

        // 3. Prodaja po mjesecu
        const poBrojevu = await pool.query(
            `SELECT TO_CHAR(datum_nestanka, 'YYYY-MM') as mjesec, COUNT(*) as prodano FROM live_oglasi WHERE kategorija LIKE $1 AND datum_nestanka IS NOT NULL GROUP BY mjesec ORDER BY mjesec DESC LIMIT 12`,
            [kategorija + '%']
        );

        // 4. Najbrže prodane kategorije/brendovi
        const brendovi = await pool.query(
            `SELECT kategorija, ROUND(AVG(dana_do_prodaje)) as prosjek_dana, COUNT(*) as prodano FROM live_oglasi WHERE kategorija LIKE $1 AND dana_do_prodaje IS NOT NULL GROUP BY kategorija ORDER BY prosjek_dana ASC LIMIT 10`,
            [kategorija + '%']
        );

        // 5. Raspon cijena prodanih
        const cijene = await pool.query(
            `SELECT 
                ROUND(AVG(cijena_num)) as prosjek,
                MIN(cijena_num) as min,
                MAX(cijena_num) as max,
                PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY cijena_num) as medijana
            FROM live_oglasi WHERE kategorija LIKE $1 AND available = false AND cijena_num > 0`,
            [kategorija + '%']
        );

        res.json({
            uspjeh: true,
            ukupno: parseInt(ukupno.rows[0].ukupno),
            prodano: parseInt(ukupno.rows[0].prodano),
            prosjekDana: prosjecno.rows[0],
            poBrojevu: poBrojevu.rows,
            brendovi: brendovi.rows,
            cijene: cijene.rows[0]
        });
    } catch(e) {
        res.json({ uspjeh: false, poruka: e.message });
    }
});

// Statistike za vozila — detaljan breakdown
app.get('/api/statistike/vozila', async (req, res) => {
    try {
        // Najbrže po boji
        const boje = await pool.query(
            `SELECT boja, ROUND(AVG(dana_do_prodaje)) as prosjek_dana, COUNT(*) as prodano FROM live_oglasi WHERE kategorija LIKE 'vozila%' AND boja IS NOT NULL AND dana_do_prodaje IS NOT NULL GROUP BY boja ORDER BY prosjek_dana ASC LIMIT 10`
        );

        // Najbrže po gorivu
        const gorivo = await pool.query(
            `SELECT gorivo, ROUND(AVG(dana_do_prodaje)) as prosjek_dana, COUNT(*) as prodano FROM live_oglasi WHERE kategorija LIKE 'vozila%' AND gorivo IS NOT NULL AND dana_do_prodaje IS NOT NULL GROUP BY gorivo ORDER BY prosjek_dana ASC`
        );

        // Prodaja po godištu
        const godista = await pool.query(
            `SELECT godiste, COUNT(*) as prodano, ROUND(AVG(dana_do_prodaje)) as prosjek_dana FROM live_oglasi WHERE kategorija LIKE 'vozila%' AND godiste IS NOT NULL AND dana_do_prodaje IS NOT NULL GROUP BY godiste ORDER BY prodano DESC LIMIT 15`
        );

        // Najpopularniji brendovi
        const brendovi = await pool.query(
            `SELECT kategorija, COUNT(*) as ukupno, COUNT(CASE WHEN available = false THEN 1 END) as prodano, ROUND(AVG(CASE WHEN available = false THEN dana_do_prodaje END)) as prosjek_dana FROM live_oglasi WHERE kategorija LIKE 'vozila-%' GROUP BY kategorija ORDER BY prodano DESC LIMIT 15`
        );

        // Prosjek km prodanih vozila
        const kilometraza = await pool.query(
            `SELECT 
                CASE 
                    WHEN km < 50000 THEN '0-50k km'
                    WHEN km < 100000 THEN '50-100k km'
                    WHEN km < 150000 THEN '100-150k km'
                    WHEN km < 200000 THEN '150-200k km'
                    ELSE '200k+ km'
                END as rang,
                COUNT(*) as prodano,
                ROUND(AVG(dana_do_prodaje)) as prosjek_dana
            FROM live_oglasi WHERE kategorija LIKE 'vozila%' AND km IS NOT NULL AND dana_do_prodaje IS NOT NULL
            GROUP BY rang ORDER BY prosjek_dana ASC`
        );

        // Cijenovni rangovi
        const cijenovni = await pool.query(
            `SELECT 
                CASE 
                    WHEN cijena_num < 5000 THEN 'Do 5k KM'
                    WHEN cijena_num < 10000 THEN '5-10k KM'
                    WHEN cijena_num < 15000 THEN '10-15k KM'
                    WHEN cijena_num < 20000 THEN '15-20k KM'
                    WHEN cijena_num < 30000 THEN '20-30k KM'
                    ELSE '30k+ KM'
                END as rang,
                COUNT(*) as prodano,
                ROUND(AVG(dana_do_prodaje)) as prosjek_dana
            FROM live_oglasi WHERE kategorija LIKE 'vozila%' AND cijena_num > 0 AND dana_do_prodaje IS NOT NULL
            GROUP BY rang ORDER BY prosjek_dana ASC`
        );

        res.json({
            uspjeh: true,
            boje: boje.rows,
            gorivo: gorivo.rows,
            godista: godista.rows,
            brendovi: brendovi.rows,
            kilometraza: kilometraza.rows,
            cijenovni: cijenovni.rows
        });
    } catch(e) {
        res.json({ uspjeh: false, poruka: e.message });
    }
});

// Kalkulator tržišne vrijednosti
app.post('/api/kalkulator-vrijednosti', async (req, res) => {
    try {
        const { kategorija, brand_kategorija, godiste, km, gorivo, boja } = req.body;

        let uvjeti = [`kategorija = $1`, `available = false`, `cijena_num > 0`];
        let params = [brand_kategorija || kategorija];
        let i = 2;

        if (godiste) { uvjeti.push(`ABS(godiste - $${i++}) <= 2`); params.push(parseInt(godiste)); }
        if (gorivo) { uvjeti.push(`gorivo ILIKE $${i++}`); params.push(gorivo); }

        const result = await pool.query(
            `SELECT 
                COUNT(*) as uzorак,
                ROUND(AVG(cijena_num)) as prosjek,
                ROUND(MIN(cijena_num)) as min,
                ROUND(MAX(cijena_num)) as max,
                ROUND(PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY cijena_num)) as q1,
                ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY cijena_num)) as q3,
                ROUND(AVG(dana_do_prodaje)) as prosjek_dana
            FROM live_oglasi WHERE ${uvjeti.join(' AND ')}`,
            params
        );

        const r = result.rows[0];
        res.json({
            uspjeh: true,
            uzorak: parseInt(r.uzorak),
            prosjek: parseInt(r.prosjek) || 0,
            min: parseInt(r.min) || 0,
            max: parseInt(r.max) || 0,
            preporucenaOd: parseInt(r.q1) || 0,
            preporucenaDo: parseInt(r.q3) || 0,
            prosjekDana: parseInt(r.prosjek_dana) || 0
        });
    } catch(e) {
        res.json({ uspjeh: false, poruka: e.message });
    }
});

// Ručno pokretanje checkanja
app.get('/api/check-prodane', async (req, res) => {
    res.json({ uspjeh: true, poruka: 'Checkanje prodanih pokrenuto!' });
    checkajProdaneOglase();
});


// ── OGLIX BIZNIS PRIJAVA ──────────────────────────────────
app.post('/api/biznis-prijava', async (req, res) => {
    const { ime, firma, email, telefon, plan, poruka } = req.body;
    if (!ime || !email || !telefon) return res.json({ uspjeh: false });
    try {
        // Sacuvaj u bazu
        await pool.query(`CREATE TABLE IF NOT EXISTS biznis_prijave (id SERIAL PRIMARY KEY, ime VARCHAR(100), firma VARCHAR(100), email VARCHAR(100), telefon VARCHAR(50), plan VARCHAR(100), poruka TEXT, datum TIMESTAMP DEFAULT NOW())`);
        await pool.query(`INSERT INTO biznis_prijave (ime, firma, email, telefon, plan, poruka) VALUES ($1,$2,$3,$4,$5,$6)`, [ime, firma||null, email, telefon, plan||null, poruka||null]);

        // Email tebi (obavijest o novoj prijavi)
        transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: process.env.EMAIL_USER,
            subject: `🎯 Nova Oglix Biznis prijava — ${ime}`,
            html: `<h2>Nova prijava za Oglix Biznis!</h2>
                <p><strong>Ime:</strong> ${ime}</p>
                <p><strong>Firma:</strong> ${firma || '—'}</p>
                <p><strong>Email:</strong> ${email}</p>
                <p><strong>Telefon:</strong> ${telefon}</p>
                <p><strong>Plan:</strong> ${plan || '—'}</p>
                <p><strong>Poruka:</strong> ${poruka || '—'}</p>`
        }).catch(() => {});

        // Email njima (potvrda)
        transporter.sendMail({
            from: `"Oglix Biznis" <${process.env.EMAIL_USER}>`,
            to: email,
            subject: '✅ Primili smo vašu prijavu — Oglix Biznis',
            html: `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f7f5f2;padding:32px;">
                <div style="max-width:520px;margin:0 auto;background:white;border-radius:16px;padding:32px;">
                    <h2 style="font-family:sans-serif;color:#1a1a1a;">Zdravo ${ime}! 👋</h2>
                    <p style="color:#555;line-height:1.6;">Hvala što ste se prijavili za <strong>Oglix Biznis</strong>.</p>
                    <p style="color:#555;line-height:1.6;">Kontaktiramo vas u roku od <strong>24 sata</strong> na email ili telefon koji ste naveli.</p>
                    <div style="background:#f7f5f2;border-radius:10px;padding:16px;margin:20px 0;">
                        <p style="margin:0;color:#777;font-size:13px;">Plan koji ste odabrali: <strong>${plan || 'Pro'}</strong></p>
                    </div>
                    <p style="color:#555;font-size:14px;">U međuvremenu, možete istraživati oglase na <a href="https://oglasnik-production.up.railway.app" style="color:#e65c00;">oglix.ba</a>.</p>
                    <p style="color:#aaa;font-size:12px;margin-top:24px;">oglix.ba Biznis · Tržišna inteligencija za BiH</p>
                </div></body></html>`
        }).catch(() => {});

        res.json({ uspjeh: true });
    } catch(e) { res.json({ uspjeh: false, poruka: e.message }); }
});


// ── PLAN KORISNIKA ────────────────────────────────────────
app.get('/api/moj-plan', async (req, res) => {
    const { email } = req.query;
    if (!email) return res.json({ uspjeh: false });
    try {
        const r = await pool.query('SELECT plan, plan_datum_isteka FROM korisnici WHERE email = $1', [email]);
        if (!r.rows.length) return res.json({ uspjeh: false });
        res.json({ uspjeh: true, plan: r.rows[0].plan || 'free', datum_isteka: r.rows[0].plan_datum_isteka });
    } catch(e) { res.json({ uspjeh: false }); }
});

// Admin endpoint za promjenu plana (zaštićen tajnim ključem)
app.post('/api/admin/promijeni-plan', async (req, res) => {
    const { email, plan, mjeseci, tajni_kljuc } = req.body;
    if (tajni_kljuc !== process.env.ADMIN_KEY) return res.status(403).json({ uspjeh: false, poruka: 'Nedozvoljen pristup!' });
    try {
        const datumIsteka = mjeseci ? new Date(Date.now() + mjeseci * 30 * 24 * 60 * 60 * 1000) : null;
        await pool.query(
            'UPDATE korisnici SET plan = $1, plan_datum_isteka = $2 WHERE email = $3',
            [plan, datumIsteka, email]
        );
        res.json({ uspjeh: true, poruka: `Plan za ${email} promijenjen u ${plan}` });
    } catch(e) { res.json({ uspjeh: false, poruka: e.message }); }
});

fetchSveKategorije();
setInterval(fetchSveKategorije, 2 * 60 * 60 * 1000);

app.listen(PORT, () => console.log(`Server radi na portu ${PORT}`));